'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Pencil,
  Trash2,
  ImageOff,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
import TypeBadge, { ModelType } from '../../../components/TypeBadge';
import {
  CLIENT_FILTER_EVENT,
  getStoredClientId,
} from '../../../components/ClientSwitcher';
import { crmPath, crmFetch } from '../../../lib/client-fetch';
import { ProjectStatus } from '../../../lib/supabase';
import {
  useTableSort,
  SortableTh,
  statusRank,
} from '../../../lib/use-table-sort';
import {
  categoryLabel,
  complexityLabel,
  complexityRank,
} from '../../../lib/job-options';

// ============================================================
// Types
// ============================================================
type Project = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  // Classification, both nullable — jobs created before the
  // 2026-08-09 migration have neither and render as an em dash.
  complexity: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  // Reference images attached at job creation. Rendered as a
  // thumbnail strip in the Reference column.
  references?: ProjectReference[];
  // Where this job sits in the hierarchy.
  model_type?: ModelType | null;
  parent_id?: string | null;
  parent_name?: string | null;
};

type ProjectReference = {
  id: string;
  image_url: string;
};

// Colour for a child row's name and elbow in the grouped view.
// Matches the Overview's CHILD_TEXT: a deliberate indigo, kept
// out of the status palette so it can only ever mean "derived
// from the row above" rather than a stage.
const CHILD_TEXT = '#4c51bf';

