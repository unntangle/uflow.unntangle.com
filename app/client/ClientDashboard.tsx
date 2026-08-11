'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { crmFetch, crmPath } from '../lib/client-fetch';
import {
  useTableSort,
  SortableTh,
  statusRank,
} from '../lib/use-table-sort';
import {
  anyVariantIn,
  allVariantsApproved,
  rollupStatus,
} from '../lib/variant-status';

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
  // Client-facing revision round count. This is the number of
  // distinct rounds the CLIENT (EQA) rejected — derived server-
  // side from uflow_client_feedback_images. It deliberately
  // EXCLUDES internal IQA rejection rounds that are otherwise
  // folded into `revision_count`, so the client never sees the
  // internal admin/artist back-and-forth.
  client_revision_count?: number;
  // Highest client (EQA) revision number on record. Used only to
  // deep-link into the client's feedback gallery. null when the
  // client has never rejected.
  latest_client_revision?: number | null;
  glb_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  created_at: string;
  updated_at: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  // Set server-side from a count of uflow_client_feedback_images
  // rows. Used as a fallback signal for the EQA Rejected bucket
  // — a project that was rejected by the client and then later
  // re-routed (e.g. back to client_review for a fresh attempt)
  // still belongs in EQA Rejected from the client's POV until
  // it's finally approved.
  has_client_rejection?: boolean;
  // Colourways of this product. Each one runs the nine-state
  // pipeline independently, and since the 2026-08-06 variants
  // migration THESE rows — not the product's own status column —
  // are where per-model state actually lives. Every bucket and
  // badge below derives from them; see lib/variant-status.ts.
  variants?: Variant[];
  // URL of the earliest reference image, collapsed server-side
  // from the uflow_project_references join. Null when the job was
  // created without references. Drives the References column
  // thumbnail; the full set still lives on the gallery page.
  thumb_url?: string | null;
};

// A colourway. Carries its own status because Grey can be sitting
// in the client's EQA queue while Black is still with the artist.
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

type Brand = { id: string; slug: string; name: string };

// ============================================================
// Client-facing state derivation
// ============================================================
// "What state is this job in for the client?" is a question
// about the COLOURWAYS, not about uflow_projects.status — the
// variants migration left that column behind on everything but
// the legacy single-model path, so admin forwarding a colourway
// to EQA never touches it. Reading it directly is exactly why
// the client's EQA tab sat empty while admin's showed a queue.
//
// Membership uses ANY-variant, the same rule the admin Overview
// applies: a product with Black awaiting sign-off and Grey still
// with the artist belongs in EQA, because there IS something the
// client can act on. Approved is the exception — it needs EVERY
// colourway signed off, which is what allVariantsApproved gives.
//
// Both helpers fall back to the product's own status column when
// a job has no variant rows at all (pre-migration data), so
// nothing regresses for legacy jobs.
function inEqa(p: Project): boolean {
  return anyVariantIn(p, ['client_review']);
}

function isApproved(p: Project): boolean {
  return allVariantsApproved(p);
}

// Rejected by the client. `has_client_rejection` keeps a job in
// this bucket even after it's been re-routed, until it's finally
// approved — from the client's POV a job they pushed back on is
// still theirs to watch.
function inEqaRejected(p: Project): boolean {
  return anyVariantIn(p, ['eqa_rejected']) || !!p.has_client_rejection;
}

// The single client-facing label for a row. Ordered by what the
// client most needs to know: finished, then actionable, then
// pushed back, then everything still internal.
function clientStatusLabel(p: Project): string {
  if (isApproved(p)) return 'Approved';
  if (inEqa(p)) return 'EQA';
  if (inEqaRejected(p)) return 'EQA Rejected';
  return 'Open';
}

// Is there a model to look at? The product's own glb_url is only
// written on the legacy single-model path, so a variant job would
// otherwise render an empty Asset cell while sitting in the EQA
// queue with a model the client is being asked to sign off on.
function hasViewableModel(p: Project): boolean {
  if (p.approved_glb_url || p.glb_url) return true;
  return (p.variants ?? []).some((v) => v.approved_glb_url || v.glb_url);
}

