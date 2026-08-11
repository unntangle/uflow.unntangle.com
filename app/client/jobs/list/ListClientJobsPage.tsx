'use client';

import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import Sidebar from '../../../components/Sidebar';
import { crmPath, crmFetch } from '../../../lib/client-fetch';
import { useTableSort, SortableTh } from '../../../lib/use-table-sort';
import { anyVariantIn, allVariantsApproved } from '../../../lib/variant-status';

// ============================================================
// Types
// ============================================================
type Project = {
  id: string;
  slug: string;
  name: string;
  status:
    | 'draft'
    | 'qa_pending'
    | 'iqa_rejected'
    | 'eqa_rejected'
    | 'wip'
    | 'iqa_wip'
    | 'eqa_wip'
    | 'client_review'
    | 'approved';
  revision_count: number;
  // Client-scoped revision count (distinct EQA rejection rounds).
  // Internal IQA rounds are deliberately excluded upstream.
  client_revision_count?: number;
  latest_client_revision?: number | null;
  glb_url: string | null;
  approved_glb_url: string | null;
  created_at: string;
  updated_at: string;
  client: { slug: string; name: string };
  has_client_rejection?: boolean;
  // Colourways. Since the 2026-08-06 variants migration these
  // rows hold per-model state, so the Status column has to be
  // derived from them rather than from the product's own column.
  variants?: Variant[];
  // Earliest reference image, collapsed server-side. Drives the
  // References column thumbnail; null when the job has none.
  thumb_url?: string | null;
};

type Variant = {
  id: string;
  name: string;
  slug: string;
  status: Project['status'];
  revision_count: number;
  glb_url: string | null;
  approved_glb_url: string | null;
  is_primary: boolean;
  position: number;
  updated_at: string;
};

type Brand = { id: string; slug: string; name: string };

