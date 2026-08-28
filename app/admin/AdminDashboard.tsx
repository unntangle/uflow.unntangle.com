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
  anyVariantIn,
  allVariantsApproved,
  sortVariants,
  effectiveUpdatedAt,
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
  //   on_hold       — client paused it; out of every queue until resumed
  status:
    | 'draft'
    | 'qa_pending'
    | 'iqa_rejected'
    | 'eqa_rejected'
    | 'wip'
    | 'iqa_wip'
    | 'eqa_wip'
    | 'client_review'
    | 'approved'
    | 'on_hold';
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
//   Open Jobs    — rollup of everything in motion (not approved,
//                  not held)
//   Hold         — On Hold by Client: paused, out of every queue
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
  // Queues use ANY-variant membership, not the roll-up: a product
  // with Black awaiting QA and Original mid-revision belongs in
  // BOTH the IQA and WIP tabs, because two different people each
  // have something to do on it. Bucketing on the roll-up would
  // hide the variant awaiting review entirely.
  //
  // Consequence: one product can appear in several tabs at once.
  // That's accurate rather than duplication — the tab counts now
  // measure outstanding work, not a partition of the job list.
  //
  // Approved is the exception: it needs EVERY colourway signed
  // off, which is what the roll-up gives.
  const yta = visibleProjects.filter(
    (p) => anyVariantIn(p, ['draft']) && p.assigned_to === null
  );
  const yts = visibleProjects.filter(
    (p) => anyVariantIn(p, ['draft']) && p.assigned_to !== null
  );
  const wip = visibleProjects.filter((p) =>
    anyVariantIn(p, ['wip', 'iqa_wip', 'eqa_wip'])
  );
  const iqa = visibleProjects.filter((p) =>
    anyVariantIn(p, ['qa_pending'])
  );
  const iqaRejected = visibleProjects.filter((p) =>
    anyVariantIn(p, ['iqa_rejected'])
  );
  const eqa = visibleProjects.filter((p) =>
    anyVariantIn(p, ['client_review'])
  );
  const eqaRejected = visibleProjects.filter((p) =>
    anyVariantIn(p, ['eqa_rejected'])
  );
  // Hold and Open Jobs are DISJOINT: any paused colourway puts
  // the product under Hold and takes it out of Open Jobs
  // entirely. Not "every colourway paused" — that let a product
  // with one held colourway and one live one sit in Open Jobs
  // wearing an "On Hold by Client" badge, which reads as a
  // contradiction whatever the underlying data says.
  //
  // The trade-off is deliberate: a product with Black held and
  // Grey in WIP disappears from Open Jobs even though Grey is
  // live work. It's still in the WIP tab, which is where someone
  // looking for work to do would find it, and Open Jobs stays
  // readable as "jobs actually moving".
  const hold = visibleProjects.filter((p) => anyVariantIn(p, ['on_hold']));
  // Open Jobs = the rollup view: everything not fully signed off
  // and not blocked. Both exclusions exist so the count means
  // something — it should be work someone can act on today.
  const openJobs = visibleProjects.filter(
    (p) => !allVariantsApproved(p) && !anyVariantIn(p, ['on_hold'])
  );
  const history = visibleProjects.filter((p) => allVariantsApproved(p));

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
    | 'hold'
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
    if (raw === 'hold' || raw === 'on_hold') return 'hold';
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
    // Sits directly after Open Jobs: the two answer the same
    // question from opposite sides (what's live vs. what's
    // blocked), and Open Jobs' count only makes sense once you
    // can see what was subtracted from it.
    'hold',
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
      case 'hold':          return hold;
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
    // The statuses this tab is a queue FOR. Rows are bucketed with
    // anyVariantIn, so a mixed product lands here because ONE of
    // its colourways is in one of these states — and that is the
    // status its badge must show. Without this the badge came from
    // rollupStatus (least advanced colourway), which is a
    // different variant entirely: a job could sit under IQA
    // wearing a WIP badge.
    //
    // Left undefined on the two tabs that aren't stage queues:
    // Open Jobs (everything in motion) and Approved (needs every
    // colourway done). Those fall back to the roll-up, which is
    // the right summary there.
    queueStatuses?: Project['status'][];
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
      queueStatuses: ['draft'],
      actionKind: 'assign',
    },
    yts: {
      label: 'YTS',
      count: yts.length,
      emptyMsg: 'No jobs assigned but unstarted.',
      showAsset: false,
      showRevision: false,
      queueStatuses: ['draft'],
      actionKind: 'reassign',
    },
    wip: {
      label: 'WIP',
      count: wip.length,
      emptyMsg: 'Nothing in progress right now.',
      showAsset: true,
      showRevision: false,
      queueStatuses: ['wip', 'iqa_wip', 'eqa_wip'],
      actionKind: 'reassign',
    },
    iqa: {
      label: 'IQA',
      count: iqa.length,
      emptyMsg: 'No models waiting for internal QA.',
      showAsset: true,
      showRevision: true,
      queueStatuses: ['qa_pending'],
      actionKind: 'review',
    },
    iqa_rejected: {
      label: 'IQA Rejected',
      count: iqaRejected.length,
      emptyMsg: 'Nothing rejected by IQA. Artists are caught up.',
      showAsset: true,
      showRevision: true,
      queueStatuses: ['iqa_rejected'],
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
      queueStatuses: ['client_review'],
      actionKind: 'none',
    },
    eqa_rejected: {
      label: 'EQA Rejected',
      count: eqaRejected.length,
      emptyMsg: 'Nothing rejected by clients.',
      showAsset: true,
      showRevision: true,
      queueStatuses: ['eqa_rejected'],
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
    hold: {
      label: 'Hold',
      count: hold.length,
      emptyMsg: 'Nothing on hold. No client has paused a job.',
      // Held jobs can be at any stage, so some have a delivered
      // model and some don't. The cell-level guard keeps the
      // column empty on the ones that don't — same arrangement
      // Open Jobs uses.
      showAsset: true,
      // Revision is on: a job parked mid-revision is exactly the
      // one where an admin wants the feedback link to hand when
      // the client asks what state it was left in.
      showRevision: true,
      queueStatuses: ['on_hold'],
      // No action. A hold is released from the Change Status page,
      // not from here — resuming has to name the stage the job
      // goes back to, and that's a confirmation dialog, not a
      // one-click link in a table cell.
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
  // The original's status — the same value the on-screen row
  // badges, so the export matches what the admin is looking at.
  // Colourways aren't broken out: the CSV is one line per
  // product, same as the table.
  const status = primaryStatus(p);
  if (status === 'draft') {
    return p.assigned_to ? 'YTS' : 'YTA';
  }
  // Matches the badge wording exactly, same rule as the rest of
  // this function — a CSV that said just "Hold" would not be
  // searchable against what the dashboard shows.
  if (status === 'on_hold') return 'On Hold by Client';
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

// ============================================================
// Row helpers
//
// uflow_projects.status has been legacy since the variants
// migration — only the single-model path writes it, so it goes
// stale the moment a colourway moves on its own. Everything a
// row renders is derived from the colourway rows instead.
//
// primaryStatus is the ORIGINAL's status, used by the CSV export
// (one line per product, so it needs a single value).
// displayStatuses is what the table renders — see below.
// ============================================================
function primaryVariant(p: Project): Variant | null {
  return (p.variants ?? []).find((v) => v.is_primary) ?? null;
}

// Falls back to the product's own columns when there are no
// variant rows at all (pre-migration data, or a backfill that
// didn't run), so those rows behave exactly as they used to.
function primaryStatus(p: Project): Project['status'] {
  return primaryVariant(p)?.status ?? p.status;
}

// ------------------------------------------------------------
// leadVariant
//
// The colourway a row LEADS WITH inside a given tab: the first
// one in that tab's stage, falling back to the primary.
//
// A product lands in a tab because ANY colourway is in that
// tab's stage (anyVariantIn), and that colourway is often not
// the original. Leading with the original then puts a WIP job
// under IQA — the row names and badges something the tab isn't
// asking about. So the row leads with the colourway that put it
// there; the others are one click away.
//
// Outside a stage queue (Open Jobs, Approved) there's nothing to
// match on, so the primary leads — the product's own identity.
// Returns null when there are no variant rows at all
// (pre-migration data), and callers fall back to the product's
// own columns.
// ------------------------------------------------------------
function leadVariant(
  p: Project,
  queueStatuses?: Project['status'][]
): Variant | null {
  const vs = sortVariants(p.variants ?? []) as Variant[];
  if (vs.length === 0) return null;
  const qs = queueStatuses ?? [];
  return (
    vs.find((v) => qs.includes(v.status)) ??
    vs.find((v) => v.is_primary) ??
    vs[0]
  );
}

// ------------------------------------------------------------
// uploadedAt
//
// The timestamp the "Uploaded" column shows for a product row.
//
// It is NOT uflow_projects.updated_at, which is what this column
// used to read. Since the variants migration, finalize-upload
// writes ONLY the targeted colourway ("When a variant was
// targeted we write ONLY the variant row"), so the product's own
// timestamp freezes at whatever last touched the product itself
// — usually the day it was created. That's why a row could show
// an Uploaded date older than the file its own View GLB opens.
//
// Inside a stage queue the row leads with one colourway and
// badges that colourway's status, revision and asset, so the
// date has to come from the same row — otherwise "Uploaded"
// describes a different file than the rest of the line does.
//
// Outside a stage queue (Open Jobs, Approved) the row stands for
// the whole product, so the honest answer is the newest stamp
// anywhere on it. effectiveUpdatedAt already encodes that rule,
// including the fallback for pre-migration rows with no variants.
//
// Returns null when there's no usable timestamp at all, so the
// cell renders an em-dash rather than 01/01/1970.
// ------------------------------------------------------------
function uploadedAt(
  p: Project,
  lead: Variant | null,
  queueStatuses?: Project['status'][]
): string | null {
  if (queueStatuses && queueStatuses.length > 0 && lead) {
    return lead.updated_at ?? null;
  }
  const ms = effectiveUpdatedAt(p);
  return ms ? new Date(ms).toISOString() : null;
}

// True when every colourway is still a draft, i.e. nothing has
// been started anywhere. Delete purges the WHOLE job, so it can't
// key off one colourway.
function allVariantsDraft(p: Project): boolean {
  const vs = p.variants ?? [];
  if (vs.length === 0) return p.status === 'draft';
  return vs.every((v) => v.status === 'draft');
}

// A colourway's display name. The primary's stored name is a
// backfill artefact — the variants migration inserted every
// pre-existing project as a variant literally called 'Original'.
// The primary variant IS the product, so show the product's name.
function variantLabel(p: Project, v: Variant): string {
  return v.is_primary ? p.name : v.name;
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
}: {
  projects: Project[];
  meta: {
    label: string;
    showAsset: boolean;
    showRevision: boolean;
    showArtist?: boolean;
    queueStatuses?: Project['status'][];
    actionKind: 'review' | 'assign' | 'reassign' | 'none';
  };
  onReview: (p: Project) => void;
  onAssign: (p: Project) => void;
  onDelete?: (p: Project) => void;
}) {
  // Tabs whose rows carry no admin action (IQA Rejected, EQA,
  // EQA Rejected, Open Jobs, Approved) drop the column entirely
  // rather than rendering a row of empty cells. Delete only ever
  // appears on draft rows, which live in the assign/reassign
  // tabs, so it's covered by the same condition.
  const hasAction = meta.actionKind !== 'none';

  // Default the Artist column ON so only the tab that explicitly
  // opts out (YTA) loses it.
  const showArtist = meta.showArtist !== false;

  // Which products the user has expanded. Collapsed by default —
  // the status cell now badges every stage the product occupies,
  // so a split row explains itself without being opened.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Per-column sort. Artist/Project/Client/Revision sort by their
  // natural value; Created/Updated chronologically; Status by
  // pipeline rank. Cycles asc -> desc -> off (default order).
  //
  // Status and Revision sort on the LEADING colourway — the one
  // the row shows — rather than the roll-up or the stale product
  // columns behind it.
  const { sorted, sort, onSort } = useTableSort(projects, {
    artist: (p) => p.assignee?.name ?? null,
    name: (p) => p.name,
    client: (p) => p.client.name,
    revision: (p) =>
      leadVariant(p, meta.queueStatuses)?.revision_count ?? p.revision_count,
    created: (p) => new Date(p.created_at),
    // Sorts on the same value the cell renders, so clicking
    // Uploaded orders rows by the date they actually show.
    updated: (p) => {
      const at = uploadedAt(
        p,
        leadVariant(p, meta.queueStatuses),
        meta.queueStatuses
      );
      return at ? new Date(at) : null;
    },
    status: (p) =>
      statusRank(leadVariant(p, meta.queueStatuses)?.status ?? p.status),
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
        {sorted.map((p) => {
          // The colourway this row leads with — the one that put
          // the product in this tab. Its name, status, revision
          // and asset are what the collapsed row shows.
          const lead = leadVariant(p, meta.queueStatuses);
          const leadStatus = lead?.status ?? p.status;
          const leadName = lead ? variantLabel(p, lead) : p.name;
          const rev = lead ? lead.revision_count : p.revision_count;
          const leadGlb = lead
            ? lead.approved_glb_url || lead.glb_url
            : p.approved_glb_url || p.glb_url;
          const allVariants = sortVariants(p.variants ?? []) as Variant[];
          // Everything the lead row isn't. Expanding reveals these
          // — including the primary, when a colourway is leading.
          const rest = allVariants.filter((v) => v.id !== lead?.id);
          const canExpand = rest.length > 0;
          const isOpen = toggled.has(p.id);

          return (
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
              {/* Disclosure toggle. Only worth rendering when the
                  product actually has more than one colourway — a
                  product carrying just its backfilled primary has
                  nothing to expand to. */}
              {canExpand ? (
                <button
                  type="button"
                  onClick={() => toggleExpanded(p.id)}
                  aria-expanded={isOpen}
                  aria-label={
                    isOpen ? 'Hide colourways' : 'Show colourways'
                  }
                  title={`${allVariants.length} colourways`}
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
                      transform: isOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform 0.12s',
                      display: 'inline-block',
                    }}
                  >
                    ▶
                  </span>
                  <span>
                    <strong style={{ display: 'block' }}>{leadName}</strong>
                    <span
                      style={{ color: 'var(--text-faint)', fontSize: 12 }}
                    >
                      {p.slug} · {allVariants.length} colourways
                    </span>
                  </span>
                </button>
              ) : (
                // Spacer stands in for the arrow so names line up
                // whether or not a product has colourways.
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 6,
                    textAlign: 'left',
                  }}
                >
                  <span
                    aria-hidden
                    style={{ display: 'inline-block', width: 10, flex: 'none' }}
                  />
                  <span>
                    <strong style={{ display: 'block' }}>{leadName}</strong>
                    <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                      {p.slug}
                    </span>
                  </span>
                </div>
              )}
            </td>
            <td>
              <ReferenceThumb project={p} />
            </td>
            <td>{p.client.name}</td>
            {meta.showRevision && (
              <td>
                {rev >= 1 ? (
                  <a
                    href={crmPath(
                      // Open the gallery filtered to this row's
                      // revision. The source param picks the
                      // feedback table:
                      //   eqa_rejected → client's screenshots
                      //                 (their reason for pushing back)
                      //   everything else → admin's screenshots
                      //                 (the IQA feedback to the
                      //                 artist; relevant on iqa_rejected
                      //                 and historical on qa_pending /
                      //                 client_review / approved rows)
                      `/projects/${p.id}/feedback?revision=${rev}${
                        leadStatus === 'eqa_rejected' ? '&source=client' : ''
                      }`
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="crm-link"
                    title="View feedback for this revision"
                  >
                    {rev}
                  </a>
                ) : (
                  // No rejections yet — nothing to click through
                  // to. Render the number as plain text so the
                  // column still aligns.
                  rev
                )}
              </td>
            )}
            <DateCell value={p.created_at} />
            <DateCell
              value={uploadedAt(p, lead, meta.queueStatuses)}
              withTime
            />
            {meta.showAsset && (
              <td>
                {leadGlb && (
                  <a
                    className="crm-link"
                    // Scoped to the leading colourway, so the
                    // viewer opens on the model this row names
                    // rather than the product's primary.
                    href={crmPath(
                      `/admin/qa/${p.id}/model${
                        lead ? `?variant=${lead.id}` : ''
                      }`
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View GLB
                  </a>
                )}
              </td>
            )}
            <td>
              {/* The leading colourway's own status — the stage
                  that put this row in this tab. */}
              <StatusBadge
                status={leadStatus}
                revisionCount={rev}
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
                    // Wrap rather than overflow: on a narrow
                    // window the action plus Delete can exceed
                    // the column, and nowrap on the container
                    // clipped the last one off the right edge.
                    // Individual controls still keep their own
                    // nowrap so no single label breaks mid-word.
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
                  {/* Delete — only shown for jobs admin created
                      that are still in draft. Both conditions are
                      hard-checked on the server too; this is the
                      UX layer hiding the affordance for cases
                      where the call would 404/409. */}
                  {onDelete && allVariantsDraft(p) && p.created_by_admin && (
                      <button
                        type="button"
                        className="crm-btn crm-btn-ghost-danger crm-btn-icon"
                        onClick={() => onDelete(p)}
                        title="Delete this job"
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

          {/* ---- Colourway child rows ----
              The colourways this row ISN'T leading with, including
              the primary when a variant is leading. Real table
              rows (not a nested table) so the columns stay aligned
              with the parent. */}
          {isOpen &&
            rest.map((v) => (
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
                  <strong style={{ fontWeight: 600 }}>
                    {variantLabel(p, v)}
                  </strong>
                  {v.is_primary && (
                    <span
                      className="crm-badge crm-badge-draft"
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        marginLeft: 6,
                      }}
                      title="The original file this product was built from"
                    >
                      Primary
                    </span>
                  )}
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
                        // Point at the in-app viewer, not the raw
                        // R2 URL. A .glb link triggers a browser
                        // download; the viewer route renders it.
                        // ?variant scopes it to THIS colourway so
                        // the tab opens on the model in this row
                        // rather than the product's primary.
                        href={crmPath(
                          `/admin/qa/${p.id}/model?variant=${v.id}`
                        )}
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
                    assigned={p.assigned_to !== null}
                  />
                </td>
                {hasAction && <td />}
              </tr>
            ))}
          </Fragment>
          );
        })}
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