// Edit / Delete are only offered before an artist picks the job
// up. Derived from the roll-up rather than p.status for the same
// staleness reason — a job whose colourway is mid-revision can
// still read 'draft' on the product row. The server re-checks
// this independently in /api/client/projects/[id]; this is just
// the affordance.
function isEditableByClient(p: Project): boolean {
  return rollupStatus(p) === 'draft';
}

// ============================================================
// ClientDashboard
//
// The client sees a deliberately small view of the internal
// pipeline. Anything still being worked on by admin/artist is
// rolled up under one banner ("Open Jobs") so the client
// isn't tracking handoffs that don't concern them.
//
// Four URL-driven modes:
//   /client                  → Overview (4-tab list)
//   /client?tab=allocated    → Allocated Jobs (single-table, every in-flight job)
//   /client?tab=approved     → Approved Jobs (single-table, signed-off jobs)
//   /client?tab=pending      → Quality Audit (same 4-tab list, opens on EQA)
//
// Client-visible buckets on the Overview/Quality-Audit tab bar:
//   1. EQA           — admin has approved the artist's work; awaiting client sign-off (status=client_review)
//   2. EQA Rejected  — client rejected during their own review (status=eqa_rejected, plus any historical rejections still in flight)
//   3. Open Jobs     — pre-EQA work (draft/wip/qa_pending/iqa_rejected)
//   4. Approved      — signed off by the client (final)
//
// Admin-side rejections (status='iqa_rejected') intentionally do
// NOT surface as a rejected-style tab here; from the client's POV
// that's still "not approved yet" — an internal handoff. They
// appear inside the "Open Jobs" bucket.
//
// The client cannot:
//   - Assign artists (admin only)
//   - Approve / reject admin-stage submissions (admin QA does that)
//   - See other brands' jobs (server-side scoping prevents this)
//
// Feedback viewing happens on /projects/[id]/feedback (new tab),
// not in a modal — mirrors the References gallery so users can
// keep the dashboard visible while inspecting screenshots.
// ============================================================
export default function ClientDashboard({
  initialProjects,
  brand,
  currentUser,
}: {
  initialProjects: Project[];
  brand: Brand;
  currentUser: { name: string; role: 'client' };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<Project[]>(initialProjects);

  // ----- Delete-confirmation modal state -----
  // Lives at the dashboard level (not per-row) so the modal can
  // render once on top of any tab without each row having to
  // mount its own. `pending` carries the project the user just
  // hit Delete on; clearing it closes the modal.
  const [pending, setPending] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pending) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      const res = await crmFetch(`/api/client/projects/${pending.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteErr(data.error || 'Could not delete this job.');
        return;
      }
      // Optimistically splice out of local state so the row
      // disappears immediately. Also kick a router.refresh() so
      // the server-rendered initialProjects on the next nav stays
      // in sync (e.g. if the user reloads, the row stays gone).
      setProjects((prev) => prev.filter((p) => p.id !== pending.id));
      setPending(null);
      router.refresh();
    } catch (e) {
      setDeleteErr((e as Error).message || 'Network error.');
    } finally {
      setDeleting(false);
    }
  }

  // ----- Mode plumbing -----
  const tabParam = searchParams?.get('tab');
  const isAllocatedMode = tabParam === 'allocated';
  const isApprovedMode = tabParam === 'approved';
  const isQaMode = !isAllocatedMode && !isApprovedMode && tabParam === 'pending';

  // ----- Bucket projects -----
  // Every bucket goes through the colourway-aware helpers above.
  // Open Jobs stays defined as "none of the other three", so the
  // four tabs still read as a partition of the client's list.
  const review = projects.filter(inEqa);
  const history = projects.filter(isApproved);
  const clientRejected = projects.filter(
    (p) => !isApproved(p) && inEqaRejected(p)
  );
  const notApproved = projects.filter(
    (p) => !isApproved(p) && !inEqa(p) && !inEqaRejected(p)
  );
  const allocated = projects.filter((p) => !isApproved(p));

  // ----- Tab plumbing -----
  type Tab = 'not_approved' | 'review' | 'client_rejected' | 'history';

  // Both Overview and Quality Audit open on EQA — the actionable
  // queue. Lands the client on what they can immediately act on
  // rather than on the passive rollup of in-flight jobs.
  const defaultTab: Tab = 'review';

  function resolveTab(raw: string | null | undefined): Tab | null {
    if (!raw) return null;
    if (raw === 'not_approved' || raw === 'open' || raw === 'wip') {
      return 'not_approved';
    }
    if (raw === 'review' || raw === 'pending') return 'review';
    if (raw === 'client_rejected' || raw === 'rejected') return 'client_rejected';
    if (raw === 'history' || raw === 'approved_tab') return 'history';
    return null;
  }

  const validTab = resolveTab(tabParam);
  const initialTab: Tab = validTab ?? defaultTab;
  const [tab, setTab] = useState<Tab>(initialTab);

  // ----- Title + subtitle per mode -----
  const pageTitle = isAllocatedMode
    ? 'Allocated Jobs'
    : isApprovedMode
    ? 'Approved Jobs'
    : isQaMode
    ? 'EQA'
    : 'Overview';
  const pageSub = isAllocatedMode
    ? `${brand.name} · Jobs handed to artists and working their way through.`
    : isApprovedMode
    ? `${brand.name} · Jobs you've signed off on. Final GLBs ready to use.`
    : isQaMode
    ? `${brand.name} · Models waiting for your final approval, plus any you've rejected.`
    : `${brand.name} · All 3D modelling jobs for your brand.`;

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
              <h1 className="crm-page-title">{pageTitle}</h1>
              <p className="crm-page-sub">{pageSub}</p>
            </div>
            {/* Download CSV — Overview only. Skipped in the
                Allocated / Approved sidebar modes and in Quality
                Audit since those are scoped, single-purpose views;
                Overview is the "all jobs" landing where an export
                makes the most sense. Dumps name + display status
                (Open / EQA / EQA Rejected / Approved) for every
                row the client can see. Client-side only — the
                data is already in memory. */}
            {!isAllocatedMode && !isApprovedMode && !isQaMode && projects.length > 0 && (
              <button
                type="button"
                className="crm-btn crm-btn-secondary"
                onClick={() => downloadProjectsCsv(projects)}
                title="Download every project as a CSV with name + status"
              >
                Download CSV
              </button>
            )}
          </header>

          {/* ============================== Allocated Jobs mode ============================== */}
          {/* Heterogeneous single-table — every in-flight job
              regardless of bucket. Includes the Revision Round
              column so the client can pull up feedback history
              across the whole pipeline. */}
          {isAllocatedMode && (
            allocated.length === 0 ? (
              <EmptyMini message="No allocated jobs yet. Create a job to get started." />
            ) : (
              <ProjectTable
                projects={allocated}
                showAsset={true}
                showRevision={true}
                onDelete={setPending}
              />
            )
          )}

          {/* ============================== Approved Jobs mode ============================== */}
          {isApprovedMode && (
            history.length === 0 ? (
              <EmptyMini message="No approved jobs yet." />
            ) : (
              <ProjectTable
                projects={history}
                showAsset={true}
                showRevision={true}
              />
            )
          )}

          {/* ============================== Tab bar (Overview + QA modes) ============================== */}
          {!isAllocatedMode && !isApprovedMode && (
            <div className="crm-tabs" role="tablist" aria-label="My projects">
              {/* Tab order: EQA → EQA Rejected → Open Jobs → Approved.
                  Client-actionable queues (EQA, EQA Rejected) sit
                  first so the client lands on what needs their
                  attention; Open Jobs (passive rollup) and
                  Approved (terminal state) follow. */}
              <button
                role="tab"
                aria-selected={tab === 'review'}
                className={`crm-tab ${tab === 'review' ? 'is-active' : ''}`}
                onClick={() => setTab('review')}
              >
                EQA
                <span className="crm-tab-count">{review.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={tab === 'client_rejected'}
                className={`crm-tab ${tab === 'client_rejected' ? 'is-active' : ''}`}
                onClick={() => setTab('client_rejected')}
              >
                EQA Rejected
                <span className="crm-tab-count">{clientRejected.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={tab === 'not_approved'}
                className={`crm-tab ${tab === 'not_approved' ? 'is-active' : ''}`}
                onClick={() => setTab('not_approved')}
              >
                Open Jobs
                <span className="crm-tab-count">{notApproved.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={tab === 'history'}
                className={`crm-tab ${tab === 'history' ? 'is-active' : ''}`}
                onClick={() => setTab('history')}
              >
                Approved
                <span className="crm-tab-count">{history.length}</span>
              </button>
            </div>
          )}

          {/* ============================== Open Jobs ============================== */}
          {/* Asset column is on so any row that's already uploaded
              (wip with a revision, qa_pending, iqa_rejected) shows
              View GLB. Pre-upload rows fall through the cell-level
              `p.approved_glb_url || p.glb_url` guard and render
              an empty Asset cell. */}
          {!isAllocatedMode && !isApprovedMode && tab === 'not_approved' && (
            notApproved.length === 0 ? (
              <EmptyMini message="Nothing in progress right now." />
            ) : (
              <ProjectTable
                projects={notApproved}
                showAsset={true}
                forceStatusLabel="Open"
                onDelete={setPending}
              />
            )
          )}

          {/* ============================== EQA (client's review queue) ============================== */}
          {!isAllocatedMode && !isApprovedMode && tab === 'review' && (
            review.length === 0 ? (
              <EmptyMini message="Nothing awaiting your review." />
            ) : (
              <ProjectTable
                projects={review}
                showAsset={true}
                showReviewAction={true}
                showRevision={true}
                forceStatusLabel="EQA"
              />
            )
          )}

          {/* ============================== EQA Rejected ============================== */}
          {!isAllocatedMode && !isApprovedMode && tab === 'client_rejected' && (
            clientRejected.length === 0 ? (
              <EmptyMini message="You haven't rejected any submissions." />
            ) : (
              <ProjectTable
                projects={clientRejected}
                showAsset={true}
                showRevision={true}
                forceStatusLabel="EQA Rejected"
              />
            )
          )}

          {/* ============================== Approved ============================== */}
          {!isAllocatedMode && !isApprovedMode && tab === 'history' && (
            history.length === 0 ? (
              <EmptyMini message="No approved jobs yet." />
            ) : (
              <ProjectTable
                projects={history}
                showAsset={true}
                showRevision={true}
                forceStatusLabel="Approved"
              />
            )
          )}
        </div>
      </main>

      {/* ============================== Delete confirmation modal ============================== */}
      {/* Centralised at the dashboard level so any tab can trigger
          it via setPending(...). Click-outside (backdrop) cancels;
          the modal itself stops propagation so clicks inside don't
          dismiss. Confirmation is required because the action is
          irreversible — the DB row plus its references cascade out
          immediately. */}
      {pending && (
        <div
          className="crm-modal-backdrop"
          onClick={() => {
            if (!deleting) {
              setPending(null);
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
                  setPending(null);
                  setDeleteErr(null);
                }}
                disabled={deleting}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p style={{ marginTop: 0, color: 'var(--text-dim)' }}>
              <strong style={{ color: 'var(--text)' }}>{pending.name}</strong>{' '}
              will be permanently removed, along with any reference
              images you uploaded. This can’t be undone.
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
                  setPending(null);
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
                {deleting ? 'Deleting…' : 'Delete job'}
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
// Two-column CSV — Project name + Status — for every row the
// client can see. Status uses the same client-facing vocabulary
// the dashboard renders (Open / EQA / EQA Rejected / Approved),
// derived via the same fallbackLabel logic ProjectTable uses,
// so what's in the file matches what's on screen.
//
// Triggered client-side via Blob + anchor.download — no server
// round-trip needed. Values escaped per RFC 4178 (every value
// quoted, embedded quotes doubled) and prefixed with a UTF-8
// BOM so Excel detects the encoding for non-ASCII project names.
// ============================================================
// clientStatusLabel is defined once near the top of this file,
// alongside the bucket helpers, so the CSV, the status pill and
// the tab counts can never disagree about what a row reads as.
function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadProjectsCsv(projects: Project[]) {
  const header = ['Project', 'Status'];
  const rows = projects.map((p) => [p.name, clientStatusLabel(p)]);
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
  a.download = `uflow-overview-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
// References cell — thumbnail of the first reference image,
// hyperlinked to the full gallery in a new tab (the same target
// the old "View" text link used). Mirrors the admin dashboard's
// ReferenceThumb so a job's References cell reads identically on
// both sides.
//
// `thumb_url` is collapsed server-side from the references join,
// so there's no per-row fetch here. When a job was created with
// no references there's nothing to show, so we fall back to a
// dim em-dash — deliberately NOT a link, since the gallery would
// just render its empty state.
//
// The <img> is intentionally raw rather than next/image: these
// are remote R2 URLs on arbitrary hosts, and adding them to
// next.config remotePatterns is a bigger change than this column
// warrants.
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

// ============================================================
// Client-facing status pill.
// ============================================================
function ClientStatusPill({ label }: { label: string }) {
  let cls = 'crm-badge-draft';
  if (label === 'Approved') cls = 'crm-badge-approved';
  else if (label === 'EQA Rejected') cls = 'crm-badge-rejected';
  else if (label === 'EQA') cls = 'crm-badge-client-review';
  return <span className={`crm-badge ${cls}`}>{label}</span>;
}

// ============================================================
// Shared project list table for client tabs.
//
// Props:
//   - showAsset:        adds a "Asset" column (View GLB)
//   - showReviewAction: adds an "Action" column (Review link)
//   - showRevision:     adds a "Revision Round" column with the
//                       same dropdown/link behaviour as the
//                       artist dashboard. Each entry navigates
//                       (new tab) to /projects/[id]/feedback so
//                       the client can review the screenshots
//                       they uploaded for that revision.
//   - forceStatusLabel: when set, every row's status pill shows
//                       this label instead of the per-row fallback.
//   - onDelete:         opens the delete-confirmation modal for
//                       a row. The button only renders for rows
//                       still in 'draft' — once admin has
//                       allocated the job, the client can no
//                       longer mutate it (the server enforces
//                       this independently in /api/client/projects/[id]).
// ============================================================
function ProjectTable({
  projects,
  showAsset,
  showReviewAction = false,
  showRevision = false,
  forceStatusLabel,
  onDelete,
}: {
  projects: Project[];
  showAsset: boolean;
  showReviewAction?: boolean;
  showRevision?: boolean;
  forceStatusLabel?: string;
  onDelete?: (p: Project) => void;
}) {
  // Build the feedback-gallery URL for a given project, scoped to
  // the client's own EQA feedback. `source=client` tells the
  // gallery to read from uflow_client_feedback_images (the
  // client's screenshots) rather than the admin-side IQA table
  // the client never has access to. We deep-link to the client's
  // latest rejection round so the gallery opens with a concrete,
  // valid revision filter (the revision picker then lets them
  // step back through earlier rounds). Linking without a revision
  // would land the gallery in its "all revisions" mode, whose
  // controlled <select> has no matching option when only one
  // round exists — which caused the page to flicker on load.
  // The server still enforces brand scoping.
  function clientFeedbackHref(
    projectId: string,
    revision: number | null | undefined
  ): string {
    const params = new URLSearchParams();
    if (typeof revision === 'number') params.set('revision', String(revision));
    params.set('source', 'client');
    return crmPath(`/projects/${projectId}/feedback?${params.toString()}`);
  }

  // Per-column sort. Project sorts A-Z by name; Revision Round
  // numerically; Created chronologically; Status by the client-
  // facing label rank (Open -> EQA -> EQA Rejected -> Approved).
  // References/Asset/Action/Actions are links or controls, not
  // sortable data. Cycles asc -> desc -> off.
  const clientStatusRank = (p: Project): number => {
    const label = forceStatusLabel ?? clientStatusLabel(p);
    const order: Record<string, number> = {
      Open: 0,
      EQA: 1,
      'EQA Rejected': 2,
      Approved: 3,
    };
    return order[label] ?? 99;
  };
  const { sorted, sort, onSort } = useTableSort(projects, {
    name: (p) => p.name,
    revision: (p) => p.client_revision_count ?? 0,
    created: (p) => new Date(p.created_at),
    status: (p) => clientStatusRank(p),
  });

  return (
    <table className="crm-table">
      <thead>
        <tr>
          <SortableTh label="Project" sortKey="name" sort={sort} onSort={onSort} />
          <th>References</th>
          {showRevision && (
            <SortableTh label="Revision Round" sortKey="revision" sort={sort} onSort={onSort} />
          )}
          <SortableTh label="Created" sortKey="created" sort={sort} onSort={onSort} />
          {showAsset && <th>Asset</th>}
          <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
          {/* Action sits last so the row reads left-to-right as
              "what is it → what state is it in → what can I do".
              On EQA rows the Review link lives here. */}
          {showReviewAction && <th>Action</th>}
          {/* Manage — Edit/Delete for jobs still in draft (i.e.
              not yet allocated to an artist). The column always
              renders when onDelete is wired in, even on tabs
              where no row is in draft, so the layout stays
              consistent. Non-draft rows show an em-dash.
              Width is pinned because table-layout: fixed would
              otherwise share columns evenly — with 7 columns
              that leaves no room for two icon+label buttons. */}
          {onDelete && (
            <th style={{ textAlign: 'right', width: 180 }}>Actions</th>
          )}
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
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
            {showRevision && (
              <td>
                {/* Revision Round (client-facing). Shows ONLY the
                    rounds the client themselves rejected (EQA) —
                    internal IQA rejections are excluded upstream
                    so the client never sees the admin/artist
                    back-and-forth. The number is a clickable
                    count linking to the client's feedback gallery.
                    - 0 client rejections : em-dash placeholder
                    - N client rejections : "N" hyperlink to the
                                            client-side gallery */}
                {(p.client_revision_count ?? 0) === 0 ? (
                  <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
                    —
                  </span>
                ) : (
                  <a
                    className="crm-link"
                    href={clientFeedbackHref(p.id, p.latest_client_revision)}
                    target="_blank"
                    rel="noreferrer"
                    title={`View your feedback — ${p.client_revision_count} rejection round${
                      (p.client_revision_count ?? 0) === 1 ? '' : 's'
                    }`}
                  >
                    {p.client_revision_count}
                  </a>
                )}
              </td>
            )}
            <td style={{ color: 'var(--text-dim)' }}>
              {new Date(p.created_at).toLocaleDateString()}
            </td>
            {showAsset && (
              <td>
                {hasViewableModel(p) && (
                  <a
                    className="crm-link"
                    // In-app viewer, not the raw R2 URL — a .glb
                    // link makes the browser download the file
                    // rather than show the model. Same route the
                    // References link above already uses, which
                    // scopes to the caller's own brand server-side.
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
              <ClientStatusPill
                label={forceStatusLabel ?? clientStatusLabel(p)}
              />
            </td>
            {showReviewAction && (
              <td>
                <a
                  className="crm-link"
                  href={crmPath(`/client/qa/${p.id}`)}
                >
                  Review
                </a>
              </td>
            )}
            {onDelete && (
              <td style={{ textAlign: 'right' }}>
                {isEditableByClient(p) ? (
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      justifyContent: 'flex-end',
                      // Buttons must not break onto two lines
                      // ("Edi / t") when the column is tight —
                      // the parent <td> has word-break: break-word
                      // for long slugs/emails, which we have to
                      // explicitly opt out of here.
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <a
                      className="crm-btn crm-btn-ghost crm-btn-icon"
                      href={crmPath(`/client/${p.id}/edit`)}
                      title="Edit name, brief, and references"
                      style={{
                        textDecoration: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Pencil size={14} strokeWidth={1.75} />
                      <span>Edit</span>
                    </a>
                    <button
                      type="button"
                      className="crm-btn crm-btn-ghost-danger crm-btn-icon"
                      onClick={() => onDelete(p)}
                      title="Delete this job"
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                      <span>Delete</span>
                    </button>
                  </div>
                ) : (
                  <span
                    style={{ color: 'var(--text-faint)', fontSize: 13 }}
                    title="Locked once an artist is allocated. Contact your admin for changes."
                  >
                    —
                  </span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
