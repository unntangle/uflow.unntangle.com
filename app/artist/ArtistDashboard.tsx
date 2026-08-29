'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import JSZip from 'jszip';
import StatusBadge from '../components/StatusBadge';
import TypeBadge, { ModelType } from '../components/TypeBadge';
import Sidebar from '../components/Sidebar';
import { crmFetch, crmPath } from '../lib/client-fetch';
import { useLiveRefresh } from '../lib/use-live-refresh';

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
  // First reference image, collapsed server-side from the
  // references join so the row can show a thumbnail without a
  // fetch per row. Null when the job has no references.
  thumb_url?: string | null;
  // Where this job sits in the hierarchy. A child is a model
  // derived from another one — still a full job with its own
  // brief, upload and QA cycle.
  model_type?: ModelType | null;
  parent_id?: string | null;
  parent_name?: string | null;
};

// ============================================================
// Stage membership
// ============================================================
// Every job is one row with one status. Colourways used to be
// sub-rows with their own statuses, so bucketing went through
// anyVariantIn() and a row could legitimately appear in several
// tabs at once. Since the 2026-08-29 promotion each colourway is
// its own job, so this is a plain membership test again.
function isIn(p: Project, statuses: Project['status'][]): boolean {
  return statuses.includes(p.status);
}

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
  // Which job the upload modal is open for. Every job is its own
  // row with its own zip, so this is just the project — there is
  // no longer a colourway to disambiguate within it.
  const [uploadFor, setUploadFor] = useState<Project | null>(null);
  const [viewBrief, setViewBrief] = useState<Project | null>(null);
  // Per-project Start button state. We track which row is in flight
  // so concurrent clicks on different rows don't interfere; keyed by
  // project id rather than a single shared flag.
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [startErr, setStartErr] = useState<string | null>(null);
  // Which tab the Overview's list is showing. A stat card sets
  // this instead of navigating away — the list now sits directly
  // under the cards, so leaving the page to see it would be a
  // round-trip for something already on screen. null means "no
  // card picked yet", and JobsTabs falls back to its own
  // most-urgent-first default.
  const [overviewTab, setOverviewTab] = useState<JobsTabKey | null>(null);

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
  // One row, one status, one bucket. (Before the 2026-08-29
  // promotion a product could appear in several tabs at once,
  // because each of its colourways had its own status.)
  const ytsProjects = useMemo(
    () => projects.filter((p) => isIn(p, ['draft'])),
    [projects]
  );
  const wipProjects = useMemo(
    () =>
      projects.filter(
        (p) =>
          isIn(p, ['wip', 'iqa_wip', 'eqa_wip']) ||
          // Rejected rows whose feedback the artist has already
          // read but not yet Started. They've left the Rejected
          // inbox and can't sit in limbo — Start still renders
          // here. Admin keeps seeing them under Rejected.
          (isIn(p, ['iqa_rejected', 'eqa_rejected']) &&
            !hasUnreadFeedback(p))
      ),
    [projects]
  );
  // Rejected tabs behave as an INBOX: a row shows only while its
  // feedback is unread.
  const iqaRejectedProjects = useMemo(
    () =>
      projects.filter(
        (p) => isIn(p, ['iqa_rejected']) && hasUnreadFeedback(p)
      ),
    [projects]
  );
  const eqaRejectedProjects = useMemo(
    () =>
      projects.filter(
        (p) => isIn(p, ['eqa_rejected']) && hasUnreadFeedback(p)
      ),
    [projects]
  );
  const iqaProjects = useMemo(
    () => projects.filter((p) => isIn(p, ['qa_pending'])),
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
          // Artists only receive their OWN jobs, so a child whose
          // parent belongs to someone else won't resolve a name
          // here. TypeBadge renders a bare "Child" pill in that
          // case, which is the honest answer — the artist sees the
          // model is derived without being shown a job that isn't
          // theirs.
          const parentNames = new Map<string, string>(
            d.projects.map((p: { id: string; name: string }) => [
              p.id,
              p.name,
            ])
          );
          const norm = d.projects.map(
            (p: Project & { client: Project['client'] | Project['client'][] }) => ({
              ...p,
              client: Array.isArray(p.client) ? p.client[0] : p.client,
              model_type: p.model_type ?? 'parent',
              parent_id: p.parent_id ?? null,
              parent_name: p.parent_id
                ? parentNames.get(p.parent_id) ?? null
                : null,
            })
          );
          setProjects(norm);
        }
      });
  }

  // Keep the queue current without a manual reload. This matters
  // most on the artist side: an admin's IQA decision is what moves
  // a row into the Rejected inbox, and until now the artist had no
  // way to learn that had happened short of reloading.
  //
  // Safe here because the dashboard holds no unsaved edits — the
  // upload modal keeps its own file selection in its own state and
  // is unaffected by the list underneath it changing.
  useLiveRefresh(refreshList);

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

  // Start a single colourway. Same endpoint as the product-level
  // Start, with variant_id so only that variant leaves its queue.
  // ---- removed 2026-08-29: colourways are their own jobs, so
  // startProject above is the only Start path. ----

  // ----- Title + subtitle per mode -----
  const pageTitle = isOverviewMode ? 'Overview' : isJobsMode ? 'Jobs' : 'My Jobs';
  const pageSub = isOverviewMode
    ? 'A snapshot of your workload across every status.'
    : isJobsMode
    ? 'All jobs in one place. Switch tabs to focus on what needs attention.'
    : "Projects assigned to you. Open a brief to see what's needed, then upload your zip.";

  // Shared by the Overview and Jobs views, which now render the
  // same tabbed list. Built once so the two can't drift.
  const jobBuckets = {
    yts: ytsProjects,
    wip: wipProjects,
    iqa: iqaProjects,
    iqa_rejected: iqaRejectedProjects,
    eqa_rejected: eqaRejectedProjects,
    open: activeProjects,
    approved: completedProjects,
  };

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
          {/* Stat cards, with the same tabbed list underneath.
              Tapping a card selects the matching tab below rather
              than navigating to the Jobs page — the rows are
              already here, so a page change would only cost a
              round-trip. */}
          {isOverviewMode && (
            <>
              <OverviewPanel
                stats={stats}
                onJump={(tab) => {
                  setOverviewTab(tab);
                  // The cards can fill the viewport on a laptop, so
                  // without this the tab silently changes below the
                  // fold and the click reads as a no-op.
                  requestAnimationFrame(() => {
                    document
                      .getElementById('artist-jobs-list')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  });
                }}
              />

              <div id="artist-jobs-list" style={{ marginTop: 28 }}>
                {/* Keyed on the picked tab so a card click remounts
                    JobsTabs onto that tab. JobsTabs owns its own
                    tab state internally and only reads the hint on
                    mount — remounting is what lets the cards drive
                    it without turning it into a controlled
                    component for one caller's sake. */}
                <JobsTabs
                  key={overviewTab ?? 'default'}
                  buckets={jobBuckets}
                  initialTabHint={overviewTab}
                  starting={starting}
                  onStart={startProject}
                  onOpenBrief={(p) => setViewBrief(p)}
                  onUpload={(p) => setUploadFor(p)}
                />
              </div>
            </>
          )}

          {/* ============================== Jobs (tabbed) ============================== */}
          {/* Admin-style tab bar. Each tab swaps the list below
              without changing the URL — same UX as the admin
              Overview. The Overview cards above link in here
              with ?jobsTab=... pre-selected. */}
          {isJobsMode && (
            <JobsTabs
              buckets={jobBuckets}
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
// Seven stat cards. Each represents one tab of the job list
// rendered directly beneath it; tapping a card selects that tab
// in place. The "With client" card is non-interactive — those
// rows aren't artist-actionable and have no matching tab.
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
  onJump,
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
  onJump: (tab: JobsTabKey) => void;
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
                  ? `Show ${c.label} jobs in the list below`
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
          <th>Type</th>
          <th>Brief</th>
          <th>Reference</th>
          <th>Revision Round</th>
          <th>Status</th>
          <th>Updated</th>
          <th style={{ textAlign: 'right' }}>Action</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => {
          // One job, one row, one status. No lead-colourway
          // resolution: the row IS the thing being worked on.
          const rowStatus = p.status;
          const rowRev = p.revision_count;

          return (
          <tr key={p.id}>
            <td>
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
                  <strong style={{ display: 'block' }}>{p.name}</strong>
                  <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                    {p.slug}
                  </span>
                </span>
              </div>
            </td>
            <td>
              <TypeBadge
                modelType={p.model_type}
                parentId={p.parent_id}
                parentName={p.parent_name}
              />
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
              <ReferenceThumb project={p} />
            </td>
            <td>
              {rowRev === 0 ? (
                <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
                  —
                </span>
              ) : (
                <a
                  className="crm-link"
                  href={crmPath(
                    // source picks WHICH feedback table to read.
                    // On an EQA row the screenshots that matter
                    // are the CLIENT's — they're the reason the
                    // job came back. Without this the link
                    // silently showed the admin's older IQA
                    // round instead, and the client's markup was
                    // unreachable from the artist's side.
                    `/projects/${p.id}/feedback?revision=${rowRev}${
                      rowStatus === 'eqa_rejected' || rowStatus === 'eqa_wip'
                        ? '&source=client'
                        : ''
                    }`
                  )}
                  target="_blank"
                  rel="noreferrer"
                  title={
                    rowStatus === 'eqa_rejected' || rowStatus === 'eqa_wip'
                      ? `View the client's feedback for revision ${rowRev}`
                      : `View QA feedback for revision ${rowRev}`
                  }
                >
                  {rowRev}
                </a>
              )}
            </td>
            <td>
              <StatusBadge
                status={rowStatus}
                revisionCount={rowRev}
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
                Action cell is status-aware, driven by the LEAD
                colourway's status. Each state gets exactly one
                affordance:

                  draft         → Start
                  qa_pending    → "Awaiting QA review"
                  iqa_rejected  → Start
                  eqa_rejected  → Start
                  wip / *_wip   → Upload zip / Re-upload
                  client_review → "With client"
                  approved      → the original is done; its
                                  colourways carry on in their own
                                  child rows
              */}
              {(rowStatus === 'draft' ||
                rowStatus === 'iqa_rejected' ||
                rowStatus === 'eqa_rejected') && (
                <button
                  className="crm-btn"
                  onClick={() => onStart(p)}
                  disabled={!!starting[p.id]}
                >
                  {starting[p.id] ? 'Starting…' : 'Start'}
                </button>
              )}
              {rowStatus === 'qa_pending' && (
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  Awaiting QA review
                </span>
              )}
              {(rowStatus === 'wip' ||
                rowStatus === 'iqa_wip' ||
                rowStatus === 'eqa_wip') && (
                <button className="crm-btn" onClick={() => onUpload(p)}>
                  {rowRev === 0 ? 'Upload zip' : 'Re-upload'}
                </button>
              )}
              {rowStatus === 'client_review' && (
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  With client
                </span>
              )}
              {rowStatus === 'approved' && (
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  Approved
                </span>
              )}
            </td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ============================================================
// Reference cell — thumbnail of the first reference image,
// linked to the full gallery. Mirrors the admin dashboard so the
// two tables read the same way.
//
// thumb_url is collapsed server-side from the references join, so
// there's no per-row fetch. Jobs with no references fall back to
// a dim em-dash rather than a link, since the gallery would just
// show its empty state.
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
          <th>Type</th>
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
              <TypeBadge
                modelType={p.model_type}
                parentId={p.parent_id}
                parentName={p.parent_name}
              />
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

  // ---- Upload target ----
  // The job itself. There is no chooser: colourways used to be
  // sub-rows sharing one product, so the modal had to ask which
  // one a zip was for. Since the 2026-08-29 promotion each
  // colourway is its own job with its own row and its own Upload
  // button, so the target is unambiguous by the time we get here.

  // Expected filename stem for this upload: the job's own slug.
  //
  // This used to be `project.slug.split('-')[0]` plus the variant
  // slug, because a colourway needed its own namespace carved out
  // of its parent's slug ("smart" + "grey" -> "smart-grey"). That
  // only ever produced the right answer for single-word slugs:
  // "model-45" collapsed to "model", so the artist was told to
  // name the zip "model.zip" while the server wrote assets under
  // "model-45/", and the upload was blocked by its own
  // client-side check.
  //
  // The stem is now just the slug, which is exactly what
  // upload-sign and finalize-upload use server-side.
  const assetBase = project.slug.toLowerCase();

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
    // Filename stem for this upload target — the job's own slug,
    // matching the prefix the server writes assets under.
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
          body: JSON.stringify({}),
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
          <strong style={{ color: 'var(--danger)' }}>Required:</strong> name
          everything{' '}
          <strong
            style={{
              fontSize: 15,
              color: 'var(--text)',
              fontFamily:
                'var(--crm-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            }}
          >
            {base}
          </strong>{' '}
          — the zip and every file inside it. Keep each file&apos;s own
          extension; only change the part before the dot. Each file goes in its
          matching folder above. If anything is missing or misnamed, the upload
          is blocked. Max {MAX_UPLOAD_MB} MB total.
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
