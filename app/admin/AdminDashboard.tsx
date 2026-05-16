'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import StatusBadge from '../components/StatusBadge';
import Sidebar from '../components/Sidebar';
import {
  CLIENT_FILTER_EVENT,
  getStoredClientId,
} from '../components/ClientSwitcher';
import { crmFetch, crmPath } from '../lib/client-fetch';

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
  // YTA / YTS split a 'draft' row by whether an artist is on it.
  const yta = visibleProjects.filter(
    (p) => p.status === 'draft' && p.assigned_to === null
  );
  const yts = visibleProjects.filter(
    (p) => p.status === 'draft' && p.assigned_to !== null
  );
  // WIP bucket holds all three "in progress" flavours: a fresh
  // build (wip), a revision of admin's IQA feedback (iqa_wip),
  // and a revision of client's EQA feedback (eqa_wip). One tab,
  // three statuses — the StatusBadge differentiates them. The
  // tab bar stays at 9 tabs.
  const wip = visibleProjects.filter(
    (p) =>
      p.status === 'wip' ||
      p.status === 'iqa_wip' ||
      p.status === 'eqa_wip'
  );
  const iqa = visibleProjects.filter((p) => p.status === 'qa_pending');
  const iqaRejected = visibleProjects.filter(
    (p) => p.status === 'iqa_rejected'
  );
  const eqa = visibleProjects.filter((p) => p.status === 'client_review');
  const eqaRejected = visibleProjects.filter(
    (p) => p.status === 'eqa_rejected'
  );
  // Open Jobs = the rollup view: everything that hasn't been
  // signed off yet. Same row may also appear in one of the more
  // specific stage tabs above; this tab is for admins who want
  // the flat "what's still alive" picture.
  const openJobs = visibleProjects.filter((p) => p.status !== 'approved');
  const history = visibleProjects.filter((p) => p.status === 'approved');

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
              }
            ) => ({
              ...p,
              client: Array.isArray(p.client) ? p.client[0] : p.client,
              assignee: Array.isArray(p.assignee) ? p.assignee[0] : p.assignee,
            })
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
    actionKind: 'review' | 'assign' | 'reassign' | 'none';
  };
  const tabMeta: Record<Tab, TabMeta> = {
    yta: {
      label: 'YTA',
      count: yta.length,
      emptyMsg: 'No jobs waiting for allocation.',
      showAsset: false,
      showRevision: false,
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
                    <th>Project</th>
                    <th>References</th>
                    <th>Client</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {yta.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong style={{ display: 'block' }}>{p.name}</strong>
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                          {p.slug}
                        </span>
                      </td>
                      <td>
                        <a
                          href={crmPath(`/admin/qa/${p.id}/references`)}
                          target="_blank"
                          rel="noreferrer"
                          className="crm-link"
                          title="Open the reference gallery in a new tab"
                        >
                          View
                        </a>
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
                        <a
                          className="crm-link"
                          onClick={() => setReassigning(p)}
                        >
                          Assign
                        </a>
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
  if (p.status === 'draft') {
    return p.assigned_to ? 'YTS' : 'YTA';
  }
  if (p.status === 'qa_pending') return 'IQA';
  // Rejection labels match the on-screen StatusBadge (label only,
  // no count). The Revision column carries the round number
  // separately, so duplicating it here would be misleading
  // — the CSV reader would think the count was part of the
  // status itself.
  if (p.status === 'iqa_rejected') return 'IQA Rejected';
  if (p.status === 'eqa_rejected') return 'EQA Rejected';
  // The three WIP flavours export with their own labels so the
  // CSV mirrors the dashboard exactly.
  if (p.status === 'iqa_wip') return 'IQA WIP';
  if (p.status === 'eqa_wip') return 'EQA WIP';
  if (p.status === 'wip') return 'WIP';
  if (p.status === 'client_review') return 'EQA';
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
}: {
  projects: Project[];
  meta: {
    label: string;
    showAsset: boolean;
    showRevision: boolean;
    actionKind: 'review' | 'assign' | 'reassign' | 'none';
  };
  onReview: (p: Project) => void;
  onAssign: (p: Project) => void;
}) {
  const hasAction = meta.actionKind !== 'none';

  return (
    <table className="crm-table">
      <thead>
        <tr>
          <th>Artist</th>
          <th>Project</th>
          <th>References</th>
          <th>Client</th>
          {meta.showRevision && <th>Revision</th>}
          <th>Created</th>
          <th>Updated</th>
          {meta.showAsset && <th>Asset</th>}
          <th>Status</th>
          {hasAction && <th>Action</th>}
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr key={p.id}>
            <td>
              {p.assignee?.name || (
                <em style={{ color: 'var(--text-faint)' }}>unassigned</em>
              )}
            </td>
            <td>
              <strong style={{ display: 'block' }}>{p.name}</strong>
              <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                {p.slug}
              </span>
            </td>
            <td>
              <a
                href={crmPath(`/admin/qa/${p.id}/references`)}
                target="_blank"
                rel="noreferrer"
                className="crm-link"
                title="Open the reference gallery in a new tab"
              >
                View
              </a>
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
            <DateCell value={p.updated_at} />
            {meta.showAsset && (
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
            )}
            <td>
              <StatusBadge
                status={p.status}
                revisionCount={p.revision_count}
                assigned={p.assigned_to !== null}
              />
            </td>
            {hasAction && (
              <td>
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
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
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

// Format a date string as DD/MM/YYYY for table cells. Returns an
// em-dash when the value is missing so the column still shows a
// placeholder instead of collapsing.
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString();
}

// Reusable date cell. The em-dash version (no value tracked) is
// styled dimmer so the columns with real data lead the eye.
function DateCell({ value }: { value: string | null | undefined }) {
  if (!value) {
    return (
      <td style={{ color: 'var(--text-faint)' }}>—</td>
    );
  }
  return (
    <td style={{ color: 'var(--text-dim)' }}>{fmtDate(value)}</td>
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
