'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import Sidebar from '../components/Sidebar';
import {
  CLIENT_FILTER_EVENT,
  getStoredClientId,
} from '../components/ClientSwitcher';
import { crmFetch, crmPath } from '../lib/client-fetch';
import {
  useTableSort,
  SortableTh,
  statusRank,
} from '../lib/use-table-sort';
import {
  rollupStatus,
  extraVariants,
  hasExtraVariants,
} from '../lib/variant-status';

// ============================================================
// Types
// ============================================================
type Project = {
  id: string;
  slug: string;
  name: string;
  // Status vocabulary post IQA/EQA split:
  //   draft         — created, awaiting assignment OR artist start
  //   wip           — artist is actively working on it
  //   qa_pending    — artist submitted; admin needs to IQA review
  //   iqa_rejected  — admin rejected; back to artist for revision
  //   client_review — admin approved; awaiting client EQA sign-off
  //   eqa_rejected  — client rejected; back to admin for triage
  //   approved      — client signed off; final
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
  glb_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  created_at: string;
  updated_at: string;
  // Raw FK to uflow_clients.id. Used by the admin sidebar's client
  // selector to filter the dashboard by brand. Joined `client.slug`
  // / `client.name` are still here for display.
  client_id: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  // Derived server-side from a join on uflow_users.role through
  // uflow_projects_created_by_fkey. True when the project was
  // created by an admin user (so admin can delete it from YTA/
  // YTS), false when it was created by a client (their workflow
  // owns deletion). Defaults to false in the server normaliser
  // when the join can't resolve, so the Delete button stays
  // hidden rather than risk an incorrect affordance.
  created_by_admin?: boolean;
  // URL of the earliest reference image, collapsed server-side
  // from the uflow_project_references join. Null when the job was
  // created without references. Drives the References column
  // thumbnail; the full set still lives on the gallery page.
  thumb_url?: string | null;
  // Colourways of this product, ordered by position. The table
  // shows one row per PRODUCT; these render as indented child
  // rows when the product is expanded.
  variants?: Variant[];
};

// A colourway. Carries its own status and revision count because
// each variant runs the pipeline independently — Grey can be
// approved while Black is still in IQA.
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

type Client = { slug: string; name: string };
type Artist = { id: string; name: string; email: string };


