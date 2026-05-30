'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
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
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
};

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

  // Hard-delete (purge) state. `confirmTarget` is the row pending
  // confirmation; `deletingId` disables the dialog while the
  // request is in flight; `delError` surfaces a failure inline.
  const [confirmTarget, setConfirmTarget] = useState<Project | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

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
        p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)
      );
    });
  }, [projects, selectedClientId, query]);

  // Column accessors for sorting. Created/Updated sort
  // chronologically (Date), Status sorts by pipeline rank, the
  // rest are plain strings sorted A-Z (case-insensitive).
  const { sorted, sort, onSort } = useTableSort(visible, {
    name: (p) => p.name,
    artist: (p) => p.assignee?.name ?? null,
    client: (p) => p.client.name,
    created: (p) => new Date(p.created_at),
    updated: (p) => new Date(p.updated_at),
    status: (p) => statusRank(p.status),
  });

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">List Jobs</h1>
              <p className="crm-page-sub">
                Every job across all statuses. Use the Edit column to
                rename a job or update its brief.
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
              placeholder="Search by name or slug…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

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
                  <SortableTh label="Artist" sortKey="artist" sort={sort} onSort={onSort} />
                  <SortableTh label="Client" sortKey="client" sort={sort} onSort={onSort} />
                  <SortableTh label="Created" sortKey="created" sort={sort} onSort={onSort} />
                  <SortableTh label="Updated" sortKey="updated" sort={sort} onSort={onSort} />
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
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
                      {p.assignee?.name || (
                        <em style={{ color: 'var(--text-faint)' }}>
                          unassigned
                        </em>
                      )}
                    </td>
                    <td>{p.client.name}</td>
                    <td style={{ color: 'var(--text-dim)' }}>
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ color: 'var(--text-dim)' }}>
                      {new Date(p.updated_at).toLocaleDateString()}
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
                ))}
              </tbody>
            </table>
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
