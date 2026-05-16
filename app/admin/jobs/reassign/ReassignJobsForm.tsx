'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
import { crmFetch, crmPath } from '../../../lib/client-fetch';

// ============================================================
// Types
// ============================================================
type Project = {
  id: string;
  slug: string;
  name: string;
  status: 'draft' | 'qa_pending' | 'rejected' | 'wip' | 'approved';
  revision_count: number;
  assigned_to: string | null;
  updated_at: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
};
type Artist = { id: string; name: string; email: string };

// Per-row save state. Keyed by project id.
type RowState =
  | { stage: 'idle' }
  | { stage: 'saving' }
  | { stage: 'saved' }
  | { stage: 'error'; message: string };

// ============================================================
// ReassignJobsForm
// One row per open job. Each row has its own dropdown + save
// state so reassigning one job doesn't lock the rest of the
// page. The "Save" button is only enabled when the selection
// actually differs from the project's current assignee.
// ============================================================
export default function ReassignJobsForm({
  initialProjects,
  artists,
  currentUser,
}: {
  initialProjects: Project[];
  artists: Artist[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  // Working selection per row (separate from the persisted
  // p.assigned_to). Lets the user change the dropdown without
  // committing until they click Save.
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialProjects.map((p) => [p.id, p.assigned_to || artists[0]?.id || ''])
    )
  );
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  // Pending confirmation modal for WIP reassignments. We hold the
  // project + target artist while the admin confirms; nothing
  // hits the server until they click "Yes, reassign".
  const [confirming, setConfirming] = useState<{
    project: Project;
    targetArtistId: string;
  } | null>(null);

  function setRow(id: string, s: RowState) {
    setRowState((prev) => ({ ...prev, [id]: s }));
  }

  // The actual server call — split out from the click handler so
  // both the direct "Save" path (draft/rejected) and the confirmed
  // WIP path can call the same code.
  async function persistReassignment(p: Project, target: string) {
    setRow(p.id, { stage: 'saving' });
    try {
      const res = await crmFetch(`/api/projects/${p.id}/assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_to: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRow(p.id, { stage: 'error', message: data.error || 'Failed.' });
        return;
      }

      const newAssignee = artists.find((a) => a.id === target) || null;
      setProjects((prev) =>
        prev.map((row) =>
          row.id === p.id
            ? { ...row, assigned_to: target, assignee: newAssignee }
            : row
        )
      );
      setRow(p.id, { stage: 'saved' });
      router.refresh();
    } catch (e) {
      setRow(p.id, { stage: 'error', message: (e as Error).message });
    }
  }

  function save(p: Project) {
    const target = selections[p.id];
    if (!target || target === p.assigned_to) return;

    // WIP reassignments go through the confirmation modal because
    // the assigned artist has actively engaged with the work; we
    // want the admin to consciously decide to take it away.
    if (p.status === 'wip') {
      setConfirming({ project: p, targetArtistId: target });
      return;
    }
    persistReassignment(p, target);
  }

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Reassign Jobs</h1>
              <p className="crm-page-sub">
                Move open jobs (draft, rejected &amp; WIP) between artists.
                Changes save per row.
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
              <h3>No open jobs to reassign</h3>
              <p>
                Approved and in-review jobs aren&apos;t shown here. Create a new
                job from the sidebar to get started.
              </p>
            </div>
          ) : artists.length === 0 ? (
            <div className="crm-empty">
              <h3>No artists available</h3>
              <p>
                You need at least one 3D artist before you can reassign jobs.
                Add one from the sidebar first.
              </p>
            </div>
          ) : (
            <table className="crm-table">
              <thead>
                <tr>
                  <th style={{ width: '28%' }}>Project</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Current artist</th>
                  <th style={{ width: '24%' }}>Reassign to</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const state = rowState[p.id] ?? { stage: 'idle' };
                  const target = selections[p.id];
                  const dirty = !!target && target !== p.assigned_to;
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong style={{ display: 'block' }}>{p.name}</strong>
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                          {p.slug}
                        </span>
                      </td>
                      <td>{p.client.name}</td>
                      <td>
                        <StatusBadge
                          status={p.status}
                          revisionCount={p.revision_count}
                        />
                        {p.status === 'wip' && (
                          // Inline note next to the badge to flag that
                          // this artist has actively started — reassigning
                          // will pop a confirmation before committing.
                          <div
                            style={{
                              color: '#92400e',
                              fontSize: 11,
                              marginTop: 4,
                            }}
                          >
                            ⚠ Artist has started work
                          </div>
                        )}
                      </td>
                      <td>
                        {p.assignee?.name || (
                          <em style={{ color: 'var(--text-faint)' }}>unassigned</em>
                        )}
                      </td>
                      <td>
                        <select
                          className="crm-input"
                          value={target || ''}
                          onChange={(e) => {
                            setSelections((prev) => ({
                              ...prev,
                              [p.id]: e.target.value,
                            }));
                            // Clear any prior saved/error indicator for this row
                            if (state.stage !== 'idle' && state.stage !== 'saving') {
                              setRow(p.id, { stage: 'idle' });
                            }
                          }}
                          disabled={state.stage === 'saving'}
                        >
                          {artists.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
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
                          disabled={!dirty || state.stage === 'saving'}
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
        </div>
      </main>

      {/* ============================== Confirmation modal (WIP reassign) ============================== */}
      {/* Only pops up for WIP rows. Cancels return the dropdown to
          its prior value; confirming fires persistReassignment(). */}
      {confirming && (
        <div
          className="crm-modal-backdrop"
          onClick={() => {
            // Don't dismiss mid-save; the row's own state shows progress.
            const rs = rowState[confirming.project.id];
            if (rs?.stage !== 'saving') setConfirming(null);
          }}
        >
          <div
            className="crm-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 480 }}
          >
            <div className="crm-modal-header">
              <div>
                <h2 className="crm-modal-title">Reassign WIP job?</h2>
                <p
                  style={{
                    margin: '4px 0 0',
                    color: 'var(--text-dim)',
                    fontSize: 13,
                  }}
                >
                  {confirming.project.client.name} · {confirming.project.name}
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

            <div
              style={{
                padding: 16,
                background: 'rgba(251, 191, 36, 0.12)',
                border: '1px solid rgba(217, 119, 6, 0.35)',
                borderRadius: 10,
                fontSize: 13,
              }}
            >
              <strong style={{ color: '#92400e' }}>
                This artist has already started work.
              </strong>
              <p style={{ margin: '4px 0 0', color: 'var(--text-dim)' }}>
                {confirming.project.assignee?.name || 'The current assignee'}
                {' '}has acknowledged the QA feedback and is actively working
                on revision {confirming.project.revision_count + 1}. Reassigning
                now will transfer the job to{' '}
                <strong>
                  {artists.find((a) => a.id === confirming.targetArtistId)
                    ?.name || 'the selected artist'}
                </strong>
                {' '}and they will see the feedback + need to re-upload.
              </p>
            </div>

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
                  const { project, targetArtistId } = confirming;
                  // Close the modal first; row-level state shows progress.
                  setConfirming(null);
                  await persistReassignment(project, targetArtistId);
                }}
              >
                Yes, reassign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