// ============================================================
// AdminDashboard
//
// Three URL-driven modes:
//   /admin                  → Overview (9-tab list)
//   /admin?tab=pending      → Quality Audit (IQA-only subset)
//   /admin?tab=allocation   → Job Allocation (YTA single-table view)
//
// Overview tab vocabulary (left-to-right by stage):
//   YTA          — Yet To Assign: draft + no artist
//   YTS          — Yet To Start: draft + has artist (waiting on artist click)
//   WIP          — artist actively working
//   IQA          — qa_pending: awaiting admin review
//   IQA Rejected — admin rejected; artist has feedback to revise
//   EQA          — client_review: awaiting client sign-off
//   EQA Rejected — client rejected; back to admin to triage
//   Open Jobs    — rollup of everything in motion (not approved)
//   Approved     — signed off, final
// ============================================================
export default function AdminDashboard({
  initialProjects,
  artists,
  currentUser,
}: {
  initialProjects: Project[];
  artists: Artist[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [reassigning, setReassigning] = useState<Project | null>(null);

  // ---- Delete-confirmation modal state.
  // Lives at the dashboard level so any tab can trigger it. Only
  // jobs in draft AND created by an admin are eligible — enforced
  // both here (button visibility) and server-side (DELETE
  // /api/projects/[id] re-checks). The server is the source of
  // truth; the UI guard just keeps the dashboard tidy.
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // ---- Add-variant modal state. A variant is a colourway of an
  // existing product (Black chair → Grey chair): its own model,
  // its own QA cycle, but still ONE row on this dashboard.
  const [variantTarget, setVariantTarget] = useState<Project | null>(null);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      const res = await crmFetch(`/api/projects/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteErr(data.error || 'Could not delete this job.');
        return;
      }
      // Optimistically remove from local state so the row
      // disappears immediately; router.refresh() re-syncs
      // initialProjects on next nav.
      setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
      router.refresh();
    } catch (e) {
      setDeleteErr((e as Error).message || 'Network error.');
    } finally {
      setDeleting(false);
    }
  }

  // ---- Client filter: synced with the sidebar's ClientSwitcher.
  // Read once on mount from localStorage, then listen for the
  // custom event the switcher dispatches when the admin picks a
  // new option. We also listen for the native 'storage' event so
  // a change in another tab updates this dashboard too.
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

  // Apply the client filter before bucketing into tabs. When no
  // client is selected (null), all projects pass through. We use
  // useMemo because every render would otherwise filter the array
  // again, even when neither projects nor the filter has changed.
  const visibleProjects = useMemo(() => {
    if (!selectedClientId) return projects;
    return projects.filter((p) => p.client_id === selectedClientId);
  }, [projects, selectedClientId]);

  // ----- Buckets (by stage) -----
  // Every filter reads the ROLLED-UP status, not the product's
  // own column, so a product with an outstanding colourway lands
  // in the queue that colourway needs — e.g. Black sitting in IQA
  // puts the product in the IQA tab even if the original was
  // signed off weeks ago.
  // YTA / YTS split a 'draft' row by whether an artist is on it.
  const yta = visibleProjects.filter(
    (p) => rollupStatus(p) === 'draft' && p.assigned_to === null
  );
  const yts = visibleProjects.filter(
    (p) => rollupStatus(p) === 'draft' && p.assigned_to !== null
  );
  // WIP bucket holds all three "in progress" flavours: a fresh
  // build (wip), a revision of admin's IQA feedback (iqa_wip),
  // and a revision of client's EQA feedback (eqa_wip). One tab,
  // three statuses — the StatusBadge differentiates them. The
  // tab bar stays at 9 tabs.
  const wip = visibleProjects.filter((p) => {
    const s = rollupStatus(p);
    return s === 'wip' || s === 'iqa_wip' || s === 'eqa_wip';
  });
  const iqa = visibleProjects.filter(
    (p) => rollupStatus(p) === 'qa_pending'
  );
  const iqaRejected = visibleProjects.filter(
    (p) => rollupStatus(p) === 'iqa_rejected'
  );
  const eqa = visibleProjects.filter(
    (p) => rollupStatus(p) === 'client_review'
  );
  const eqaRejected = visibleProjects.filter(
    (p) => rollupStatus(p) === 'eqa_rejected'
  );
  // Open Jobs = the rollup view: everything that hasn't been
  // signed off yet. Same row may also appear in one of the more
  // specific stage tabs above; this tab is for admins who want
  // the flat "what's still alive" picture.
  const openJobs = visibleProjects.filter(
    (p) => rollupStatus(p) !== 'approved'
  );
  const history = visibleProjects.filter(
    (p) => rollupStatus(p) === 'approved'
  );

  // Mode plumbing.
  const tabParam = searchParams?.get('tab');
  // QA mode = sidebar's "Quality Audit" link. Lands on the IQA
  // tab. We keep accepting the legacy 'pending' / 'rejected'
  // query values for back-compat with old bookmarks/links.
  const isQaMode =
    tabParam === 'pending' ||
    tabParam === 'rejected' ||
    tabParam === 'iqa' ||
    tabParam === 'iqa_rejected';
  const isAllocationMode = tabParam === 'allocation';

  // Tab key + lookup. Order matches the workflow flow.
  type Tab =
    | 'yta'
    | 'yts'
    | 'wip'
    | 'iqa'
    | 'iqa_rejected'
    | 'eqa'
    | 'eqa_rejected'
    | 'open'
    | 'history';

  // Map a URL ?tab=... value (including legacy aliases) onto the
  // current tab key. Keeps old links pointing at the right place.
  function resolveTab(raw: string | null | undefined): Tab | null {
    if (!raw) return null;
    if (raw === 'pending' || raw === 'iqa') return 'iqa';
    if (raw === 'rejected' || raw === 'iqa_rejected') return 'iqa_rejected';
    if (raw === 'eqa') return 'eqa';
    if (raw === 'eqa_rejected') return 'eqa_rejected';
    if (raw === 'yta') return 'yta';
    if (raw === 'yts') return 'yts';
    if (raw === 'wip') return 'wip';
    if (raw === 'open') return 'open';
    if (raw === 'history') return 'history';
    return null;
  }

  // QA mode shows a subset of tabs (only the admin-actionable
  // queues), so it doesn't get the full 9-tab bar. Overview gets
  // the lot.
  const qaTabs: Tab[] = ['iqa', 'iqa_rejected', 'eqa_rejected', 'history'];
  const overviewTabs: Tab[] = [
    'yta',
    'yts',
    'wip',
    'iqa',
    'iqa_rejected',
    'eqa',
    'eqa_rejected',
    'open',
    'history',
  ];
  const allowedTabs = isQaMode ? qaTabs : overviewTabs;

  const validTab = resolveTab(tabParam);
  // Default landing tab: IQA in both Overview and QA modes (the
  // admin's primary review queue). If the URL pins a different
  // tab via ?tab=..., that wins; otherwise we ignore the natural
  // first-tab fallback and land on IQA. Allocation mode skips
  // this entirely — it has no tab bar.
  const initialTab: Tab =
    validTab && allowedTabs.includes(validTab)
      ? validTab
      : allowedTabs.includes('iqa')
      ? 'iqa'
      : allowedTabs[0];
  const [tab, setTab] = useState<Tab>(initialTab);

  function refreshProjects() {
    crmFetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        if (d.projects) {
          const norm = d.projects.map(
            (
              p: Project & {
                client: Client | Client[];
                assignee: Artist | Artist[] | null;
                // The /api/projects GET shape includes the joined
                // creator role (since the latest schema update),
                // so we flatten it the same way app/admin/page.tsx
                // does on SSR — collapsing to a boolean keeps
                // ProjectTable's Delete-button guard simple.
                creator?: { role: string } | { role: string }[] | null;
                // Raw references join — collapsed to thumb_url
                // below, mirroring what app/admin/page.tsx does
                // on SSR so a refresh doesn't drop the thumbnail.
                references?: { image_url: string; created_at: string }[] | null;
                variants?: Variant[] | null;
              }
            ) => {
              const cr = Array.isArray(p.creator)
                ? p.creator[0]
                : p.creator;
              const refs = Array.isArray(p.references) ? p.references : [];
              const firstRef = [...refs].sort((x, y) =>
                x.created_at < y.created_at ? -1 : 1
              )[0];
              return {
                ...p,
                client: Array.isArray(p.client) ? p.client[0] : p.client,
                assignee: Array.isArray(p.assignee)
                  ? p.assignee[0]
                  : p.assignee,
                created_by_admin: cr?.role === 'admin',
                creator: undefined,
                thumb_url: firstRef?.image_url ?? null,
                references: undefined,
                variants: [...(p.variants ?? [])].sort(
                  (x, y) => (x.position ?? 0) - (y.position ?? 0)
                ),
              };
            }
          );
          setProjects(norm);
        }
      });
  }

  // Resolve the project list for the currently-selected tab so the
  // table render can be unified rather than duplicated nine times.
  const tabProjects: Project[] = (() => {
    switch (tab) {
      case 'yta':           return yta;
      case 'yts':           return yts;
      case 'wip':           return wip;
      case 'iqa':           return iqa;
      case 'iqa_rejected':  return iqaRejected;
      case 'eqa':           return eqa;
      case 'eqa_rejected':  return eqaRejected;
      case 'open':          return openJobs;
      case 'history':       return history;
    }
  })();

  // Per-tab metadata that drives the table layout, action column,
  // and empty-state copy. Keeping this in one place beats nine
  // near-duplicate JSX blocks.
  type TabMeta = {
    label: string;
    count: number;
    emptyMsg: string;
    showAsset: boolean;   // "View GLB" column on Approved
    showRevision: boolean; // Revision column on IQA / IQA Rejected
    // Artist column. Optional — undefined means show it. Only YTA
    // turns it off: those rows are unassigned by definition, so
    // the cell could only ever read "unassigned".
    showArtist?: boolean;
    actionKind: 'review' | 'assign' | 'reassign' | 'none';
  };
  const tabMeta: Record<Tab, TabMeta> = {
    yta: {
      label: 'YTA',
      count: yta.length,
      emptyMsg: 'No jobs waiting for allocation.',
      showAsset: false,
      showRevision: false,
      showArtist: false,
      actionKind: 'assign',
    },
    yts: {
      label: 'YTS',
      count: yts.length,
      emptyMsg: 'No jobs assigned but unstarted.',
      showAsset: false,
      showRevision: false,
      actionKind: 'reassign',
    },
    wip: {
      label: 'WIP',
      count: wip.length,
      emptyMsg: 'Nothing in progress right now.',
      showAsset: true,
      showRevision: false,
      actionKind: 'reassign',
    },
    iqa: {
      label: 'IQA',
      count: iqa.length,
      emptyMsg: 'No models waiting for internal QA.',
      showAsset: true,
      showRevision: true,
      actionKind: 'review',
    },
    iqa_rejected: {
      label: 'IQA Rejected',
      count: iqaRejected.length,
      emptyMsg: 'Nothing rejected by IQA. Artists are caught up.',
      showAsset: true,
      showRevision: true,
      // No admin action here — the ball is in the artist's court.
      // Admin's only handle on a rejected row is reassigning,
      // which they can do from the WIP tab once the artist
      // starts work; nothing useful belongs here.
      actionKind: 'none',
    },
    eqa: {
      label: 'EQA',
      count: eqa.length,
      emptyMsg: 'No models waiting for client sign-off.',
      showAsset: true,
      showRevision: true,
      actionKind: 'none',
    },
    eqa_rejected: {
      label: 'EQA Rejected',
      count: eqaRejected.length,
      emptyMsg: 'Nothing rejected by clients.',
      showAsset: true,
      showRevision: true,
      // No admin action here either — the artist picks the row up
      // via Start on their own dashboard. Admin just monitors. The
      // Revision column link still gives them one-click access to
      // the client's feedback.
      actionKind: 'none',
    },
    open: {
      label: 'Open Jobs',
      count: openJobs.length,
      emptyMsg: 'No open jobs.',
      // Heterogeneous bucket — includes YTS rows (no upload yet)
      // plus everything post-upload. Turning the column on means
      // it renders for every row, but the cell-level guard
      // `(p.approved_glb_url || p.glb_url) && …` keeps it empty
      // on the pre-upload rows. End result: View GLB appears
      // wherever a GLB actually exists.
      showAsset: true,
      showRevision: false,
      actionKind: 'none',
    },
    history: {
      label: 'Approved',
      count: history.length,
      emptyMsg: 'No approved jobs yet.',
      showAsset: true,
      showRevision: false,
      actionKind: 'none',
    },
  };

  const currentMeta = tabMeta[tab];

  // Sort state for the standalone Job Allocation (YTA) table.
  // That table is rendered inline (not via ProjectTable), so it
  // needs its own hook. Status is constant (all YTA) so we only
  // expose name/client/created as sort columns.
  const ytaSort = useTableSort(yta, {
    name: (p) => p.name,
    client: (p) => p.client.name,
    created: (p) => new Date(p.created_at),
  });

  return (
    <div className="crm-shell">
      <Sidebar
        name={currentUser.name}
        role={currentUser.role}
      />
      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">
                {isAllocationMode
                  ? 'Job Allocation'
                  : isQaMode
                  ? 'Quality Audit'
                  : 'Overview'}
              </h1>
              <p className="crm-page-sub">
                {isAllocationMode
                  ? 'Jobs created by clients that are waiting for an artist to be assigned.'
                  : isQaMode
                  ? 'Admin review queues — internal QA, rejected revisions, and client pushbacks.'
                  : 'All jobs in one place. Switch tabs to focus on what needs attention.'}
              </p>
            </div>
            {/* Download CSV — Overview only. Dumps every visible row
                (post brand filter) with the same status label the
                StatusBadge would render. Triggered client-side so
                no server round-trip is needed; the data is already
                in memory. */}
            {!isAllocationMode && !isQaMode && visibleProjects.length > 0 && (
              <button
                type="button"
                className="crm-btn crm-btn-secondary"
                onClick={() =>
                  downloadProjectsCsv(
                    visibleProjects,
                    selectedClientId ? 'overview-filtered' : 'overview'
                  )
                }
                title="Download every visible project as a CSV with name + status"
              >
                Download CSV
              </button>
            )}
          </header>

          {/* ============================== Job Allocation mode ============================== */}
          {/* Standalone view: no tab bar, just the YTA table. */}
          {isAllocationMode && (
            yta.length === 0 ? (
              <EmptyMini message="No jobs waiting for allocation." />
            ) : (
              <table className="crm-table">
                <thead>
                  <tr>
                    <SortableTh label="Project" sortKey="name" sort={ytaSort.sort} onSort={ytaSort.onSort} />
                    <th>References</th>
                    <SortableTh label="Client" sortKey="client" sort={ytaSort.sort} onSort={ytaSort.onSort} />
                    <SortableTh label="Created" sortKey="created" sort={ytaSort.sort} onSort={ytaSort.onSort} />
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {ytaSort.sorted.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong style={{ display: 'block' }}>{p.name}</strong>
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                          {p.slug}
                        </span>
                      </td>
                      <td>
                        <ReferenceThumb project={p} />
                      </td>
                      <td>{p.client.name}</td>
                      <DateCell value={p.created_at} />
                      <td>
                        <span
                          className="crm-badge crm-badge-draft"
                          title="Yet to assign"
                        >
                          YTA
                        </span>
                      </td>
                      <td>
                        <div
                          style={{
                            display: 'inline-flex',
                            gap: 8,
                            alignItems: 'center',
                            justifyContent: 'center',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <a
                            className="crm-link"
                            onClick={() => setReassigning(p)}
                          >
                            Assign
                          </a>
                          {/* Delete is gated on `created_by_admin`
                              — admin can only delete jobs admins
                              spun up, not jobs raised by clients
                              (their workflow owns deletion). The
                              server re-checks this independently. */}
                          {p.created_by_admin && (
                            <button
                              type="button"
                              className="crm-btn crm-btn-ghost-danger crm-btn-icon"
                              onClick={() => {
                                setDeleteErr(null);
                                setDeleteTarget(p);
                              }}
                              title="Delete this job"
                              style={{ whiteSpace: 'nowrap' }}
                            >
                              <Trash2 size={14} strokeWidth={1.75} />
                              <span>Delete</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* ============================== Tab bar ============================== */}
          {/* Hidden in allocation mode — that view has no tabs.
              The bar can be wide (9 tabs on Overview); we let it
              wrap onto a second row on narrow viewports rather
              than introducing horizontal scroll. */}
          {!isAllocationMode && (
            <div className="crm-tabs" role="tablist" aria-label="Job lists">
              {allowedTabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={`crm-tab ${tab === t ? 'is-active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  {tabMeta[t].label}
                  <span className="crm-tab-count">{tabMeta[t].count}</span>
                </button>
              ))}
            </div>
          )}

          {/* ============================== Per-tab body ============================== */}
          {!isAllocationMode && (
            tabProjects.length === 0 ? (
              <EmptyMini message={currentMeta.emptyMsg} />
            ) : (
              <ProjectTable
                projects={tabProjects}
                meta={currentMeta}
                onReview={(p) => router.push(crmPath(`/admin/qa/${p.id}`))}
                onAssign={(p) => setReassigning(p)}
                // Delete is wired in for every tab; the per-row
                // guard inside ProjectTable still only renders
                // the button on draft + created_by_admin rows.
                // Plumbing it everywhere means future tabs can
                // surface the action without another prop dance.
                onDelete={(p) => {
                  setDeleteErr(null);
                  setDeleteTarget(p);
                }}
                onAddVariant={(p) => setVariantTarget(p)}
              />
            )
          )}
        </div>
      </main>

      {/* ============================== Modals ============================== */}
      {reassigning && (
        <ReassignModal
          project={reassigning}
          artists={artists}
          onClose={() => setReassigning(null)}
          onDone={() => {
            setReassigning(null);
            refreshProjects();
          }}
        />
      )}

      {variantTarget && (
        <AddVariantModal
          project={variantTarget}
          artists={artists}
          onClose={() => setVariantTarget(null)}
          onDone={() => {
            setVariantTarget(null);
            refreshProjects();
            router.refresh();
          }}
        />
      )}

      {/* Delete-confirmation modal. Same pattern the client
          dashboard uses — backdrop click + Cancel button both
          dismiss (unless a delete is in flight), and the action
          button uses the danger style so the destructive intent
          is unmistakable. */}
      {deleteTarget && (
        <div
          className="crm-modal-backdrop"
          onClick={() => {
            if (!deleting) {
              setDeleteTarget(null);
              setDeleteErr(null);
            }
          }}
        >
          <div
            className="crm-modal"
            style={{ maxWidth: 480 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="crm-modal-header">
              <h2 className="crm-modal-title">Delete this job?</h2>
              <button
                type="button"
                className="crm-modal-close"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteErr(null);
                }}
                disabled={deleting}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p style={{ marginTop: 0, color: 'var(--text-dim)' }}>
              <strong style={{ color: 'var(--text)' }}>
                {deleteTarget.name}
              </strong>{' '}
              will be permanently removed, along with any reference
              images that were attached. This can’t be undone.
            </p>
            {deleteErr && <div className="crm-error">{deleteErr}</div>}
            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                marginTop: 20,
              }}
            >
              <button
                type="button"
                className="crm-btn crm-btn-secondary"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteErr(null);
                }}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="crm-btn crm-btn-danger"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// CSV export helper.
