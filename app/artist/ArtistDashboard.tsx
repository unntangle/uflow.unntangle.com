'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import JSZip from 'jszip';
import StatusBadge from '../components/StatusBadge';
import Sidebar from '../components/Sidebar';
import { crmFetch, crmPath } from '../lib/client-fetch';

// ============================================================
// Types — mirror the server's joined select shape
// ============================================================
type Project = {
  id: string;
  slug: string;
  name: string;
  // The artist only ever sees the statuses they care about. EQA-
  // related states (client_review, eqa_rejected) and the
  // approval state are still possible values from the wire, but
  // their action cell renders nothing actionable for the artist.
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
  // Highest rejection round whose feedback this artist has opened.
  // A row counts as "unread feedback" while revision_count exceeds
  // it. Set server-side when the feedback gallery is opened.
  feedback_seen_revision: number;
  zip_url: string | null;
  glb_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  updated_at: string;
  client: { slug: string; name: string };
};

type ReferenceImage = {
  id: string;
  image_url: string;
  created_at: string;
};

// ============================================================
// Rejection helpers
//
// `isRejected` — the row is sitting in a rejected state, from
// either side of the pipeline.
//
// `hasUnreadFeedback` — the artist hasn't opened the feedback
// gallery for the CURRENT rejection round yet. revision_count
// ticks on every rejection, so this self-resets: reading round 1
// clears the flag, a round-2 rejection raises it again.
//
// feedback_seen_revision is defaulted defensively — a row fetched
// before the 2026-08-06 migration ran would arrive undefined, and
// treating that as 0 keeps it in the inbox rather than silently
// hiding feedback.
// ============================================================
function isRejected(p: Project): boolean {
  return p.status === 'iqa_rejected' || p.status === 'eqa_rejected';
}

function hasUnreadFeedback(p: Project): boolean {
  return (p.revision_count ?? 0) > (p.feedback_seen_revision ?? 0);
}

