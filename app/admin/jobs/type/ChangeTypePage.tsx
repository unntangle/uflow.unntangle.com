'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
import { crmFetch, crmPath } from '../../../lib/client-fetch';
import { ProjectStatus } from '../../../lib/supabase';
import {
  useTableSort,
  SortableTh,
  statusRank,
} from '../../../lib/use-table-sort';

// ============================================================
// Types
// ============================================================
type ModelType = 'parent' | 'child';

type Project = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  assigned_to: string | null;
  updated_at: string;
  client_id: string;
  model_type: ModelType;
  parent_id: string | null;
  parent_name: string | null;
  client: { slug: string; name: string };
  assignee: { id: string; name: string } | null;
  // Earliest reference image, collapsed server-side so the
  // References column costs no extra fetch per row.
  thumb_url?: string | null;
};

// Per-row save state, keyed by project id. Each row owns its own
// so changing one job doesn't lock the rest of the page.
type RowState =
  | { stage: 'idle' }
  | { stage: 'saving' }
  | { stage: 'saved' }
  | { stage: 'error'; message: string };

// The working (uncommitted) selection for a row.
type Draft = { model_type: ModelType; parent_id: string };

// ============================================================
// References cell — thumbnail of the first reference image,
// linked to the full gallery in a new tab. Same treatment as
// the Overview and List Jobs so a job's References cell reads
// identically wherever it appears.
//
// Raw <img> rather than next/image: these are remote R2 URLs on
// arbitrary hosts, and registering each in next.config
// remotePatterns is a bigger change than this column warrants.
// ============================================================
function ReferenceThumb({ project }: { project: Project }) {
  if (!project.thumb_url) {
    return (
      <span
        style={{ color: 'var(--text-faint)' }}
        title="No reference images attached to this job"
      >
        —
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

// ============================================================
// ChangeTypePage
// ============================================================
// One row per job. Each row carries a Type dropdown and, when
// Child is selected, a Parent dropdown beside it. Nothing is
// written until Save, and Save only enables when the pair
// actually differs from what's stored.
//
// Two rules are enforced in the dropdown itself so the admin
// can't compose a move the server would refuse:
//   * a job never appears in its own Parent list
//   * children never appear as parent candidates (one level deep)
//
// A third rule — you can't demote a parent that still has
// children — depends on the whole table, so it's checked here
// too and explained on the row rather than left to a 400.
// ============================================================
export default function ChangeTypePage({
  initialProjects,
  currentUser,
}: {
  initialProjects: Project[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      initialProjects.map((p) => [
        p.id,
        { model_type: p.model_type, parent_id: p.parent_id ?? '' },
      ])
    )
  );
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  // Free-text filter across job name, slug and client. With the
  // whole back catalogue on one page, finding the row you came
  // for matters more than it does on Reassign (which is already
  // narrowed to open jobs).
  const [q, setQ] = useState('');

  function setRow(id: string, s: RowState) {
    setRowState((prev) => ({ ...prev, [id]: s }));
  }
  function setDraft(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    // Clear a stale Saved ✓ / error the moment the row changes
    // again, so the indicator always describes the current state.
    const st = rowState[id];
    if (st && st.stage !== 'idle' && st.stage !== 'saving') {
      setRow(id, { stage: 'idle' });
    }
  }

  // Every job that is currently a parent, in name order. This is
  // the candidate pool for the Parent dropdown; a row filters
  // itself out of its own list below.
  //
  // Read off the LIVE `projects` state rather than the initial
  // props so promoting a job to parent immediately makes it
  // available to other rows without a reload.
  const parentCandidates = useMemo(
    () =>
      projects
        .filter((p) => p.model_type === 'parent')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  );

  // id -> the children currently hanging off it. Used to block
  // (and explain) demoting a parent that still has children,
  // which would otherwise create grandchildren.
  const childrenByParent = useMemo(() => {
    const m = new Map<string, Project[]>();
    for (const p of projects) {
      if (p.model_type === 'child' && p.parent_id) {
        const list = m.get(p.parent_id);
        if (list) list.push(p);
        else m.set(p.parent_id, [p]);
      }
    }
    return m;
  }, [projects]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.slug.toLowerCase().includes(needle) ||
        p.client.name.toLowerCase().includes(needle)
    );
  }, [projects, q]);

  const { sorted, sort, onSort } = useTableSort(filtered, {
    name: (p) => p.name,
    client: (p) => p.client.name,
    status: (p) => statusRank(p.status),
    type: (p) => p.model_type,
    parent: (p) => p.parent_name,
  });

  // Why this row can't be saved right now, or null if it can.
  // Returned as a sentence because it's shown to the admin
  // verbatim — there's no second place that interprets it.
  function blockedReason(p: Project, draft: Draft): string | null {
    if (draft.model_type === 'child') {
      if (!draft.parent_id) return 'Pick a parent model.';
      const kids = childrenByParent.get(p.id) ?? [];
      if (kids.length > 0) {
        const names = kids.slice(0, 3).map((k) => k.name).join(', ');
        const more = kids.length > 3 ? `, +${kids.length - 3} more` : '';
        return `This is the parent of ${names}${more}. Move those onto another parent first.`;
      }
    }
    return null;
  }

  async function save(p: Project) {
    const draft = drafts[p.id];
    if (!draft) return;
    if (blockedReason(p, draft)) return;

    const payload =
      draft.model_type === 'child'
        ? { model_type: 'child', parent_id: draft.parent_id }
        : { model_type: 'parent' };

    setRow(p.id, { stage: 'saving' });
    try {
      const res = await crmFetch(`/api/projects/${p.id}/type`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setRow(p.id, { stage: 'error', message: data.error || 'Failed.' });
        return;
      }

      const newParentId =
        draft.model_type === 'child' ? draft.parent_id : null;
      const newParentName = newParentId
        ? projects.find((x) => x.id === newParentId)?.name ?? null
        : null;

      setProjects((prev) =>
        prev.map((row) => {
          if (row.id === p.id) {
            return {
              ...row,
              model_type: draft.model_type,
              parent_id: newParentId,
              parent_name: newParentName,
            };
          }
          // Demoting a job to child removes it from the candidate
          // pool, which orphans anything that pointed at it. That
          // can't happen (blockedReason refuses it), but if the
          // server ever allowed it, leaving stale links on screen
          // would be worse than showing them as unparented.
          if (
            draft.model_type === 'child' &&
            row.parent_id === p.id
          ) {
            return { ...row, parent_id: null, parent_name: null };
          }
          return row;
        })
      );
      setRow(p.id, { stage: 'saved' });
      router.refresh();
    } catch (e) {
      setRow(p.id, { stage: 'error', message: (e as Error).message });
    }
  }

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Change Type</h1>
              <p className="crm-page-sub">
                Make a job standalone, or hang it off an existing model
                as a child. Changes save per row and don&apos;t touch
                status, artist or uploads.
              </p>
            </div>
            <button
              className="crm-btn crm-btn-secondary"
              onClick={() => router.push(crmPath('/admin'))}
            >
              Back to Overview
            </button>
          </header>

          {projects.length === 0 ? (
            <div className="crm-empty">
              <h3>No jobs yet</h3>
              <p>
                Create a job from the sidebar first, then come back to
                organise the parent/child relationships.
              </p>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 12 }}>
                <input
                  className="crm-input"
                  placeholder="Filter by job, slug or client…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  style={{ maxWidth: 320 }}
                />
              </div>

              {filtered.length === 0 ? (
                <div className="crm-empty">
                  <h3>No jobs match &ldquo;{q}&rdquo;</h3>
                  <p>Try a shorter search, or clear the filter.</p>
                </div>
              ) : (
                <table className="crm-table">
                  <thead>
                    <tr>
                      <SortableTh
                        label="Job"
                        sortKey="name"
                        sort={sort}
                        onSort={onSort}
                        style={{ width: '22%' }}
                      />
                      <th style={{ width: 90 }}>References</th>
                      <SortableTh
                        label="Client"
                        sortKey="client"
                        sort={sort}
                        onSort={onSort}
                      />
                      <SortableTh
                        label="Status"
                        sortKey="status"
                        sort={sort}
                        onSort={onSort}
                      />
                      <SortableTh
                        label="Current type"
                        sortKey="type"
                        sort={sort}
                        onSort={onSort}
                      />
                      <th style={{ width: '16%' }}>Change to</th>
                      <th style={{ width: '22%' }}>Parent model</th>
                      <th style={{ textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((p) => {
                      const state = rowState[p.id] ?? { stage: 'idle' };
                      const draft =
                        drafts[p.id] ?? {
                          model_type: p.model_type,
                          parent_id: p.parent_id ?? '',
                        };
                      const storedParent = p.parent_id ?? '';
                      const dirty =
                        draft.model_type !== p.model_type ||
                        (draft.model_type === 'child' &&
                          draft.parent_id !== storedParent);
                      const blocked = blockedReason(p, draft);
                      // A job can't parent itself, and a child can't
                      // be a parent — so both are filtered out of
                      // the options rather than rejected on submit.
                      const options = parentCandidates.filter(
                        (c) => c.id !== p.id
                      );
                      const orphaned =
                        p.model_type === 'child' && !p.parent_id;

                      return (
                        <tr key={p.id}>
                          <td>
                            <strong style={{ display: 'block' }}>
                              {p.name}
                            </strong>
                            <span
                              style={{
                                color: 'var(--text-faint)',
                                fontSize: 12,
                              }}
                            >
                              {p.slug}
                            </span>
                          </td>
                          <td>
                            <ReferenceThumb project={p} />
                          </td>
                          <td>{p.client.name}</td>
                          <td>
                            <StatusBadge
                              status={p.status}
                              assigned={p.assigned_to !== null}
                            />
                          </td>
                          <td>
                            <span
                              style={{
                                display: 'inline-block',
                                border: '1px solid var(--border)',
                                borderRadius: 999,
                                padding: '2px 10px',
                                fontSize: 12,
                              }}
                            >
                              {p.model_type === 'child' ? 'Child' : 'Parent'}
                            </span>
                            {p.model_type === 'child' && (
                              <div
                                style={{
                                  color: orphaned
                                    ? '#92400e'
                                    : 'var(--text-faint)',
                                  fontSize: 11,
                                  marginTop: 4,
                                }}
                              >
                                {/* An orphan is a child whose parent
                                    was deleted — the FK is ON DELETE
                                    SET NULL, so the work survives but
                                    the link doesn't. */}
                                {orphaned
                                  ? '⚠ parent removed'
                                  : `of ${p.parent_name}`}
                              </div>
                            )}
                          </td>
                          <td>
                            <select
                              className="crm-input"
                              value={draft.model_type}
                              onChange={(e) =>
                                setDraft(p.id, {
                                  model_type: e.target.value as ModelType,
                                  // Switching to Parent drops the
                                  // selection so a stale id can't ride
                                  // along in the payload.
                                  ...(e.target.value === 'parent'
                                    ? { parent_id: '' }
                                    : {}),
                                })
                              }
                              disabled={state.stage === 'saving'}
                            >
                              <option value="parent">Parent</option>
                              <option value="child">Child</option>
                            </select>
                          </td>
                          <td>
                            {draft.model_type === 'child' ? (
                              <select
                                className="crm-input"
                                value={draft.parent_id}
                                onChange={(e) =>
                                  setDraft(p.id, { parent_id: e.target.value })
                                }
                                disabled={
                                  state.stage === 'saving' ||
                                  options.length === 0
                                }
                              >
                                <option value="">Select a parent…</option>
                                {options.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.client.slug !== p.client.slug
                                      ? `${c.name} — ${c.client.name}`
                                      : c.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span style={{ color: 'var(--text-faint)' }}>
                                —
                              </span>
                            )}
                            {blocked && dirty && (
                              <div
                                style={{
                                  color: '#92400e',
                                  fontSize: 11,
                                  marginTop: 6,
                                }}
                              >
                                {blocked}
                              </div>
                            )}
                            {state.stage === 'error' && (
                              <div
                                className="crm-error"
                                style={{ marginTop: 6 }}
                              >
                                {state.message}
                              </div>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="crm-btn"
                              onClick={() => save(p)}
                              disabled={
                                !dirty ||
                                !!blocked ||
                                state.stage === 'saving'
                              }
                            >
                              {state.stage === 'saving'
                                ? 'Saving…'
                                : state.stage === 'saved'
                                ? 'Saved ✓'
                                : 'Save'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