//
// Produces a two-column CSV — Project name + Status — for every
// row in `projects`. Status is derived using the same vocabulary
// the StatusBadge renders, including the YTA/YTS split for
// drafts, so what's in the file matches what's on screen.
//
// Triggered client-side via a Blob + anchor.download so there's
// no server round-trip. CSV values are escaped per RFC 4180:
// every value is quoted, embedded quotes are doubled. A UTF-8
// BOM is prepended so Excel opens it correctly when a project
// name contains non-ASCII characters.
// ============================================================
function adminStatusLabel(p: Project): string {
  // Same derived value the on-screen badge uses, so the export
  // matches what the admin is looking at.
  const status = rollupStatus(p);
  if (status === 'draft') {
    return p.assigned_to ? 'YTS' : 'YTA';
  }
  if (status === 'qa_pending') return 'IQA';
  // Rejection labels match the on-screen StatusBadge (label only,
  // no count). The Revision column carries the round number
  // separately, so duplicating it here would be misleading
  // — the CSV reader would think the count was part of the
  // status itself.
  if (status === 'iqa_rejected') return 'IQA Rejected';
  if (status === 'eqa_rejected') return 'EQA Rejected';
  // The three WIP flavours export with their own labels so the
  // CSV mirrors the dashboard exactly.
  if (status === 'iqa_wip') return 'IQA WIP';
  if (status === 'eqa_wip') return 'EQA WIP';
  if (status === 'wip') return 'WIP';
  if (status === 'client_review') return 'EQA';
  return 'Approved';
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadProjectsCsv(projects: Project[], suffix: string) {
  const header = ['Project', 'Status'];
  const rows = projects.map((p) => [p.name, adminStatusLabel(p)]);
  // \uFEFF = UTF-8 BOM so Excel detects the encoding correctly.
  const csv =
    '\uFEFF' +
    [header, ...rows]
      .map((row) => row.map(csvEscape).join(','))
      .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Date stamp the filename so successive exports don't collide.
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `uflow-${suffix}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
// Unified project table for every admin tab.
//
// Columns adapt to the tab's meta:
//   Artist | Project | References | Client | [Revision]
//          | Created | Updated   | [Asset]  | Status | [Action]
//
// `actionKind` decides the right-most action column:
//   review   — go to /admin/qa/[id] (IQA, EQA Rejected)
//   assign   — open the assign modal (YTA)
//   reassign — open the reassign modal (YTS, WIP, IQA Rejected)
//   none     — no action column
// ============================================================
function ProjectTable({
  projects,
  meta,
  onReview,
  onAssign,
  onDelete,
  onAddVariant,
}: {
  projects: Project[];
  meta: {
    label: string;
    showAsset: boolean;
    showRevision: boolean;
    showArtist?: boolean;
    actionKind: 'review' | 'assign' | 'reassign' | 'none';
  };
  onReview: (p: Project) => void;
  onAssign: (p: Project) => void;
  onDelete?: (p: Project) => void;
  onAddVariant?: (p: Project) => void;
}) {
  // The Action column used to be hidden on tabs with actionKind
  // 'none'. Add variant is available on every row regardless of
  // stage — a colourway can be commissioned off an approved
  // product as easily as a draft one — so the column now always
  // renders and `actionKind` only governs the stage-specific
  // action sitting next to it.
  const hasAction = true;

  // Default the Artist column ON so only the tab that explicitly
  // opts out (YTA) loses it.
  const showArtist = meta.showArtist !== false;

  // Which products have their colourways expanded. Collapsed by
  // default so the table still reads as one row per product —
  // variants are detail, not the primary unit of work here.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Column count for the child rows' colSpan. Must track the
  // conditional headers above or the indented row won't span the
  // full table width.
  const columnCount =
    (showArtist ? 1 : 0) + // Artist
    1 + // Project
    1 + // References
    1 + // Client
    (meta.showRevision ? 1 : 0) +
    1 + // Created
    1 + // Uploaded
    (meta.showAsset ? 1 : 0) +
    1 + // Status
    (hasAction ? 1 : 0);

  // Per-column sort. Artist/Project/Client/Revision sort by their
  // natural value; Created/Updated chronologically; Status by
  // pipeline rank. Cycles asc -> desc -> off (default order).
  const { sorted, sort, onSort } = useTableSort(projects, {
    artist: (p) => p.assignee?.name ?? null,
    name: (p) => p.name,
    client: (p) => p.client.name,
    revision: (p) => p.revision_count,
    created: (p) => new Date(p.created_at),
    updated: (p) => new Date(p.updated_at),
    status: (p) => statusRank(rollupStatus(p)),
  });

  return (
    <table className="crm-table">
      <thead>
        <tr>
          {showArtist && (
            <SortableTh label="Artist" sortKey="artist" sort={sort} onSort={onSort} />
          )}
          <SortableTh label="Project" sortKey="name" sort={sort} onSort={onSort} />
          <th>References</th>
          <SortableTh label="Client" sortKey="client" sort={sort} onSort={onSort} />
          {meta.showRevision && (
            <SortableTh label="Revision" sortKey="revision" sort={sort} onSort={onSort} />
          )}
          <SortableTh label="Created" sortKey="created" sort={sort} onSort={onSort} />
          <SortableTh label="Uploaded" sortKey="updated" sort={sort} onSort={onSort} />
          {meta.showAsset && <th>Asset</th>}
          <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
          {hasAction && <th>Action</th>}
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <Fragment key={p.id}>
          <tr>
            {showArtist && (
              <td>
                {p.assignee?.name || (
                  <em style={{ color: 'var(--text-faint)' }}>unassigned</em>
                )}
              </td>
            )}
            <td>
              {/* Disclosure toggle. The parent row already stands
                  for the primary variant, so only the ADDITIONAL
                  colourways are worth expanding to — a product
                  with just its backfilled 'Original' gets no
                  toggle at all. */}
              {hasExtraVariants(p.variants) ? (
                (() => {
                  const extras = extraVariants(p.variants);
                  return (
                <button
                  type="button"
                  onClick={() => toggleExpanded(p.id)}
                  aria-expanded={expanded.has(p.id)}
                  aria-label={
                    expanded.has(p.id) ? 'Hide variants' : 'Show variants'
                  }
                  title={`${extras.length} variant${
                    extras.length === 1 ? '' : 's'
                  }`}
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
                      transform: expanded.has(p.id)
                        ? 'rotate(90deg)'
                        : 'none',
                      transition: 'transform 0.12s',
                      display: 'inline-block',
                    }}
                  >
                    ▶
                  </span>
                  <span>
                    <strong style={{ display: 'block' }}>{p.name}</strong>
                    <span
                      style={{ color: 'var(--text-faint)', fontSize: 12 }}
                    >
                      {p.slug} · +{extras.length} variant
                      {extras.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
                  );
                })()
              ) : (
                <>
                  <strong style={{ display: 'block' }}>{p.name}</strong>
                  <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                    {p.slug}
                  </span>
                </>
              )}
            </td>
            <td>
              <ReferenceThumb project={p} />
            </td>
            <td>{p.client.name}</td>
            {meta.showRevision && (
              <td>
                {p.revision_count >= 1 ? (
                  <a
                    href={crmPath(
                      // Open the gallery filtered to the current
                      // revision. The source param picks the
                      // feedback table:
                      //   eqa_rejected → client's screenshots
                      //                 (their reason for pushing back)
                      //   everything else → admin's screenshots
                      //                 (the IQA feedback to the
                      //                 artist; relevant on iqa_rejected
                      //                 and historical on qa_pending /
                      //                 client_review / approved rows)
                      `/projects/${p.id}/feedback?revision=${p.revision_count}${
                        p.status === 'eqa_rejected' ? '&source=client' : ''
                      }`
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="crm-link"
                    title="View feedback for this revision"
                  >
                    {p.revision_count}
                  </a>
                ) : (
                  // No rejections yet — nothing to click through
                  // to. Render the number as plain text so the
                  // column still aligns.
                  p.revision_count
                )}
              </td>
            )}
            <DateCell value={p.created_at} />
            <DateCell value={p.updated_at} withTime />
            {meta.showAsset && (
              <td>
                {(p.approved_glb_url || p.glb_url) && (
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
            )}
            <td>
              <StatusBadge
                status={rollupStatus(p)}
                revisionCount={p.revision_count}
                assigned={p.assigned_to !== null}
              />
            </td>
            {hasAction && (
              <td>
                <div
                  style={{
                    display: 'inline-flex',
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    // Wrap rather than overflow: three controls
                    // (Review/Assign, Add variant, Delete) can
                    // exceed the column on a narrow window, and
                    // nowrap on the container clipped the last
                    // one off the right edge. Individual controls
                    // still keep their own nowrap so no single
                    // label breaks mid-word.
                    flexWrap: 'wrap',
                    rowGap: 4,
                  }}
                >
                  {meta.actionKind === 'review' && (
                    <a
                      className="crm-link"
                      onClick={() => onReview(p)}
                    >
                      Review
                    </a>
                  )}
                  {meta.actionKind === 'assign' && (
                    <a
                      className="crm-link"
                      onClick={() => onAssign(p)}
                    >
                      Assign
                    </a>
                  )}
                  {meta.actionKind === 'reassign' && (
                    <a
                      className="crm-link"
                      onClick={() => onAssign(p)}
                    >
                      Reassign
                    </a>
                  )}
                  {/* Add variant — available on every row. Creates
                      a sibling colourway that runs its own QA
                      cycle but stays under this product's row. */}
                  {onAddVariant && (
                    <a
                      className="crm-link"
                      onClick={() => onAddVariant(p)}
                      title="Add a colour variant of this product"
                      style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      Add variant
                    </a>
                  )}
                  {/* Delete — only shown for jobs admin created
                      that are still in draft. Both conditions are
                      hard-checked on the server too; this is the
                      UX layer hiding the affordance for cases
                      where the call would 404/409. */}
                  {onDelete &&
                    p.status === 'draft' &&
                    p.created_by_admin && (
                      <button
                        type="button"
                        className="crm-btn crm-btn-ghost-danger crm-btn-icon"
                        onClick={() => onDelete(p)}
                        title="Delete this job"
                        // Icon-only. The text label pushed the
                        // column past the viewport once Add
                        // variant joined the row; the tooltip and
                        // aria-label carry the meaning instead.
                        aria-label="Delete this job"
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    )}
                </div>
              </td>
            )}
          </tr>

          {/* ---- Variant child rows ----
              Indented under their product, showing each
              colourway's own status and asset. Rendered as real
              table rows (not a nested table) so the columns stay
              aligned with the parent. */}
          {expanded.has(p.id) &&
            extraVariants(p.variants).map((v) => (
              <tr
                key={v.id}
                style={{ background: 'var(--surface-2, transparent)' }}
              >
                {showArtist && <td />}
                <td style={{ paddingLeft: 28 }}>
                  <span
                    style={{ color: 'var(--text-faint)', marginRight: 6 }}
                    aria-hidden
                  >
                    └
                  </span>
                  <strong style={{ fontWeight: 600 }}>{v.name}</strong>
                </td>
                {/* References are shared across colourways, so
                    there's nothing variant-specific to show. */}
                <td />
                <td />
                {meta.showRevision && (
                  <td style={{ color: 'var(--text-dim)' }}>
                    {v.revision_count}
                  </td>
                )}
                <td />
                <DateCell value={v.updated_at} withTime />
                {meta.showAsset && (
                  <td>
                    {(v.approved_glb_url || v.glb_url) && (
                      <a
                        className="crm-link"
                        href={v.approved_glb_url || v.glb_url || '#'}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View GLB
                      </a>
                    )}
                  </td>
                )}
                <td>
                  <StatusBadge
                    status={v.status}
                    revisionCount={v.revision_count}
                    assigned
                  />
                </td>
                {hasAction && <td />}
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

// ============================================================
// References cell — thumbnail of the first reference image,
// hyperlinked to the full gallery in a new tab (same target the
// old "View" text link used).
//
// `thumb_url` is collapsed server-side from the references join,
// so there's no per-row fetch here. When a job was created with
// no references there's nothing to show, so we fall back to a
// dim em-dash — deliberately NOT a link, since the gallery would
// just render its empty state.
//
// The <img> is intentionally raw rather than next/image: these
// are remote Cloudinary/R2 URLs on arbitrary hosts, and adding
// them to next.config remotePatterns is a bigger change than
// this column warrants.
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
// Small UI helpers
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

// Format a date string for table cells. Date-only by default; pass
// withTime to include the time (used by the "Uploaded" column).
// Returns an em-dash when the value is missing so the column still
// shows a placeholder instead of collapsing.
function fmtDate(
  iso: string | null | undefined,
  withTime = false
): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : d.toLocaleDateString();
}

// Reusable date cell. The em-dash version (no value tracked) is
// styled dimmer so the columns with real data lead the eye.
function DateCell({
  value,
  withTime,
}: {
  value: string | null | undefined;
  withTime?: boolean;
}) {
  if (!value) {
    return (
      <td style={{ color: 'var(--text-faint)' }}>—</td>
    );
  }
  return (
    <td style={{ color: 'var(--text-dim)' }}>{fmtDate(value, withTime)}</td>
  );
}

// ============================================================
// Reassign modal — also used for first-time assignment from YTA.
// Title and submit button label switch based on whether the
// project already has an artist.
// ============================================================
function ReassignModal({
  project,
  artists,
  onClose,
  onDone,
}: {
  project: Project;
  artists: Artist[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [target, setTarget] = useState(project.assigned_to || artists[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const res = await crmFetch(`/api/projects/${project.id}/assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_to: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed.');
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="crm-modal-backdrop" onClick={onClose}>
      <div className="crm-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="crm-modal-header">
          <div>
            <h2 className="crm-modal-title">
              {project.assigned_to ? 'Reassign' : 'Assign'}
            </h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>
              {project.client.name} · {project.name}
            </p>
          </div>
          <button className="crm-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="crm-form-group">
          <label className="crm-label">Assign to</label>
          <select
            className="crm-input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {artists.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.email})
              </option>
            ))}
          </select>
        </div>

        {err && <div className="crm-error">{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="crm-btn crm-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="crm-btn" onClick={submit} disabled={busy || !target}>
            {busy ? 'Saving…' : project.assigned_to ? 'Reassign' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Add-variant modal
//
// Creates a colourway of an existing product (Black chair → Grey
// chair). The variant is a row in uflow_project_variants, NOT a
// new project — the dashboard keeps showing one row per product,
// so nothing appears in the table when this succeeds.
//
// The variant starts in 'draft' and inherits the product's artist
// by default (resolved server-side from the primary variant). It
// then runs the nine-state machine independently, so this new
// colourway can be approved while its sibling is still in IQA.
//
// Reference images are deliberately absent here: they belong to
// the product and are uploaded in one shot at job creation.
// ============================================================
function AddVariantModal({
  project,
  artists,
  onClose,
  onDone,
}: {
  project: Project;
  artists: Artist[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Who the variant will land with. The server resolves this off
  // the primary variant; we mirror the product's assignee here so
  // the admin can see the outcome before committing.
  const inherited =
    project.assignee ??
    artists.find((a) => a.id === project.assigned_to) ??
    null;

  // Preview of the slug the server will derive, so a name like
  // "Light Grey" visibly becomes "light-grey" before submitting.
  const slugPreview = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  async function submit() {
    if (!name.trim() || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await crmFetch(`/api/projects/${project.id}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || 'Could not add the variant.');
        return;
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="crm-modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="crm-modal"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="crm-modal-header">
          <div>
            <h2 className="crm-modal-title">Add variant</h2>
            <p
              style={{
                margin: '4px 0 0',
                color: 'var(--text-dim)',
                fontSize: 13,
              }}
            >
              {project.client.name} · {project.name}
            </p>
          </div>
          <button
            className="crm-modal-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="crm-form-group">
          <label className="crm-label">Variant name</label>
          <input
            className="crm-input"
            value={name}
            autoFocus
            placeholder="e.g. Grey"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          {slugPreview && (
            <p
              style={{
                margin: '6px 0 0',
                color: 'var(--text-faint)',
                fontSize: 12,
              }}
            >
              Slug: {slugPreview}
            </p>
          )}
        </div>

        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          {inherited ? (
            <>
              Goes to <strong>{inherited.name}</strong>, inherited from this
              product. It&apos;ll appear on their dashboard as a new job to
              start, needing its own zip.
            </>
          ) : (
            <>
              This product has no artist yet, so the variant lands in YTA for
              allocation.
            </>
          )}{' '}
          Reference images are shared across variants — nothing to re-upload.
        </p>

        {err && <div className="crm-error">{err}</div>}

        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginTop: 16,
          }}
        >
          <button
            className="crm-btn crm-btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="crm-btn"
            onClick={submit}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Adding…' : 'Add variant'}
          </button>
        </div>
      </div>
    </div>
  );
}
