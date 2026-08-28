import { ProjectStatus } from '../lib/supabase';

type Props = {
  status: ProjectStatus;
  revisionCount?: number;
  // Optional context flag. When status='draft' and assigned=true,
  // the badge renders YTS (Yet To Start) instead of YTA. The
  // status column alone can't tell these apart — both rows are
  // status='draft', the difference is whether an artist is on it.
  assigned?: boolean;
};

export default function StatusBadge({
  status,
  revisionCount = 0,
  assigned = false,
}: Props) {
  if (status === 'draft') {
    // Two flavours under one status:
    //   YTA — Yet To Assign (no artist yet, client just created it)
    //   YTS — Yet To Start (artist assigned, hasn't clicked Start)
    if (assigned) {
      return <span className="crm-badge crm-badge-wip">YTS</span>;
    }
    return <span className="crm-badge crm-badge-draft">YTA</span>;
  }
  if (status === 'on_hold') {
    // Parked by the client. Deliberately its own colour rather
    // than reusing draft's grey or WIP's amber: a held job is
    // neither waiting to start nor being worked on, and reading
    // it as either would put it back in someone's mental queue.
    // Checked early so it wins over every stage below — the row
    // it sits on is blocked regardless of where it paused.
    return (
      <span
        className="crm-badge crm-badge-hold"
        title="Paused by the client. Nobody should be working on this until it's resumed."
      >
        On Hold by Client
      </span>
    );
  }
  if (status === 'qa_pending') {
    return <span className="crm-badge crm-badge-pending">IQA</span>;
  }
  if (status === 'iqa_rejected') {
    // Admin sent the artist back for revision. The Revision column
    // already carries the round number, so the badge just shows
    // the label — prevents the count appearing twice in the same
    // row.
    return (
      <span className="crm-badge crm-badge-rejected">IQA Rejected</span>
    );
  }
  if (status === 'eqa_rejected') {
    // Client rejected during their sign-off review; back to admin.
    // Same red palette so the urgency reads the same, label-only
    // since the Revision column carries the round number.
    return (
      <span className="crm-badge crm-badge-rejected">EQA Rejected</span>
    );
  }
  if (status === 'wip') {
    // Amber/warn token — visually distinct from QA Pending (also
    // orange but lighter) and Rejected (red). Reads as "in progress".
    return <span className="crm-badge crm-badge-wip">WIP</span>;
  }
  if (status === 'iqa_wip') {
    // Artist is responding to admin's IQA feedback. Same amber
    // palette as plain WIP so the visual stage reads the same,
    // but the label tells the admin's WIP tab what kind of work
    // is in flight (a revision, not a fresh build).
    return <span className="crm-badge crm-badge-wip">IQA WIP</span>;
  }
  if (status === 'eqa_wip') {
    // Artist is responding to client's EQA feedback. Same amber
    // palette as plain WIP; label distinguishes the origin so the
    // admin can prioritise client-driven work appropriately.
    return <span className="crm-badge crm-badge-wip">EQA WIP</span>;
  }
  if (status === 'client_review') {
    // Distinct from 'qa_pending' — same shape, but blue/info colour
    // so admins reading the dashboard immediately see this isn't
    // their queue. Clients see this as "awaiting your review".
    return (
      <span className="crm-badge crm-badge-client-review">
        EQA
      </span>
    );
  }
  return <span className="crm-badge crm-badge-approved">Approved</span>;
}