// ============================================================
// ListClientJobsPage
//
// Flat, all-statuses index of every job for the client's brand.
// The client counterpart to the admin List Jobs page. Unlike the
// Overview (which buckets jobs into EQA / EQA Rejected / Open /
// Approved tabs), this is a single searchable table — handy when
// the client just wants to find one job by name across the whole
// pipeline.
//
// Presentation matches the Overview dashboard exactly:
//   - Status uses the client-facing vocabulary
//     (Open / EQA / EQA Rejected / Approved), never the internal
//     pipeline statuses.
//   - Revision Round shows ONLY the client's own rejection rounds
//     and deep-links into their feedback gallery.
//
// Read-only by design: create / edit / delete stay on the
// Overview + the dedicated Create/Edit pages, so this page is a
// pure "find and open" index.
// ============================================================
export default function ListClientJobsPage({
  initialProjects,
  brand,
  currentUser,
}: {
  initialProjects: Project[];
  brand: Brand;
  currentUser: { name: string; role: 'client' };
}) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [query, setQuery] = useState('');

  // Hard-delete (purge) state — same flow as the admin List Jobs
  // page. The shared endpoint scopes the purge to this client's
  // own brand, so a client can only ever delete their own jobs.
  const [confirmTarget, setConfirmTarget] = useState<Project | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

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

  // Deep-link to the client's own feedback for a project, scoped
  // to their latest rejection round. Mirrors the Overview's
  // Revision Round link (source=client + a concrete revision so
  // the gallery opens on a valid filter).
  function clientFeedbackHref(
    projectId: string,
    revision: number | null | undefined
  ): string {
    const params = new URLSearchParams();
    if (typeof revision === 'number') params.set('revision', String(revision));
    params.set('source', 'client');
    return crmPath(`/projects/${projectId}/feedback?${params.toString()}`);
  }

  // Free-text filter on name + slug. The list is small and
  // filtering is synchronous, so no debounce is needed.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)
    );
  }, [projects, query]);

  // Per-column sort. Status sorts by the client-facing label rank
  // (Open -> EQA -> EQA Rejected -> Approved); Revision Round by
  // the client-scoped count; the rest by name / date.
  const statusOrder: Record<string, number> = {
    Open: 0,
    EQA: 1,
    'EQA Rejected': 2,
    Approved: 3,
  };
  const { sorted, sort, onSort } = useTableSort(visible, {
    name: (p) => p.name,
    revision: (p) => p.client_revision_count ?? 0,
    created: (p) => new Date(p.created_at),
    status: (p) => statusOrder[clientStatusLabel(p)] ?? 99,
  });

  return (
    <div className="crm-shell">
      <Sidebar
        name={currentUser.name}
        role={currentUser.role}
        brandName={brand.name}
      />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">List Jobs</h1>
              <p className="crm-page-sub">
                {brand.name} · Every job for your brand, across all statuses.
              </p>
            </div>
          </header>

          {/* Search box — filters the in-memory list on name + slug. */}
          <div style={{ marginBottom: 16, maxWidth: 360 }}>
            <input
              className="crm-input"
              type="search"
              placeholder="Search by name or slug…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {visible.length === 0 ? (
            <p
              style={{
                color: 'var(--text-dim)',
                padding: '16px 0 32px',
                fontSize: 13,
              }}
            >
              {query.trim()
                ? `No jobs match \u201C${query.trim()}\u201D.`
                : 'No jobs to show.'}
            </p>
          ) : (
            <table className="crm-table">
              <thead>
                <tr>
                  <SortableTh label="Project" sortKey="name" sort={sort} onSort={onSort} />
                  <th>References</th>
                  <SortableTh label="Revision Round" sortKey="revision" sort={sort} onSort={onSort} />
                  <SortableTh label="Created" sortKey="created" sort={sort} onSort={onSort} />
                  <th>Asset</th>
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const rounds = p.client_revision_count ?? 0;
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong style={{ display: 'block' }}>{p.name}</strong>
                        <span
                          style={{ color: 'var(--text-faint)', fontSize: 12 }}
                        >
                          {p.slug}
                        </span>
                      </td>
                      <td>
                        <ReferenceThumb project={p} />
                      </td>
                      <td>
                        {rounds === 0 ? (
                          <span
                            style={{ color: 'var(--text-faint)', fontSize: 13 }}
                          >
                            &mdash;
                          </span>
                        ) : (
                          <a
                            className="crm-link"
                            href={clientFeedbackHref(p.id, p.latest_client_revision)}
                            target="_blank"
                            rel="noreferrer"
                            title={`View your feedback \u2014 ${rounds} rejection round${
                              rounds === 1 ? '' : 's'
                            }`}
                          >
                            {rounds}
                          </a>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-dim)' }}>
                        {new Date(p.created_at).toLocaleDateString()}
                      </td>
                      <td>
                        {/* Falls back to the colourways: on a variant
                            job the product's own glb_url is never
                            written, so this cell would otherwise be
                            empty for every model in flight. */}
                        {(p.approved_glb_url ||
                          p.glb_url ||
                          (p.variants ?? []).some(
                            (v) => v.approved_glb_url || v.glb_url
                          )) && (
                          <a
                            className="crm-link"
                            href={crmPath(`/admin/qa/${p.id}/model`)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View GLB
                          </a>
                        )}
                      </td>
                      <td>
                        <ClientStatusPill label={clientStatusLabel(p)} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Hard-delete confirmation. Destructive + irreversible,
              so we gate it behind an explicit "Delete permanently". */}
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
// Client-facing status label + pill. Kept in sync with the
// Overview dashboard so a job reads the same on both screens.
// ============================================================
function clientStatusLabel(p: Project): string {
  // Colourway-aware, matching ClientDashboard exactly. Reading
  // p.status directly would report "Open" for a job whose model
  // is actually sitting in the client's own EQA queue, because
  // the product row isn't written on the variant path.
  if (allVariantsApproved(p)) return 'Approved';
  if (anyVariantIn(p, ['client_review'])) return 'EQA';
  if (anyVariantIn(p, ['eqa_rejected']) || p.has_client_rejection) {
    return 'EQA Rejected';
  }
  return 'Open';
}

function ClientStatusPill({ label }: { label: string }) {
  let cls = 'crm-badge-draft';
  if (label === 'Approved') cls = 'crm-badge-approved';
  else if (label === 'EQA Rejected') cls = 'crm-badge-rejected';
  else if (label === 'EQA') cls = 'crm-badge-client-review';
  return <span className={`crm-badge ${cls}`}>{label}</span>;
}

// ============================================================
// References cell — thumbnail of the first reference image,
// linked to the full gallery. Same treatment as the Overview
// dashboard and the admin table, so the column reads identically
// everywhere. Falls back to a dim em-dash when the job has no
// references (not a link — the gallery would just be empty).
// ============================================================
function ReferenceThumb({ project }: { project: Project }) {
  if (!project.thumb_url) {
    return (
      <span
        style={{ color: 'var(--text-faint)' }}
        title="No reference images attached to this job"
      >
        &mdash;
      </span>
    );
  }
  return (
    <a
      href={crmPath(`/admin/qa/${project.id}/references`)}
      target="_blank"
      rel="noreferrer"
      title={`Open the reference gallery for ${project.name}`}
      style={{
        display: 'inline-block',
        lineHeight: 0,
        border: '1px solid var(--border)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={project.thumb_url}
        alt=""
        width={44}
        height={44}
        loading="lazy"
        decoding="async"
        style={{
          width: 44,
          height: 44,
          objectFit: 'cover',
          display: 'block',
          background: 'var(--surface-2, transparent)',
        }}
      />
    </a>
  );
}
