'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Sidebar from '../components/Sidebar';
import { crmPath } from '../lib/client-fetch';

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
};

type Brand = { id: string; slug: string; name: string };

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
  const searchParams = useSearchParams();
  const [projects] = useState<Project[]>(initialProjects);

  // ----- Mode plumbing -----
  const tabParam = searchParams?.get('tab');
  const isAllocatedMode = tabParam === 'allocated';
  const isApprovedMode = tabParam === 'approved';
  const isQaMode = !isAllocatedMode && !isApprovedMode && tabParam === 'pending';

  // ----- Bucket projects -----
  const review = projects.filter((p) => p.status === 'client_review');
  const history = projects.filter((p) => p.status === 'approved');
  const clientRejected = projects.filter(
    (p) =>
      p.status !== 'approved' &&
      (p.status === 'eqa_rejected' || p.has_client_rejection)
  );
  const notApproved = projects.filter(
    (p) =>
      p.status !== 'client_review' &&
      p.status !== 'approved' &&
      p.status !== 'eqa_rejected' &&
      !p.has_client_rejection
  );
  const allocated = projects.filter((p) => p.status !== 'approved');

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
function clientStatusLabel(p: Project): string {
  if (p.status === 'approved') return 'Approved';
  if (p.status === 'client_review') return 'EQA';
  if (p.status === 'eqa_rejected' || p.has_client_rejection) return 'EQA Rejected';
  return 'Open';
}

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
// ============================================================
function ProjectTable({
  projects,
  showAsset,
  showReviewAction = false,
  showRevision = false,
  forceStatusLabel,
}: {
  projects: Project[];
  showAsset: boolean;
  showReviewAction?: boolean;
  showRevision?: boolean;
  forceStatusLabel?: string;
}) {
  function fallbackLabel(p: Project): string {
    if (p.status === 'approved') return 'Approved';
    if (p.status === 'client_review') return 'EQA';
    if (p.status === 'eqa_rejected' || p.has_client_rejection) return 'EQA Rejected';
    return 'Open';
  }

  // Build the feedback-gallery URL for a given project + revision.
  // The `source=client` param tells the gallery page to read from
  // uflow_client_feedback_images (the client's own screenshots)
  // rather than the admin-side feedback table the client never
  // has access to. The server still enforces brand scoping.
  function feedbackHref(projectId: string, revision: number): string {
    return crmPath(
      `/projects/${projectId}/feedback?revision=${revision}&source=client`
    );
  }

  return (
    <table className="crm-table">
      <thead>
        <tr>
          <th>Project</th>
          <th>References</th>
          {showRevision && <th>Revision Round</th>}
          <th>Created</th>
          {showAsset && <th>Asset</th>}
          <th>Status</th>
          {/* Action sits last so the row reads left-to-right as
              "what is it → what state is it in → what can I do".
              On EQA rows the Review link lives here. */}
          {showReviewAction && <th>Action</th>}
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
                href={crmPath(`/admin/qa/${p.id}/references`)}
                target="_blank"
                rel="noreferrer"
                className="crm-link"
              >
                View
              </a>
            </td>
            {showRevision && (
              <td>
                {/* Revision Round. Shows the latest rejection round
                    as a clickable number. The standalone feedback
                    gallery (opened in a new tab) has its own
                    revision picker, so a dropdown here would just
                    duplicate that affordance.
                    - 0 rejections : em-dash placeholder
                    - N rejections : single "N" hyperlink to the
                                     gallery scoped to revision N */}
                {p.revision_count === 0 ? (
                  <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
                    —
                  </span>
                ) : (
                  <a
                    className="crm-link"
                    href={feedbackHref(p.id, p.revision_count)}
                    target="_blank"
                    rel="noreferrer"
                    title={`View your feedback from revision ${p.revision_count}`}
                  >
                    {p.revision_count}
                  </a>
                )}
              </td>
            )}
            <td style={{ color: 'var(--text-dim)' }}>
              {new Date(p.created_at).toLocaleDateString()}
            </td>
            {showAsset && (
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
              <ClientStatusPill
                label={forceStatusLabel ?? fallbackLabel(p)}
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}