// ============================================================
// ArtistDashboard
//
// Three URL-driven modes — the sidebar has three flat links and
// each one targets one of these:
//
//   /artist                 → My Jobs (active queue, default)
//   /artist?tab=overview    → Overview (stats snapshot)
//   /artist?tab=jobs        → Jobs (admin-style tabbed view)
//
// The Jobs view uses the same `crm-tabs` pattern as the admin
// Overview, with these tabs (artist-relevant subset):
//
//   YTS          — Yet To Start (draft + assigned)
//   WIP          — In progress (wip / iqa_wip / eqa_wip)
//   IQA          — Awaiting QA (qa_pending)
//   IQA Rejected — Needs revision (iqa_rejected / eqa_rejected,
//                  collapsed: from the artist's POV both are just
//                  "I have feedback to address")
//   Open Jobs    — Rollup of everything not yet approved
//   Approved     — Signed-off archive (all approved jobs ever
//                  assigned to me)
//
// The client column is still NEVER rendered. Artists shouldn't
// see which brand commissioned a job; the data flows through
// `project.client` for API paths but is never surfaced in the UI.
// ============================================================
export default function ArtistDashboard({
  initialProjects,
  currentUser,
}: {
  initialProjects: Project[];
  currentUser: { name: string; role: '3d_artist' };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [uploadFor, setUploadFor] = useState<Project | null>(null);
  const [viewBrief, setViewBrief] = useState<Project | null>(null);
  // Per-project Start button state. We track which row is in flight
  // so concurrent clicks on different rows don't interfere; keyed by
  // project id rather than a single shared flag.
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [startErr, setStartErr] = useState<string | null>(null);

  // ----- Tab mode plumbing -----
  const tabParam = searchParams?.get('tab');
  const isOverviewMode = tabParam === 'overview';
  const isJobsMode = tabParam === 'jobs';
  // Anything else (no tab, or a typo'd value) lands on My Jobs.
  // We deliberately don't 404 on unknown tabs — the dashboard
  // should never be a blank page from a stale bookmark.
  const isMyJobsMode = !isOverviewMode && !isJobsMode;

  // ----- Buckets -----
  // 'approved' is the only terminal state from the artist's POV;
  // anything else still belongs in the active queue (even
  // 'client_review' and 'eqa_rejected', since the row might come
  // back to the artist after admin triage).
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status !== 'approved'),
    [projects]
  );
  const completedProjects = useMemo(
    () => projects.filter((p) => p.status === 'approved'),
    [projects]
  );
  // YTS: 'draft' rows assigned to this artist. (Unassigned drafts
  // would be YTA, but those never reach an artist's dashboard —
  // the server only returns rows where assigned_to = current user.)
  const ytsProjects = useMemo(
    () => projects.filter((p) => p.status === 'draft'),
    [projects]
  );
  const wipProjects = useMemo(
    () =>
      projects.filter(
        (p) =>
          p.status === 'wip' ||
          p.status === 'iqa_wip' ||
          p.status === 'eqa_wip' ||
          // Rejected rows whose feedback the artist has already
          // read but not yet Started. They've left the Rejected
          // inbox, and they can't sit in limbo — the action cell
          // is status-driven, so Start still renders for them
          // here. Admin still sees these under Rejected.
          (isRejected(p) && !hasUnreadFeedback(p))
      ),
    [projects]
  );
  // Rejected tabs behave as an INBOX: a row shows only while its
  // feedback is unread. Split by source now — admin's IQA
  // pushback and the client's EQA pushback are different
  // conversations and were previously collapsed into one tab.
  const iqaRejectedProjects = useMemo(
    () =>
      projects.filter(
        (p) => p.status === 'iqa_rejected' && hasUnreadFeedback(p)
      ),
    [projects]
  );
  const eqaRejectedProjects = useMemo(
    () =>
      projects.filter(
        (p) => p.status === 'eqa_rejected' && hasUnreadFeedback(p)
      ),
    [projects]
  );
  const iqaProjects = useMemo(
    () => projects.filter((p) => p.status === 'qa_pending'),
    [projects]
  );

  // Stats used by the Overview cards. Mutually exclusive so the
  // counts sum to the total visible job count (plus the always-
  // separate 'withClient' bucket which sits between IQA and
  // Approved in the workflow but isn't artist-actionable).
  const stats = useMemo(() => {
    return {
      yts: ytsProjects.length,
      wip: wipProjects.length,
      iqa: iqaProjects.length,
      iqaRejected: iqaRejectedProjects.length,
      eqaRejected: eqaRejectedProjects.length,
      withClient: projects.filter((p) => p.status === 'client_review').length,
      approved: completedProjects.length,
    };
  }, [
    projects,
    ytsProjects,
    wipProjects,
    iqaProjects,
    iqaRejectedProjects,
    eqaRejectedProjects,
    completedProjects,
  ]);

  function refreshList() {
    crmFetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        if (d.projects) {
          const norm = d.projects.map(
            (p: Project & { client: Project['client'] | Project['client'][] }) => ({
              ...p,
              client: Array.isArray(p.client) ? p.client[0] : p.client,
            })
          );
          setProjects(norm);
        }
      });
  }

  async function startProject(p: Project) {
    if (starting[p.id]) return;
    setStarting((s) => ({ ...s, [p.id]: true }));
    setStartErr(null);
    try {
      const res = await crmFetch(`/api/projects/${p.id}/start`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setStartErr(data.error || 'Could not start project.');
        return;
      }
      // Optimistically flip this row locally so the action column
      // re-renders to show Re-upload without waiting for the list
      // refresh round-trip. The exact target depends on what
      // we're transitioning from — mirror the server's branching
      // so the optimistic state matches what the server actually
      // wrote.
      const optimisticStatus: Project['status'] =
        p.status === 'iqa_rejected' ? 'iqa_wip' :
        p.status === 'eqa_rejected' ? 'eqa_wip' :
        'wip';
      setProjects((prev) =>
        prev.map((row) =>
          row.id === p.id ? { ...row, status: optimisticStatus } : row
        )
      );
      // Then refresh from the server to pick up updated_at etc.
      refreshList();
      router.refresh();
    } catch (e) {
      setStartErr((e as Error).message);
    } finally {
      setStarting((s) => ({ ...s, [p.id]: false }));
    }
  }

  // ----- Title + subtitle per mode -----
  const pageTitle = isOverviewMode ? 'Overview' : isJobsMode ? 'Jobs' : 'My Jobs';
  const pageSub = isOverviewMode
    ? 'A snapshot of your workload across every status.'
    : isJobsMode
    ? 'All jobs in one place. Switch tabs to focus on what needs attention.'
    : "Projects assigned to you. Open a brief to see what's needed, then upload your zip.";

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />
      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">{pageTitle}</h1>
              <p className="crm-page-sub">{pageSub}</p>
            </div>
          </header>

          {startErr && (
            <div className="crm-error" style={{ marginTop: 12 }}>
              {startErr}
            </div>
          )}

          {/* ============================== Overview (stats) ============================== */}
          {/* Stat cards. Tapping a card jumps to the Jobs page
              with that tab pre-selected via ?jobsTab=... so the
              Overview doubles as a navigation surface. */}
          {isOverviewMode && (
            <OverviewPanel
              stats={stats}
              total={projects.length}
              onJump={(tab) =>
                router.push(crmPath(`/artist?tab=jobs&jobsTab=${tab}`))
              }
              onJumpToJobs={() => router.push(crmPath('/artist?tab=jobs'))}
            />
          )}

          {/* ============================== Jobs (tabbed) ============================== */}
          {/* Admin-style tab bar. Each tab swaps the list below
              without changing the URL — same UX as the admin
              Overview. The Overview cards above link in here
              with ?jobsTab=... pre-selected. */}
          {isJobsMode && (
            <JobsTabs
              buckets={{
                yts: ytsProjects,
                wip: wipProjects,
                iqa: iqaProjects,
                iqa_rejected: iqaRejectedProjects,
                eqa_rejected: eqaRejectedProjects,
                open: activeProjects,
                approved: completedProjects,
              }}
              initialTabHint={searchParams?.get('jobsTab')}
              starting={starting}
              onStart={startProject}
              onOpenBrief={(p) => setViewBrief(p)}
              onUpload={(p) => setUploadFor(p)}
            />
          )}

          {/* ============================== My Jobs (active queue) ============================== */}
          {isMyJobsMode && (
            activeProjects.length === 0 ? (
              <div className="crm-empty">
                <h3>No jobs assigned</h3>
                <p>
                  You&apos;ll see new jobs here when an admin assigns one to you.
                </p>
              </div>
            ) : (
              <ActiveJobsTable
                projects={activeProjects}
                starting={starting}
                onStart={startProject}
                onOpenBrief={(p) => setViewBrief(p)}
                onUpload={(p) => setUploadFor(p)}
              />
            )
          )}
        </div>
      </main>

      {uploadFor && (
        <UploadModal
          project={uploadFor}
          onClose={() => setUploadFor(null)}
          onDone={() => {
            setUploadFor(null);
            refreshList();
            router.refresh();
          }}
        />
      )}
      {viewBrief && (
        <BriefModal project={viewBrief} onClose={() => setViewBrief(null)} />
      )}
    </div>
  );
}

