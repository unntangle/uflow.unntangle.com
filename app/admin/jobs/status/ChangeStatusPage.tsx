'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
import {
  CLIENT_FILTER_EVENT,
  getStoredClientId,
} from '../../../components/ClientSwitcher';
import { crmFetch, crmPath } from '../../../lib/client-fetch';
import { ProjectStatus } from '../../../lib/supabase';
import {
  useTableSort,
  SortableTh,
  statusRank,
} from '../../../lib/use-table-sort';
import { extraVariants, hasExtraVariants } from '../../../lib/variant-status';
import {
  STATUS_TARGET_OPTIONS,
  StatusTarget,
  currentStatusLabel,
  currentTarget,
  targetHint,
  targetLabel,
  targetOption,
} from '../../../lib/status-options';

// ============================================================
// Types
// ============================================================
type Variant = {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  revision_count: number;
  is_primary: boolean;
  position: number;
  updated_at: string;
};

type Project = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string } | null;
  variants: Variant[];
};

// Per-row save state, keyed by rowKey. Mirrors the shape
// ReassignJobsForm uses so the two pages behave the same.
// `warnings` rides along on success because the status endpoint
// can succeed and still have something worth saying.
type RowState =
  | { stage: 'idle' }
  | { stage: 'saving' }
  | { stage: 'saved'; warnings: string[] }
  | { stage: 'error'; message: string };

// ============================================================
// What each dropdown actually writes
// ============================================================
// Since the variants migration, uflow_project_variants holds the
// authoritative per-colourway status; uflow_projects.status is
// legacy and only written on the single-model path. So a parent
// row's dropdown must target the PRIMARY VARIANT when the job
// has one — writing the product row instead would save happily
// and change nothing visible on any dashboard.
//
// This matches how List Jobs and the Overview already badge a
// parent row: the parent row IS the original colourway. Extra
// colourways get their own child rows below it.
//
// Jobs predating the migration have no variant rows at all, and
// for those the product row is the real one, so the target falls
// back to it.
//
// `assigned` is read from the PRODUCT in both cases. YTA vs YTS
// is a job-level distinction here, exactly as it is on Job
// Allocation and Reassign Jobs — a colourway doesn't get its own
// artist in any UI we ship.
// ============================================================
type RowTarget = {
  // Stable key for selections + per-row state.
  key: string;
  projectId: string;
  variantId: string | null;
  status: ProjectStatus;
  assigned: boolean;
};

function parentTarget(p: Project): RowTarget {
  const primary = p.variants.find((v) => v.is_primary) ?? null;
  return {
    key: primary ? `v:${primary.id}` : `p:${p.id}`,
    projectId: p.id,
    variantId: primary?.id ?? null,
    status: primary?.status ?? p.status,
    assigned: p.assigned_to !== null,
  };
}

function variantTarget(p: Project, v: Variant): RowTarget {
  return {
    key: `v:${v.id}`,
    projectId: p.id,
    variantId: v.id,
    status: v.status,
    assigned: p.assigned_to !== null,
  };
}

