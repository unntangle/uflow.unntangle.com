'use client';

import { useMemo, useState } from 'react';
import Sidebar from '../../../components/Sidebar';
import { crmPath } from '../../../lib/client-fetch';
import { useTableSort, SortableTh } from '../../../lib/use-table-sort';

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
  const [projects] = useState<Project[]>(initialProjects);
  const [query, setQuery] = useState('');

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
                        <a
                          href={crmPath(`/admin/qa/${p.id}/references`)}
                          target="_blank"
                          rel="noreferrer"
                          className="crm-link"
                        >
                          View
                        </a>
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
                        {(p.approved_glb_url || p.glb_url) && (
                          <a
                            className="crm-link"
                            href={p.approved_glb_url || p.glb_url!}
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
  if (p.status === 'approved') return 'Approved';
  if (p.status === 'client_review') return 'EQA';
  if (p.status === 'eqa_rejected' || p.has_client_rejection) return 'EQA Rejected';
  return 'Open';
}

function ClientStatusPill({ label }: { label: string }) {
  let cls = 'crm-badge-draft';
  if (label === 'Approved') cls = 'crm-badge-approved';
  else if (label === 'EQA Rejected') cls = 'crm-badge-rejected';
  else if (label === 'EQA') cls = 'crm-badge-client-review';
  return <span className={`crm-badge ${cls}`}>{label}</span>;
}