// ============================================================
// Overview panel
//
// Six clickable stat cards. Each card represents one tab on the
// Jobs page; tapping a card navigates to /artist?tab=jobs with
// the corresponding tab pre-selected via ?jobsTab=. The "With
// client" card is non-interactive — those rows aren't artist-
// actionable and don't have a matching Jobs tab.
//
// We render every card including zeros so the grid layout stays
// stable across page loads.
// ============================================================
type JobsTabKey =
  | 'yts'
  | 'wip'
  | 'iqa'
  | 'iqa_rejected'
  | 'eqa_rejected'
  | 'open'
  | 'approved';

function OverviewPanel({
  stats,
  total,
  onJump,
  onJumpToJobs,
}: {
  stats: {
    yts: number;
    wip: number;
    iqa: number;
    iqaRejected: number;
    eqaRejected: number;
    withClient: number;
    approved: number;
  };
  total: number;
  onJump: (tab: JobsTabKey) => void;
  onJumpToJobs: () => void;
}) {
  const cards: {
    label: string;
    value: number;
    tone: string;
    tab: JobsTabKey | null;
  }[] = [
    { label: 'YTS',          value: stats.yts,         tone: 'crm-badge-draft',         tab: 'yts' },
    { label: 'WIP',          value: stats.wip,         tone: 'crm-badge-wip',           tab: 'wip' },
    { label: 'IQA',          value: stats.iqa,         tone: 'crm-badge-pending',       tab: 'iqa' },
    { label: 'IQA Rejected', value: stats.iqaRejected, tone: 'crm-badge-rejected',      tab: 'iqa_rejected' },
    { label: 'EQA Rejected', value: stats.eqaRejected, tone: 'crm-badge-rejected',      tab: 'eqa_rejected' },
    { label: 'With client',  value: stats.withClient,  tone: 'crm-badge-client-review', tab: null },
    { label: 'Approved',     value: stats.approved,    tone: 'crm-badge-approved',      tab: 'approved' },
  ];

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 12,
        }}
      >
        {cards.map((c) => {
          const interactive = c.tab !== null;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => {
                if (c.tab) onJump(c.tab);
              }}
              disabled={!interactive}
              style={{
                textAlign: 'left',
                cursor: interactive ? 'pointer' : 'default',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '14px 16px',
                background: 'var(--surface)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                font: 'inherit',
                color: 'inherit',
                opacity: interactive ? 1 : 0.65,
              }}
              title={
                interactive
                  ? `Open Jobs → ${c.label}`
                  : 'These jobs are with the client — no action needed from you.'
              }
            >
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {c.label}
              </span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <strong style={{ fontSize: 28, lineHeight: 1 }}>{c.value}</strong>
                <span
                  className={`crm-badge ${c.tone}`}
                  style={{ fontSize: 10, padding: '2px 6px' }}
                >
                  {c.label}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer rollup + quick link to the full Jobs view. */}
      <div
        style={{
          marginTop: 20,
          padding: '14px 16px',
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <span style={{ fontSize: 14, color: 'var(--text-dim)' }}>
          {total === 0 ? (
            "No jobs assigned to you yet."
          ) : (
            <>
              <strong style={{ color: 'var(--text)' }}>{total}</strong> job
              {total === 1 ? '' : 's'} assigned overall.
            </>
          )}
        </span>
        <button className="crm-btn crm-btn-secondary" onClick={onJumpToJobs}>
          Open Jobs
        </button>
      </div>
    </div>
  );
}

// ============================================================
// JobsTabs
//
// Admin-style tab bar (crm-tabs / crm-tab / crm-tab-count) sitting
// above one of two tables — ActiveJobsTable for the actionable
// buckets, CompletedJobsTable for the read-only Approved tab.
//
// Tab state is local — switching tabs doesn't push a URL change,
// matching the admin Overview behaviour. We do honour an initial
// `?jobsTab=` hint from the URL so the Overview cards can deep-
// link into a specific tab on first paint, but subsequent tab
// switches stay local.
// ============================================================
function JobsTabs({
  buckets,
  initialTabHint,
  starting,
  onStart,
  onOpenBrief,
  onUpload,
}: {
  buckets: {
    yts: Project[];
    wip: Project[];
    iqa: Project[];
    iqa_rejected: Project[];
    eqa_rejected: Project[];
    open: Project[];
    approved: Project[];
  };
  initialTabHint: string | null | undefined;
  starting: Record<string, boolean>;
  onStart: (p: Project) => void;
  onOpenBrief: (p: Project) => void;
  onUpload: (p: Project) => void;
}) {
  // Recognised tab hints from the Overview deep-link. Anything
  // else (or no hint at all) falls through to the smart default.
  function resolveHint(raw: string | null | undefined): JobsTabKey | null {
    if (!raw) return null;
    if (
      raw === 'yts' ||
      raw === 'wip' ||
      raw === 'iqa' ||
      raw === 'iqa_rejected' ||
      raw === 'eqa_rejected' ||
      raw === 'open' ||
      raw === 'approved'
    ) {
      return raw;
    }
    return null;
  }

  // Default landing tab: most-urgent-first.
  //   1. EQA Rejected  — client pushback, the costliest to sit on
  //   2. IQA Rejected  — admin feedback sitting unread
  //   3. YTS           — new work to acknowledge
  //   4. WIP           — in-flight work
  //   5. IQA           — waiting on review
  //   6. Open Jobs     — anything else in motion
  //   7. Approved      — archive (last resort)
  // Falls back to YTS if every bucket is empty.
  const smartDefault: JobsTabKey = (() => {
    if (buckets.eqa_rejected.length > 0) return 'eqa_rejected';
    if (buckets.iqa_rejected.length > 0) return 'iqa_rejected';
    if (buckets.yts.length > 0) return 'yts';
    if (buckets.wip.length > 0) return 'wip';
    if (buckets.iqa.length > 0) return 'iqa';
    if (buckets.open.length > 0) return 'open';
    if (buckets.approved.length > 0) return 'approved';
    return 'yts';
  })();

  const initialTab: JobsTabKey = resolveHint(initialTabHint) ?? smartDefault;
  const [tab, setTab] = useState<JobsTabKey>(initialTab);

  const tabs: { key: JobsTabKey; label: string; count: number; emptyMsg: string }[] = [
    {
      key: 'yts',
      label: 'YTS',
      count: buckets.yts.length,
      emptyMsg: 'Nothing waiting for you to start.',
    },
    {
      key: 'wip',
      label: 'WIP',
      count: buckets.wip.length,
      emptyMsg: 'Nothing in progress right now.',
    },
    {
      key: 'iqa',
      label: 'IQA',
      count: buckets.iqa.length,
      emptyMsg: 'No models waiting for internal QA.',
    },
    {
      key: 'iqa_rejected',
      label: 'IQA Rejected',
      count: buckets.iqa_rejected.length,
      emptyMsg: 'No unread internal QA feedback.',
    },
    {
      key: 'eqa_rejected',
      label: 'EQA Rejected',
      count: buckets.eqa_rejected.length,
      emptyMsg: 'No unread client feedback.',
    },
    {
      key: 'open',
      label: 'Open Jobs',
      count: buckets.open.length,
      emptyMsg: 'No open jobs.',
    },
    {
      key: 'approved',
      label: 'Approved',
      count: buckets.approved.length,
      emptyMsg: 'No approved jobs yet.',
    },
  ];

  // Resolve the rows for the active tab. The Approved tab routes
  // through CompletedJobsTable; everything else uses the active
  // table so the user gets Start/Upload affordances where they
  // make sense.
  const activeBucket = (() => {
    switch (tab) {
      case 'yts':           return buckets.yts;
      case 'wip':           return buckets.wip;
      case 'iqa':           return buckets.iqa;
      case 'iqa_rejected':  return buckets.iqa_rejected;
      case 'eqa_rejected':  return buckets.eqa_rejected;
      case 'open':          return buckets.open;
      case 'approved':      return buckets.approved;
    }
  })();
  const activeMeta = tabs.find((t) => t.key === tab)!;

  return (
    <>
      {/* Tab bar — same classes the admin Overview uses so the
          visual treatment is identical across roles. */}
      <div className="crm-tabs" role="tablist" aria-label="My jobs">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`crm-tab ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <span className="crm-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {/* Body — empty state or the matching table. Approved gets
          the read-only CompletedJobsTable; every other tab is
          actionable so it uses ActiveJobsTable. */}
      {activeBucket.length === 0 ? (
        <p
          style={{
            color: 'var(--text-dim)',
            padding: '16px 0 32px',
            fontSize: 13,
          }}
        >
          {activeMeta.emptyMsg}
        </p>
      ) : tab === 'approved' ? (
        <CompletedJobsTable
          projects={activeBucket}
          onOpenBrief={onOpenBrief}
        />
      ) : (
        <ActiveJobsTable
          projects={activeBucket}
          starting={starting}
          onStart={onStart}
          onOpenBrief={onOpenBrief}
          onUpload={onUpload}
        />
      )}
    </>
  );
}

// ============================================================
// Active jobs table — the actionable list used by every
// non-Approved tab plus the default My Jobs view.
// ============================================================
function ActiveJobsTable({
  projects,
  starting,
  onStart,
  onOpenBrief,
  onUpload,
}: {
  projects: Project[];
  starting: Record<string, boolean>;
  onStart: (p: Project) => void;
  onOpenBrief: (p: Project) => void;
  onUpload: (p: Project) => void;
}) {
  return (
    <table className="crm-table">
      <thead>
        <tr>
          {/* Client column intentionally omitted from the
              artist view — artists shouldn't see which
              client commissioned a job. */}
          <th style={{ width: '26%' }}>Project</th>
          <th>Brief</th>
          <th>Reference</th>
          <th>Revision Round</th>
          <th>Status</th>
          <th>Updated</th>
          <th style={{ textAlign: 'right' }}>Action</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr key={p.id}>
            <td>
              <strong style={{ display: 'block' }}>{p.name}</strong>
              <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                {p.slug}
              </span>
            </td>
            <td>
              <a
                className="crm-link"
                onClick={() => onOpenBrief(p)}
                style={{ cursor: 'pointer' }}
              >
                View
              </a>
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
              {p.revision_count === 0 ? (
                <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
                  —
                </span>
              ) : (
                <a
                  className="crm-link"
                  href={crmPath(
                    `/projects/${p.id}/feedback?revision=${p.revision_count}`
                  )}
                  target="_blank"
                  rel="noreferrer"
                  title={`View feedback for revision ${p.revision_count}`}
                >
                  {p.revision_count}
                </a>
              )}
            </td>
            <td>
              <StatusBadge
                status={p.status}
                revisionCount={p.revision_count}
                // The artist is always the assigned user on rows
                // they can see, so a draft row here is always YTS.
                assigned={p.assigned_to !== null}
              />
            </td>
            <td style={{ color: 'var(--text-dim)' }}>
              {new Date(p.updated_at).toLocaleDateString()}
            </td>
            <td style={{ textAlign: 'right' }}>
              {/*
                Action cell is status-aware. Each project state gets
                exactly one action affordance:

                  draft         → Start
                  qa_pending    → "Awaiting QA review"
                  iqa_rejected  → Start
                  eqa_rejected  → Start
                  wip / *_wip   → Upload zip / Re-upload
                  client_review → "With client"
                  approved      → handled in CompletedJobsTable
              */}
              {p.status === 'draft' && (
                <button
                  className="crm-btn"
                  onClick={() => onStart(p)}
                  disabled={!!starting[p.id]}
                >
                  {starting[p.id] ? 'Starting…' : 'Start'}
                </button>
              )}
              {p.status === 'qa_pending' && (
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  Awaiting QA review
                </span>
              )}
              {(p.status === 'iqa_rejected' || p.status === 'eqa_rejected') && (
                <button
                  className="crm-btn"
                  onClick={() => onStart(p)}
                  disabled={!!starting[p.id]}
                >
                  {starting[p.id] ? 'Starting…' : 'Start'}
                </button>
              )}
              {(p.status === 'wip' ||
                p.status === 'iqa_wip' ||
                p.status === 'eqa_wip') && (
                <button className="crm-btn" onClick={() => onUpload(p)}>
                  {p.revision_count === 0 ? 'Upload zip' : 'Re-upload'}
                </button>
              )}
              {p.status === 'client_review' && (
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  With client
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ============================================================
// Completed jobs table — read-only archive
//
// Shows every approved job ever assigned to the artist. Simpler
// shape than ActiveJobsTable: no action column (the only
// affordance is View GLB, which goes in the Asset column), no
// revision dropdown (the row is signed off, history isn't
// actionable). The brief link stays in because past briefs are
// useful to reference for similar future work.
// ============================================================
function CompletedJobsTable({
  projects,
  onOpenBrief,
}: {
  projects: Project[];
  onOpenBrief: (p: Project) => void;
}) {
  return (
    <table className="crm-table">
      <thead>
        <tr>
          <th style={{ width: '32%' }}>Project</th>
          <th>Brief</th>
          <th>Reference</th>
          <th>Revisions</th>
          <th>Approved</th>
          <th>Status</th>
          <th style={{ textAlign: 'right' }}>Asset</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr key={p.id}>
            <td>
              <strong style={{ display: 'block' }}>{p.name}</strong>
              <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                {p.slug}
              </span>
            </td>
            <td>
              <a
                className="crm-link"
                onClick={() => onOpenBrief(p)}
                style={{ cursor: 'pointer' }}
              >
                View
              </a>
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
            <td style={{ color: 'var(--text-dim)' }}>
              {/* Just the revision_count as a number — no link,
                  because the job is closed and a feedback gallery
                  click would dead-end on "no further revisions". */}
              {p.revision_count}
            </td>
            <td style={{ color: 'var(--text-dim)' }}>
              {new Date(p.updated_at).toLocaleDateString()}
            </td>
            <td>
              <StatusBadge
                status={p.status}
                revisionCount={p.revision_count}
                assigned={p.assigned_to !== null}
              />
            </td>
            <td style={{ textAlign: 'right' }}>
              {p.approved_glb_url ? (
                <a
                  className="crm-btn crm-btn-secondary"
                  href={p.approved_glb_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  View GLB
                </a>
              ) : (
                <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
                  —
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ============================================================
// Brief modal — shows the admin's brief text + reference images
// ============================================================
function BriefModal({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [refs, setRefs] = useState<ReferenceImage[] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  if (refs === null) {
    crmFetch(`/api/projects/${project.id}/references`)
      .then((r) => r.json())
      .then((d) => setRefs(d.references || []));
  }

  // ----- Download all reference images as a single zip -----
  // We fetch each public R2 URL from the browser (the bucket is
  // public-read), stitch the bytes into one zip via JSZip, then
  // trigger a save via a temporary <a download>. Entirely
  // client-side — no server round-trip, no R2 writes.
  //
  // Individual fetch failures are tolerated: a failed image is
  // skipped and the zip is built from whatever did succeed. A
  // total failure (zero images downloaded) surfaces an error
  // instead of writing an empty zip.
  async function downloadAll() {
    if (!refs || refs.length === 0 || downloading) return;
    setDownloading(true);
    setDownloadErr(null);
    try {
      const zip = new JSZip();
      let ok = 0;
      // Fetch in parallel, but limit concurrency implicitly by
      // just kicking everything off — the browser caps simultaneous
      // connections to a single origin (typically 6), which is
      // plenty for ~12 images. For larger ref sets we'd want a
      // pool, but reference counts are bounded to 20 server-side.
      await Promise.all(
        refs.map(async (r, i) => {
          try {
            const res = await fetch(r.image_url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            // Filename: "reference-01.jpg" — zero-padded so the
            // zip lists them in upload order even on Windows.
            const ext = (() => {
              const m = r.image_url.match(/\.([a-z0-9]+)(?:\?|$)/i);
              return m ? m[1].toLowerCase() : 'jpg';
            })();
            const num = String(i + 1).padStart(2, '0');
            zip.file(`reference-${num}.${ext}`, blob);
            ok++;
          } catch {
            // Skip this image; the rest still go into the zip.
          }
        })
      );

      if (ok === 0) {
        setDownloadErr('Could not download any of the reference images.');
        return;
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      // Trigger a save without leaving the page or opening a tab.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.slug}-references.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Let the browser flush the download before revoking the blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadErr((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="crm-modal-backdrop" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crm-modal-header">
          <div>
            <h2 className="crm-modal-title">Job Brief</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>
              {project.name}
            </p>
          </div>
          <button className="crm-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="crm-form-group">
          <label className="crm-label">Brief</label>
          {project.brief ? (
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14 }}>
              {project.brief}
            </p>
          ) : (
            <p style={{ color: 'var(--text-dim)', margin: 0, fontSize: 13 }}>
              No written brief was attached.
            </p>
          )}
        </div>

        <div className="crm-form-group" style={{ marginTop: 20 }}>
          {/* Header row with the section label on the left and the
              download-all button on the right, only when refs exist. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <label className="crm-label" style={{ margin: 0 }}>
              Reference images
              {refs && refs.length > 0 && (
                <span
                  style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}
                >
                  ({refs.length})
                </span>
              )}
            </label>
            {refs && refs.length > 0 && (
              <button
                className="crm-btn crm-btn-secondary"
                onClick={downloadAll}
                disabled={downloading}
              >
                {downloading ? 'Preparing…' : 'Download all'}
              </button>
            )}
          </div>

          {refs === null ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>
              Loading…
            </p>
          ) : refs.length === 0 ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>
              No reference images.
            </p>
          ) : (
            <div className="crm-feedback-grid">
              {refs.map((r) => (
                <a
                  key={r.id}
                  href={r.image_url}
                  target="_blank"
                  rel="noreferrer"
                  className="crm-feedback-thumb"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.image_url} alt="reference" />
                </a>
              ))}
            </div>
          )}

          {downloadErr && (
            <div className="crm-error" style={{ marginTop: 10 }}>
              {downloadErr}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Upload size cap. R2 allows far larger single-PUT objects
// (~5 GB), but we cap here to stay within the bucket's storage
// budget and keep uploads quick. The artist's zip now bundles the
// model formats AND the Substance source (.spp/.spsm) plus baked
// texture maps, so 300 MB gives comfortable headroom.
// ============================================================
const MAX_UPLOAD_MB = 300;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// ============================================================
// Upload zip modal
// ============================================================
function UploadModal({
  project,
  onClose,
  onDone,
}: {
  project: Project;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [stage, setStage] = useState<'idle' | 'checking' | 'signing' | 'uploading' | 'finalizing'>('idle');
  const [, startTransition] = useTransition();

  // ---- Variant targeting ----
  // A product may have several colourways, each with its own zip
  // and its own QA cycle. The artist picks which one this upload
  // is for; with a single variant (the common case) we select it
  // automatically and hide the chooser entirely.
  type UploadVariant = {
    id: string;
    name: string;
    slug: string;
    status: string;
    is_primary: boolean;
  };
  const [variants, setVariants] = useState<UploadVariant[] | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    crmFetch(`/api/projects/${project.id}/variants`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const list: UploadVariant[] = d.variants ?? [];
        // Approved colourways are finished — don't offer them as
        // an upload target; the endpoints would reject them.
        const open = list.filter((v) => v.status !== 'approved');
        setVariants(open);
        setVariantId(open[0]?.id ?? null);
      })
      .catch(() => {
        // No variants endpoint / table yet — fall back to the
        // legacy single-model upload, which omits variant_id.
        if (!cancelled) {
          setVariants([]);
          setVariantId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const selectedVariant =
    variants?.find((v) => v.id === variantId) ?? null;

  // Expected filename stem for this upload. Non-primary variants
  // get their own namespace so a product's colourways don't all
  // ship files with identical names:
  //   primary → smart.zip   / smart.glb
  //   "grey"  → smart-grey.zip / smart-grey.glb
  const productBase = project.slug.split('-')[0].toLowerCase();
  const assetBase =
    selectedVariant && !selectedVariant.is_primary
      ? `${productBase}-${selectedVariant.slug}`
      : productBase;

  // Validate a chosen file before accepting it: must be a .zip and
  // within the size cap. Rejections surface inline (via setErr) so
  // the artist sees WHY nothing happened instead of a silent no-op.
  function pickFile(f: File | undefined | null) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.zip')) {
      setErr('Please choose a .zip file.');
      return;
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      setErr(
        `That zip is ${(f.size / 1024 / 1024).toFixed(0)} MB — the limit is ${MAX_UPLOAD_MB} MB. ` +
          'Remove anything not needed (e.g. extra Substance autosaves) and re-zip.'
      );
      return;
    }
    setErr(null);
    setFile(f);
  }

  // Gate the upload: confirm the zip is named <product>.zip, that
  // every required folder holds its file, AND that each of those
  // files follows the <product>.<ext> naming convention. Returns a
  // specific error for the first problem found, or null when valid.
  // Folder matching mirrors the server extractor (nested-folder
  // tolerant, case-insensitive); textures inside fbx/ are not
  // name-checked since their filenames legitimately vary.
  async function validateZipStructure(f: File): Promise<string | null> {
    // Filename stem for this upload target. For a colourway this
    // is "<product>-<variant>" so Black and Grey don't both ship
    // files called smart.glb — they'd be indistinguishable once
    // downloaded, and would collide in the same R2 folder.
    const product = assetBase;

    // 1. Outer zip filename.
    if (f.name.toLowerCase() !== product + '.zip') {
      return (
        'Upload blocked — the zip must be named "' + product + '.zip", but ' +
        'yours is "' + f.name + '". Rename the zip and try again.'
      );
    }

    // 2. Read entries.
    let names: string[];
    try {
      const zip = await JSZip.loadAsync(f);
      names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    } catch {
      return 'Could not read that .zip — it may be corrupt. Try re-zipping.';
    }

    // basename of an entry path, lower-cased:
    // "models/glb/Jupiter.glb" -> "jupiter.glb".
    const baseOf = (n: string) => (n.split('/').pop() || n).toLowerCase();

    // 3. Presence + naming for each required model/source file.
    const need: { folder: string; ext: string }[] = [
      { folder: 'fbx', ext: 'fbx' },
      { folder: 'glb', ext: 'glb' },
      { folder: 'gltf', ext: 'gltf' },
      { folder: 'spp', ext: 'spp' },
      { folder: 'spp', ext: 'spsm' },
    ];

    for (const req of need) {
      const topSeg = req.folder + '/';
      const folderSeg = '/' + req.folder + '/';
      const dotExt = '.' + req.ext;
      const wantName = product + dotExt;

      const ofExt = names.filter((n) => {
        const lower = n.toLowerCase();
        const inFolder = lower.startsWith(topSeg) || lower.includes(folderSeg);
        return inFolder && lower.endsWith(dotExt);
      });

      if (ofExt.length === 0) {
        return (
          'Upload blocked — missing ' + req.folder + '/' + wantName +
          '. Every folder must contain its file. Add it and re-zip.'
        );
      }

      if (!ofExt.some((n) => baseOf(n) === wantName)) {
        return (
          'Upload blocked — ' + req.folder + '/ has "' + baseOf(ofExt[0]) +
          '" but it must be named "' + wantName + '". Rename it and re-zip.'
        );
      }
    }

    return null;
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setProgress(0);

    try {
      // Structure gate: block the upload entirely if any required
      // folder/file is absent. This is what makes "upload will not
      // happen without it" true — we return before signing/PUT.
      setStage('checking');
      const structErr = await validateZipStructure(file);
      if (structErr) {
        setErr(structErr);
        return;
      }

      setStage('signing');
      const signRes = await crmFetch(
        `/api/projects/${project.id}/upload-sign`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Tells the server which colourway this zip belongs to
          // so the assets land in that variant's namespace and
          // the status flips on the variant row, not the product.
          // Null falls back to the legacy single-model path.
          body: JSON.stringify({ variant_id: variantId }),
        }
      );
      const signData = await signRes.json();
      if (!signRes.ok) {
        setErr(signData.error || 'Could not start upload.');
        return;
      }

      setStage('uploading');
      // R2 wants a raw PUT with the file body — no FormData, no
      // extra fields. The Content-Type must match what was signed.
      await uploadWithProgress(
        signData.upload_url,
        file,
        'application/zip',
        setProgress
      );
      // The public URL was already returned by the sign endpoint;
      // we don't need to parse anything out of the PUT response.
      const zipUrl = signData.public_url as string;

      setStage('finalizing');
      const finRes = await crmFetch(
        `/api/projects/${project.id}/finalize-upload`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            zip_url: zipUrl,
            revision: signData.revision,
            variant_id: variantId,
          }),
        }
      );
      const finData = await finRes.json();
      if (!finRes.ok) {
        setErr(finData.error || 'Server could not process the zip.');
        return;
      }

      startTransition(() => onDone());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setStage('idle');
    }
  }

  const stageLabel =
    stage === 'checking'   ? 'Checking zip…' :
    stage === 'signing'    ? 'Preparing…' :
    stage === 'uploading'  ? `Uploading… ${progress}%` :
    stage === 'finalizing' ? 'Extracting zip (may take a minute)…' :
    'Submit for QA';

  return (
    <div className="crm-modal-backdrop" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crm-modal-header">
          <div>
            <h2 className="crm-modal-title">Upload zip</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>
              {project.name}
            </p>
          </div>
          <button className="crm-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Upload target. Always shown once variants are known,
            even with a single option — the artist needs to see
            WHICH colourway they're submitting, and the expected
            filename below changes with it. A lone variant renders
            as a read-only line rather than a pointless dropdown. */}
        {variants && variants.length > 0 && (
          <div className="crm-form-group" style={{ marginBottom: 4 }}>
            <label className="crm-label">Uploading for</label>
            {variants.length === 1 ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <strong>{variants[0].name}</strong>
                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                  {variants[0].is_primary
                    ? 'the original — add a variant from the admin job row to submit a colourway'
                    : 'variant'}
                </span>
              </p>
            ) : (
              <select
                className="crm-input"
                value={variantId ?? ''}
                disabled={busy}
                onChange={(e) => {
                  setVariantId(e.target.value);
                  // The expected filename changes with the target,
                  // so a file picked for the previous variant is no
                  // longer valid. Clear it rather than let the
                  // artist submit and hit a confusing name error.
                  setFile(null);
                  setErr(null);
                }}
              >
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.is_primary ? ' (original)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div
          className={`crm-dropzone ${drag ? 'is-drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pickFile(e.dataTransfer.files[0]);
          }}
          onClick={() => document.getElementById('zip-input')?.click()}
        >
          <input
            id="zip-input"
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
            }}
          />
          {file ? (
            <>
              <strong>{file.name}</strong>
              <div className="crm-dropzone-hint">
                {(file.size / 1024 / 1024).toFixed(1)} MB · click to replace
              </div>
            </>
          ) : (
            <>
              <strong>Click or drop your .zip file</strong>
              <div className="crm-dropzone-hint">
                Max {MAX_UPLOAD_MB} MB · see the required structure below
              </div>
            </>
          )}
        </div>

        <UploadGuide zipName={`${assetBase}.zip`} />

        {busy && stage === 'uploading' && (
          <div
            style={{
              marginTop: 14,
              height: 6,
              background: 'var(--surface-2)',
              borderRadius: 999,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: 'var(--accent)',
                transition: 'width 0.2s',
              }}
            />
          </div>
        )}

        {err && <div className="crm-error" style={{ marginTop: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="crm-btn crm-btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="crm-btn" onClick={submit} disabled={!file || busy}>
            {busy ? stageLabel : 'Submit for QA'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// UploadGuide — the visual the artist sees before picking a file.
// Shows the required .zip folder structure plus a notice that every
// folder + file is mandatory. The actual enforcement lives in the
// modal's submit() (validateZipStructure); this is presentational.
// ============================================================
function UploadGuide({ zipName }: { zipName: string }) {
  const rows: { folder: string; holds: string; required?: boolean }[] = [
    { folder: 'fbx/', holds: '.fbx + texture map images (.png / .jpg)', required: true },
    { folder: 'glb/', holds: '.glb', required: true },
    { folder: 'gltf/', holds: '.gltf', required: true },
    { folder: 'spp/', holds: '.spp + .spsm  (Substance source)', required: true },
  ];

  // Product base for the example filenames, e.g. "jupiter.zip" -> "jupiter".
  const base = zipName.slice(0, -4);

  return (
    <div
      style={{
        marginTop: 14,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      {/* ---- Required structure ---- */}
      <div style={{ padding: '12px 14px' }}>
        <div
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--text-dim)',
            marginBottom: 10,
          }}
        >
          Required .zip structure
        </div>

        <div
          style={{
            fontFamily: 'var(--crm-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            fontSize: 13,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span aria-hidden>📦</span>
            <strong>{zipName}</strong>
          </div>
          {rows.map((r, i) => {
            const last = i === rows.length - 1;
            return (
              <div
                key={r.folder}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '3px 0',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ color: 'var(--text-faint)' }}>{last ? '└─' : '├─'}</span>
                <span aria-hidden>📁</span>
                <code style={{ fontWeight: 600 }}>{r.folder}</code>
                <span style={{ color: 'var(--text-dim)' }}>{r.holds}</span>
                {r.required && (
                  <span
                    className="crm-badge crm-badge-pending"
                    style={{ fontSize: 10, padding: '1px 6px' }}
                  >
                    required
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div
          style={{
            margin: '12px 0 0',
            padding: '8px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--surface-2)',
            fontSize: 12,
            color: 'var(--text-dim)',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: 'var(--danger)' }}>Required:</strong> name the
          zip <code>{zipName}</code>, and name every file after the product —{' '}
          <code>{base}.fbx</code>, <code>{base}.glb</code>, <code>{base}.gltf</code>,{' '}
          <code>{base}.spp</code> and <code>{base}.spsm</code>, each inside its
          folder. If anything is missing or misnamed, the upload is blocked. Max{' '}
          {MAX_UPLOAD_MB} MB total.
        </div>
      </div>
    </div>
  );
}

function uploadWithProgress(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // The signed URL pins the Content-Type; the browser must send
    // it back exactly or R2 rejects the PUT with a signature error.
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // R2 PUT returns an empty body; success is just the 2xx.
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText || 'no body'}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}