// ============================================================
// ChangeStatusPage
//
// Sends a job back to the start of the pipeline: YTA (unassigned)
// or YTS (artist kept). One dropdown per row, saved per row, so
// several corrections can be made without leaving the page.
//
// Only the two draft flavours are offered. Everything forward of
// draft is reached by doing the work — Start, upload, approve,
// reject — and those paths also write revision counts, files and
// published pages that a raw status write would leave behind.
// Jumping a job straight to Approved from here would mark it
// finished with nothing published, which is worse than not
// offering it at all.
//
// Every change still goes through a confirmation dialog. Unlike
// the rest of the app, where a status moves because someone did
// the work, this page moves it by decree — resetting a job in a
// client's review queue is not something to do on a mis-click.
// ============================================================
export default function ChangeStatusPage({
  initialProjects,
  currentUser,
}: {
  initialProjects: Project[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Working selection per row, separate from the persisted value
  // so the dropdown can be changed without committing. '' is the
  // "leave it alone" placeholder, which is what rows sitting
  // anywhere other than draft start on.
  const [selections, setSelections] = useState<Record<string, StatusTarget | ''>>(
    {}
  );
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  // Pending confirmation. Holds everything the dialog needs to
  // describe the change; nothing hits the server until confirmed.
  const [confirming, setConfirming] = useState<{
    target: RowTarget;
    label: string;
    to: StatusTarget;
  } | null>(null);

  function setRow(key: string, s: RowState) {
    setRowState((prev) => ({ ...prev, [key]: s }));
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---- Brand filter, synced with the sidebar ClientSwitcher.
  // Same wiring as List Jobs and the Overview: read on mount,
  // then listen for the custom event plus the native storage
  // event so a change in another tab is picked up too.
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
        // Colourway names are searchable too — "green" should
        // find the job whose Green variant needs correcting.
        p.variants.some((v) => v.name.toLowerCase().includes(q))
      );
    });
  }, [projects, selectedClientId, query]);

  const { sorted, sort, onSort } = useTableSort(visible, {
    name: (p) => p.name,
    client: (p) => p.client.name,
    artist: (p) => p.assignee?.name ?? null,
    updated: (p) => new Date(p.updated_at),
    // Sorts by the status the parent row actually shows, which is
    // the primary colourway's — not the stale product column.
    status: (p) => statusRank(parentTarget(p).status),
  });

  // ----- The server call -----
  // Writes the status (and, for YTA, clears the assignment), then
  // patches local state so the row's badge and dropdown agree
  // with what was saved without a full reload. router.refresh()
  // re-runs the server component afterwards so every other
  // surface stays in step.
  async function persist(target: RowTarget, to: StatusTarget) {
    const opt = targetOption(to);
    setRow(target.key, { stage: 'saving' });
    try {
      const res = await crmFetch(`/api/projects/${target.projectId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: opt.status,
          variant_id: target.variantId,
          clear_assignment: opt.clearsAssignment,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRow(target.key, {
          stage: 'error',
          message: data?.error || 'Failed to save.',
        });
        return;
      }

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== target.projectId) return p;
          // The unassign lands on the product row even when a
          // colourway was targeted, so it's applied here in both
          // branches — see the RowTarget comment above.
          const base = opt.clearsAssignment
            ? { ...p, assigned_to: null, assignee: null }
            : p;
          if (target.variantId) {
            return {
              ...base,
              variants: base.variants.map((v) =>
                v.id === target.variantId ? { ...v, status: opt.status } : v
              ),
            };
          }
          return { ...base, status: opt.status };
        })
      );

      setRow(target.key, {
        stage: 'saved',
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
      });
      router.refresh();
    } catch (e) {
      setRow(target.key, { stage: 'error', message: (e as Error).message });
    }
  }

  function requestSave(target: RowTarget, label: string) {
    const to = selections[target.key];
    if (!to) return;
    if (to === currentTarget(target.status, target.assigned)) return;
    setConfirming({ target, label, to });
  }

  // Shared renderer for the dropdown + Save pair, used by both the
  // parent row and the colourway child rows so the two can't drift
  // apart.
  //
  // A plain function returning JSX, NOT a nested component. A
  // component declared inside the render body gets a fresh identity
  // on every render, so React would unmount and remount every
  // <select> on each keystroke in the search box — stealing focus
  // mid-interaction. Inlining the markup avoids that entirely.
  function renderStatusControl(target: RowTarget, label: string) {
    // Annotated explicitly so the union narrows on `state.stage`.
    // Without it the `{ stage: 'idle' }` fallback widens `stage`
    // to string and the checks below stop discriminating.
    const state: RowState = rowState[target.key] ?? { stage: 'idle' };
    const already = currentTarget(target.status, target.assigned);
    // Rows already at draft open on the flavour they're on; rows
    // anywhere else in the pipeline open on the placeholder,
    // because neither YTA nor YTS describes where they are.
    const selected = selections[target.key] ?? already ?? '';
    const dirty = !!selected && selected !== already;

    return (
      <>
        <select
          className="crm-input"
          value={selected}
          disabled={state.stage === 'saving'}
          onChange={(e) => {
            const raw = e.target.value;
            setSelections((prev) => ({
              ...prev,
              [target.key]: raw === '' ? '' : (raw as StatusTarget),
            }));
            // Clear a stale saved/error indicator as soon as the
            // selection moves again.
            if (state.stage === 'saved' || state.stage === 'error') {
              setRow(target.key, { stage: 'idle' });
            }
          }}
        >
          {/* Only rendered for rows that aren't already at draft,
              so the select has something honest to display before
              a choice is made. Disabled so it can't be chosen as
              an action — "no change" is what Cancel is for. */}
          {!already && (
            <option value="" disabled>
              Leave as {currentStatusLabel(target.status, target.assigned)}…
            </option>
          )}
          {STATUS_TARGET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {dirty && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-faint)',
              marginTop: 4,
              lineHeight: 1.4,
            }}
          >
            {targetHint(selected)}
          </div>
        )}

        {state.stage === 'error' && (
          <div className="crm-error" style={{ marginTop: 6 }}>
            {state.message}
          </div>
        )}

        {state.stage === 'saved' && state.warnings.length > 0 && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11,
              lineHeight: 1.45,
              color: '#92400e',
              background: 'rgba(251, 191, 36, 0.12)',
              border: '1px solid rgba(217, 119, 6, 0.35)',
              borderRadius: 8,
              padding: '6px 8px',
            }}
          >
            {state.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="crm-btn"
            disabled={!dirty || state.stage === 'saving'}
            onClick={() => requestSave(target, label)}
          >
            {state.stage === 'saving'
              ? 'Saving…'
              : state.stage === 'saved'
              ? 'Saved ✓'
              : 'Save'}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Change Status</h1>
              <p className="crm-page-sub">
                Send a job back to the start of the pipeline — unassigned
                (YTA) or with its artist kept (YTS).
              </p>
            </div>
            <button
              className="crm-btn crm-btn-secondary"
              onClick={() => router.push(crmPath('/admin'))}
            >
              Back to Overview
            </button>
          </header>

          {/* Standing caution. The things this page deliberately
              does NOT do are the things someone would most
              reasonably assume it does. */}
          <div
            style={{
              margin: '0 0 16px',
              padding: '10px 14px',
              borderRadius: 10,
              fontSize: 13,
              lineHeight: 1.5,
              color: '#92400e',
              background: 'rgba(251, 191, 36, 0.12)',
              border: '1px solid rgba(217, 119, 6, 0.35)',
            }}
          >
            Resetting a job does not touch its revision count, uploaded
            files, or feedback history, and it notifies no one. A job pulled
            back from review disappears from that reviewer&apos;s queue
            immediately.
          </div>

          <div style={{ marginBottom: 16, maxWidth: 360 }}>
            <input
              className="crm-input"
              type="search"
              placeholder="Search by job, slug or colourway…"
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
                ? `No jobs match “${query.trim()}”.`
                : 'No jobs to show.'}
            </p>
          ) : (
            <table className="crm-table">
              <thead>
                <tr>
                  <SortableTh
                    label="Project"
                    sortKey="name"
                    sort={sort}
                    onSort={onSort}
                    style={{ width: '24%' }}
                  />
                  <SortableTh
                    label="Client"
                    sortKey="client"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortableTh
                    label="Artist"
                    sortKey="artist"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortableTh
                    label="Updated"
                    sortKey="updated"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortableTh
                    label="Current"
                    sortKey="status"
                    sort={sort}
                    onSort={onSort}
                  />
                  <th style={{ width: '30%' }}>Reset to</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const target = parentTarget(p);
                  const extras = extraVariants(p.variants);
                  const isOpen = expanded.has(p.id);

                  return (
                    <Fragment key={p.id}>
                      <tr>
                        <td>
                          {hasExtraVariants(p.variants) ? (
                            <button
                              type="button"
                              onClick={() => toggleExpanded(p.id)}
                              aria-expanded={isOpen}
                              aria-label={
                                isOpen ? 'Hide colourways' : 'Show colourways'
                              }
                              style={{
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                font: 'inherit',
                                color: 'inherit',
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 6,
                                textAlign: 'left',
                              }}
                            >
                              <span
                                aria-hidden
                                style={{
                                  color: 'var(--text-faint)',
                                  fontSize: 10,
                                  display: 'inline-block',
                                  transform: isOpen ? 'rotate(90deg)' : 'none',
                                  transition: 'transform 0.12s',
                                }}
                              >
                                ▶
                              </span>
                              <span>
                                <strong style={{ display: 'block' }}>
                                  {p.name}
                                </strong>
                                <span
                                  style={{
                                    color: 'var(--text-faint)',
                                    fontSize: 12,
                                  }}
                                >
                                  {p.slug} · +{extras.length} colourway
                                  {extras.length === 1 ? '' : 's'}
                                </span>
                              </span>
                            </button>
                          ) : (
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 6,
                              }}
                            >
                              <span
                                aria-hidden
                                style={{
                                  display: 'inline-block',
                                  width: 10,
                                  flex: 'none',
                                }}
                              />
                              <span>
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
                              </span>
                            </div>
                          )}
                        </td>
                        <td>{p.client.name}</td>
                        <td>
                          {p.assignee?.name || (
                            <em style={{ color: 'var(--text-faint)' }}>
                              unassigned
                            </em>
                          )}
                        </td>
                        <td style={{ color: 'var(--text-dim)' }}>
                          {new Date(p.updated_at).toLocaleDateString()}
                        </td>
                        <td>
                          <StatusBadge
                            status={target.status}
                            revisionCount={p.revision_count}
                            assigned={target.assigned}
                          />
                        </td>
                        <td>{renderStatusControl(target, p.name)}</td>
                      </tr>

                      {/* Colourway child rows. Each carries its own
                          dropdown because each runs the pipeline
                          independently — Green can be in IQA while
                          the original is approved. */}
                      {isOpen &&
                        extras.map((v) => {
                          const vt = variantTarget(p, v);
                          return (
                            <tr
                              key={v.id}
                              style={{
                                background: 'var(--surface-2, transparent)',
                              }}
                            >
                              <td style={{ paddingLeft: 28 }}>
                                <span
                                  aria-hidden
                                  style={{
                                    color: 'var(--text-faint)',
                                    marginRight: 6,
                                  }}
                                >
                                  └
                                </span>
                                <strong style={{ fontWeight: 600 }}>
                                  {v.name}
                                </strong>
                              </td>
                              <td />
                              <td />
                              <td style={{ color: 'var(--text-dim)' }}>
                                {new Date(v.updated_at).toLocaleDateString()}
                              </td>
                              <td>
                                <StatusBadge
                                  status={v.status}
                                  revisionCount={v.revision_count}
                                  assigned={vt.assigned}
                                />
                              </td>
                              <td>
                                {renderStatusControl(
                                  vt,
                                  `${p.name} \u00b7 ${v.name}`
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {/* ===================== Confirmation ===================== */}
      {confirming && (
        <div
          className="crm-modal-backdrop"
          onClick={() => {
            const rs = rowState[confirming.target.key];
            if (rs?.stage !== 'saving') setConfirming(null);
          }}
        >
          <div
            className="crm-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 500 }}
          >
            <div className="crm-modal-header">
              <div>
                <h2 className="crm-modal-title">Reset this job?</h2>
                <p
                  style={{
                    margin: '4px 0 0',
                    color: 'var(--text-dim)',
                    fontSize: 13,
                  }}
                >
                  {confirming.label}
                </p>
              </div>
              <button
                className="crm-modal-close"
                onClick={() => setConfirming(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <p style={{ fontSize: 14, margin: '4px 0 12px' }}>
              <strong>
                {currentStatusLabel(
                  confirming.target.status,
                  confirming.target.assigned
                )}
              </strong>
              {' → '}
              <strong>{targetLabel(confirming.to)}</strong>
            </p>
            <p
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                color: 'var(--text-dim)',
                lineHeight: 1.5,
              }}
            >
              {targetHint(confirming.to)}
            </p>

            {/* Losing the artist is the one consequence that can't
                be undone from this page — Job Allocation or
                Reassign has to put someone back on it. */}
            {confirming.to === 'yta' && confirming.target.assigned && (
              <div
                style={{
                  padding: 12,
                  background: 'rgba(251, 191, 36, 0.12)',
                  border: '1px solid rgba(217, 119, 6, 0.35)',
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.5,
                  marginBottom: 12,
                }}
              >
                <strong style={{ color: '#92400e' }}>
                  This removes the artist from the job.
                </strong>{' '}
                It drops out of their queue and back into Job Allocation.
                Reassigning someone is a separate step.
              </div>
            )}

            {confirming.target.status === 'approved' && (
              <div
                style={{
                  padding: 12,
                  background: 'rgba(251, 191, 36, 0.12)',
                  border: '1px solid rgba(217, 119, 6, 0.35)',
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.5,
                  marginBottom: 12,
                }}
              >
                <strong style={{ color: '#92400e' }}>
                  Reopening an approved job.
                </strong>{' '}
                It will drop out of the public models list, but the viewer
                page already published stays reachable by direct link until
                it&apos;s republished or removed.
              </div>
            )}

            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                marginTop: 20,
              }}
            >
              <button
                className="crm-btn crm-btn-secondary"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
              <button
                className="crm-btn"
                onClick={async () => {
                  const { target, to } = confirming;
                  setConfirming(null);
                  await persist(target, to);
                }}
              >
                Reset job
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