// ============================================================
// ListJobsPage
//
// Flat index of every job (all statuses) with a dedicated Edit
// column. Three conveniences layered on top of the raw list:
//
//   1. Brand filter — honours the sidebar's ClientSwitcher the
//      same way the Overview dashboard does, so picking a client
//      narrows this list too. (When "All clients" is selected,
//      every job shows.)
//   2. Search — a free-text box filtering on name + slug, since a
//      flat all-status list can get long.
//   3. Edit — a per-row pencil button linking to /admin/[id]/edit.
//      Available on every row regardless of status, because a
//      rename is a harmless label change (the PATCH endpoint
//      leaves slug + pipeline state untouched).
//
// This page intentionally has NO tab bar and NO row actions
// beyond Edit — it's a management index, not the workflow
// dashboard. Assignment / review / reassignment all stay on the
// Overview + their dedicated pages.
// ============================================================
export default function ListJobsPage({
  initialProjects,
  currentUser,
}: {
  initialProjects: Project[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [query, setQuery] = useState('');
  // Flat list vs grouped under each parent. A VIEW, not a filter:
  // switching to 'parent' re-orders and indents but never hides a
  // job, so the row count is the same either way.
  const [grouping, setGrouping] = useState<'all' | 'parent'>('all');

  // Hard-delete (purge) state. `confirmTarget` is the row pending
  // confirmation; `deletingId` disables the dialog while the
  // request is in flight; `delError` surfaces a failure inline.
  const [confirmTarget, setConfirmTarget] = useState<Project | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  // Reference lightbox. Holds the clicked job's images plus the
  // index currently shown, so the arrows can step through that
  // job's references without leaving the table.
  const [lightbox, setLightbox] = useState<{
    refs: ProjectReference[];
    index: number;
    label: string;
  } | null>(null);

  // Keyboard nav for the lightbox: Esc closes, arrows step.
  useEffect(() => {
    if (!lightbox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightbox(null);
      else if (e.key === 'ArrowLeft') {
        setLightbox((l) =>
          l ? { ...l, index: (l.index - 1 + l.refs.length) % l.refs.length } : l
        );
      } else if (e.key === 'ArrowRight') {
        setLightbox((l) =>
          l ? { ...l, index: (l.index + 1) % l.refs.length } : l
        );
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Which products have their colourways expanded.
  // ---- removed 2026-08-29: colourways are their own jobs now,
  // so every row is top-level and there is nothing to expand. ----

  // Calls the shared hard-delete endpoint, which wipes the job
  // from the DB and R2. On success we drop the row locally so the
  // table updates without a full reload.
  async function handlePurge(p: Project) {
    setDeletingId(p.id);
    setDelError(null);
    try {
      const res = await crmFetch(`/api/projects/${p.id}/purge`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDelError(data?.error || 'Delete failed.');
        return;
      }
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
      setConfirmTarget(null);
    } catch (err) {
      setDelError((err as Error).message || 'Network error.');
    } finally {
      setDeletingId(null);
    }
  }

  // ---- Brand filter, synced with the sidebar ClientSwitcher.
  // Same wiring as AdminDashboard: read on mount, then listen for
  // the custom event + the native storage event (cross-tab).
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedClientId(getStoredClientId());
    function onChange() {
      setSelectedClientId(getStoredClientId());
    }
    window.addEventListener(CLIENT_FILTER_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CLIENT_FILTER_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (selectedClientId && p.client_id !== selectedClientId) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        // Match the visible label, not the stored value, so typing
        // "office chair" finds jobs stored as `office_chair`.
        categoryLabel(p.category).toLowerCase().includes(q)
      );
    });
  }, [projects, selectedClientId, query]);

  // Column accessors for sorting. Created/Updated sort
  // chronologically (Date), Status sorts by pipeline rank, the
  // rest are plain strings sorted A-Z (case-insensitive).
  const { sorted, sort, onSort } = useTableSort(visible, {
    name: (p) => p.name,
    artist: (p) => p.assignee?.name ?? null,
    created: (p) => new Date(p.created_at),
    // Sorts on the same value the cell renders.
    updated: (p) => new Date(p.updated_at),
    status: (p) => statusRank(p.status),
    // Groups parents together and children together.
    type: (p) => p.model_type ?? 'parent',
    // Sort by how many references a job has, so jobs briefed
    // without any imagery can be surfaced in one click.
    references: (p) => p.references?.length ?? 0,
    // Category sorts A-Z on the LABEL, so "Office Chair" lands
    // under O rather than under its stored `office_chair`.
    category: (p) => (p.category ? categoryLabel(p.category) : null),
    // Complexity sorts by effort band (easy -> complex), not
    // alphabetically. Unclassified rows sink to the bottom.
    complexity: (p) => complexityRank(p.complexity),
  });

  // ------------------------------------------------------------
  // Display rows
  // ------------------------------------------------------------
  // Same arrangement as the Overview. In 'parent' mode children
  // move under the model they came from; a child whose parent is
  // filtered out (by the search box or the brand switcher) still
  // appears, under a header naming the absent parent, so the
  // table never quietly drops a row the count promised.
  type DisplayRow =
    | { kind: 'job'; p: Project; indented: boolean }
    | { kind: 'group'; label: string };

  const displayRows: DisplayRow[] = useMemo(() => {
    if (grouping !== 'parent') {
      return sorted.map((p) => ({ kind: 'job' as const, p, indented: false }));
    }

    const childrenOf = new Map<string, Project[]>();
    const topLevel: Project[] = [];
    for (const p of sorted) {
      if (p.model_type === 'child' && p.parent_id) {
        const list = childrenOf.get(p.parent_id);
        if (list) list.push(p);
        else childrenOf.set(p.parent_id, [p]);
      } else {
        topLevel.push(p);
      }
    }

    const rows: DisplayRow[] = [];
    const placed = new Set<string>();
    for (const parent of topLevel) {
      rows.push({ kind: 'job', p: parent, indented: false });
      for (const child of childrenOf.get(parent.id) ?? []) {
        rows.push({ kind: 'job', p: child, indented: true });
      }
      placed.add(parent.id);
    }

    // Parent name comes from the UNFILTERED list — the whole point
    // is that it isn't in `sorted`.
    const lookup = new Map(projects.map((p) => [p.id, p.name] as const));
    for (const [parentId, kids] of childrenOf) {
      if (placed.has(parentId)) continue;
      const name = lookup.get(parentId);
      rows.push({
        kind: 'group',
        label: name ? `${name} — not in this list` : 'Parent removed',
      });
      for (const child of kids) {
        rows.push({ kind: 'job', p: child, indented: true });
      }
    }

    return rows;
  }, [sorted, grouping, projects]);

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">List Jobs</h1>
              <p className="crm-page-sub">
                Every job across all statuses. Reference thumbnails
                enlarge on click. Use the Edit column to rename a job
                or update its brief.
              </p>
            </div>
          </header>

          {/* Search box. Filters the in-memory list on name + slug.
              Kept lightweight (no debounce needed — the list is
              small and filtering is synchronous). */}
          <div style={{ marginBottom: 16, maxWidth: 360 }}>
            <input
              className="crm-input"
              type="search"
              placeholder="Search by name, slug or category…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {/* Grouping switch. Sits between the search box and the
              table because it re-arranges whatever the search
              left behind. */}
          {visible.length > 0 && (
            <div className="crm-tabs" role="tablist" aria-label="Grouping">
              <button
                role="tab"
                aria-selected={grouping === 'all'}
                className={`crm-tab ${grouping === 'all' ? 'is-active' : ''}`}
                onClick={() => setGrouping('all')}
                title="One row per job, in sort order"
              >
                All
                <span className="crm-tab-count">{visible.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={grouping === 'parent'}
                className={`crm-tab ${
                  grouping === 'parent' ? 'is-active' : ''
                }`}
                onClick={() => setGrouping('parent')}
                title="Group each child under the model it was derived from"
              >
                Parent
                <span className="crm-tab-count">
                  {
                    new Set(
                      visible.map((p) =>
                        p.model_type === 'child' && p.parent_id
                          ? p.parent_id
                          : p.id
                      )
                    ).size
                  }
                </span>
              </button>
            </div>
          )}

          {visible.length === 0 ? (
            <EmptyMini
              message={
                query.trim()
                  ? `No jobs match “${query.trim()}”.`
                  : 'No jobs to show.'
              }
            />
          ) : (
            <table className="crm-table">
              <thead>
                <tr>
                  <SortableTh label="Project" sortKey="name" sort={sort} onSort={onSort} />
                  <SortableTh label="Type" sortKey="type" sort={sort} onSort={onSort} />
                  <SortableTh
                    label="Reference"
                    sortKey="references"
                    sort={sort}
                    onSort={onSort}
                    align="center"
                    style={{ width: 90 }}
                  />
                  <SortableTh
                    label="Category"
                    sortKey="category"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortableTh
                    label="Complexity"
                    sortKey="complexity"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortableTh label="Artist" sortKey="artist" sort={sort} onSort={onSort} />
                  <SortableTh label="Created" sortKey="created" sort={sort} onSort={onSort} />
                  <SortableTh label="Uploaded" sortKey="updated" sort={sort} onSort={onSort} />
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => {
                  if (row.kind === 'group') {
                    return (
                      <tr key={`group-${row.label}`}>
                        <td
                          colSpan={10}
                          style={{
                            background: 'var(--surface-2, rgba(0,0,0,0.03))',
                            color: 'var(--text-dim)',
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {row.label}
                        </td>
                      </tr>
                    );
                  }
                  const p = row.p;
                  return (
                  <tr key={p.id}>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 6,
                          textAlign: 'left',
                          paddingLeft: row.indented ? 18 : 0,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block',
                            width: 10,
                            flex: 'none',
                            color: row.indented
                              ? CHILD_TEXT
                              : 'var(--text-faint)',
                          }}
                        >
                          {row.indented ? '└' : ''}
                        </span>
                        <span>
                          <strong
                            style={{
                              display: 'block',
                              color: row.indented ? CHILD_TEXT : undefined,
                            }}
                          >
                            {p.name}
                          </strong>
                          <span
                            style={{
                              color: row.indented
                                ? 'color-mix(in srgb, #4c51bf 55%, transparent)'
                                : 'var(--text-faint)',
                              fontSize: 12,
                            }}
                          >
                            {p.slug}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <TypeBadge
                        modelType={p.model_type}
                        parentId={p.parent_id}
                        parentName={p.parent_name}
                      />
                    </td>
                    <td>
                      <ReferenceThumbs
                        references={p.references}
                        onOpen={(index) =>
                          setLightbox({
                            refs: p.references || [],
                            index,
                            label: p.name,
                          })
                        }
                      />
                    </td>
                    {/* Classification. Unset renders as a muted em
                        dash so "not classified yet" reads as a real
                        state rather than a rendering gap. */}
                    <td
                      style={{
                        color: p.category ? undefined : 'var(--text-faint)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {categoryLabel(p.category)}
                    </td>
                    <td
                      style={{
                        color: p.complexity ? undefined : 'var(--text-faint)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {complexityLabel(p.complexity)}
                    </td>
                    <td>
                      {p.assignee?.name || (
                        <em style={{ color: 'var(--text-faint)' }}>
                          unassigned
                        </em>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-dim)' }}>
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ color: 'var(--text-dim)' }}>
                      {new Date(p.updated_at).toLocaleString(undefined, {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      })}
                    </td>
                    <td>
                      {/* Pass `assigned` so a draft row renders YTS
                          (artist on it) vs YTA (no artist) — matches
                          the Overview dashboard's badge behaviour. */}
                      <StatusBadge
                        status={p.status}
                        revisionCount={p.revision_count}
                        assigned={p.assigned_to !== null}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div
                        style={{
                          display: 'inline-flex',
                          gap: 8,
                          justifyContent: 'flex-end',
                        }}
                      >
                        <button
                          type="button"
                          className="crm-btn crm-btn-ghost crm-btn-icon"
                          onClick={() =>
                            router.push(crmPath(`/admin/${p.id}/edit`))
                          }
                          title="Rename this job or edit its brief"
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          <Pencil size={14} strokeWidth={1.75} />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          className="crm-btn crm-btn-ghost crm-btn-icon"
                          onClick={() => {
                            setDelError(null);
                            setConfirmTarget(p);
                          }}
                          title="Permanently delete this job and all its data"
                          style={{ whiteSpace: 'nowrap', color: '#dc2626' }}
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                          <span>Delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Reference lightbox. Reuses the same .crm-lightbox
              chrome as the QA references gallery so enlarging an
              image looks identical wherever you do it. */}
          {lightbox && lightbox.refs.length > 0 && (
            <div
              className="crm-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`Reference images for ${lightbox.label}`}
              onClick={() => setLightbox(null)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightbox.refs[lightbox.index].image_url}
                alt={`Reference ${lightbox.index + 1} for ${lightbox.label}`}
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: 'default' }}
              />

              {lightbox.refs.length > 1 && (
                <>
                  <button
                    type="button"
                    className="crm-lightbox-arrow is-prev"
                    aria-label="Previous reference"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightbox((l) =>
                        l
                          ? {
                              ...l,
                              index:
                                (l.index - 1 + l.refs.length) % l.refs.length,
                            }
                          : l
                      );
                    }}
                  >
                    <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="crm-lightbox-arrow is-next"
                    aria-label="Next reference"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightbox((l) =>
                        l ? { ...l, index: (l.index + 1) % l.refs.length } : l
                      );
                    }}
                  >
                    <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </>
              )}

              <button
                type="button"
                className="crm-lightbox-close"
                aria-label="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox(null);
                }}
              >
                <X size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>

              <p
                style={{
                  position: 'fixed',
                  bottom: 18,
                  left: 0,
                  right: 0,
                  textAlign: 'center',
                  color: 'rgba(255,255,255,0.72)',
                  fontSize: 12,
                  margin: 0,
                  pointerEvents: 'none',
                }}
              >
                {lightbox.label} · {lightbox.index + 1} of{' '}
                {lightbox.refs.length}
              </p>
            </div>
          )}

          {/* Hard-delete confirmation. Destructive + irreversible,
              so we require an explicit click on "Delete permanently"
              rather than deleting on the row button directly. */}
          {confirmTarget && (
            <div
              role="dialog"
              aria-modal="true"
              onClick={() => {
                if (!deletingId) setConfirmTarget(null);
              }}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                padding: 16,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: 'var(--surface, #fff)',
                  border: '1px solid var(--border, #e5e7eb)',
                  borderRadius: 12,
                  maxWidth: 460,
                  width: '100%',
                  padding: 24,
                  boxShadow: '0 12px 40px rgba(0,0,0,0.22)',
                }}
              >
                <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>
                  Delete &ldquo;{confirmTarget.name}&rdquo;?
                </h3>
                <p
                  style={{
                    margin: '0 0 16px',
                    color: 'var(--text-dim)',
                    fontSize: 14,
                    lineHeight: 1.5,
                  }}
                >
                  This permanently removes{' '}
                  <strong>{confirmTarget.slug}</strong> and everything tied to
                  it &mdash; feedback, references, and any uploaded or published
                  3D files &mdash; from both the database and storage. This
                  cannot be undone.
                </p>
                {delError && (
                  <p style={{ color: '#dc2626', fontSize: 13, margin: '0 0 12px' }}>
                    {delError}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="crm-btn crm-btn-ghost"
                    disabled={!!deletingId}
                    onClick={() => setConfirmTarget(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="crm-btn"
                    disabled={!!deletingId}
                    onClick={() => handlePurge(confirmTarget)}
                    style={{ background: '#dc2626', borderColor: '#dc2626', color: '#fff' }}
                  >
                    {deletingId ? 'Deleting\u2026' : 'Delete permanently'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ============================================================
// ReferenceThumbs
//
// Single thumbnail for the Reference column — just the first
// image, so every row stays the same width and the column reads
// as a quiet visual identifier rather than a gallery. Clicking it
// still opens the lightbox on the full set, so nothing is lost by
// only previewing one.
//
// Jobs briefed without imagery render a muted placeholder rather
// than an empty cell, so "no references" reads as a deliberate
// state instead of a loading gap.
// ============================================================
function ReferenceThumbs({
  references,
  onOpen,
}: {
  references?: ProjectReference[];
  onOpen: (index: number) => void;
}) {
  const refs = references || [];

  if (refs.length === 0) {
    return (
      <span
        title="This job has no reference images"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          color: 'var(--text-faint)',
          fontSize: 12,
        }}
      >
        <ImageOff size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>None</span>
      </span>
    );
  }

  return (
    <div className="crm-ref-strip">
      <button
        type="button"
        className="crm-ref-strip-thumb"
        onClick={() => onOpen(0)}
        title={
          refs.length === 1
            ? 'Click to enlarge'
            : `Click to enlarge — ${refs.length} reference images`
        }
        aria-label={
          refs.length === 1
            ? 'Enlarge reference image'
            : `Enlarge reference images (${refs.length} total)`
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={refs[0].image_url} alt="" loading="lazy" />
      </button>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================
function EmptyMini({ message }: { message: string }) {
  return (
    <p
      style={{
        color: 'var(--text-dim)',
        padding: '16px 0 32px',
        fontSize: 13,
      }}
    >
      {message}
    </p>
  );
}
