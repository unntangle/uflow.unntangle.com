// ============================================================
// Status vocabulary — labels + the selectable targets
// ============================================================
// Single source of truth for anywhere a ProjectStatus needs to
// be RENDERED, and for the restricted set an admin may move a
// job TO from the Change Status page. Imported by both that page
// and the status route handler so the dropdown and the API can't
// drift apart.
//
// Labels match StatusBadge's wording exactly. That matters: a
// table showing an "IQA" badge next to copy reading "QA Pending"
// would look like two different states. Reword a badge, reword
// it here too.
//
// The YTA / YTS problem
// ---------------------
// These are NOT two statuses. Both are stored as 'draft', and
// StatusBadge picks the label from a second input: draft with no
// artist reads YTA (Yet To Assign), draft with an artist reads
// YTS (Yet To Start).
//
// So a dropdown offering YTA and YTS is not offering two status
// values — it's offering one status plus a decision about the
// assignment. That's why the two targets below carry
// `clearsAssignment` and why the API takes it as a separate
// flag: writing status alone would make picking YTA silently
// land on YTS whenever an artist was already on the job.
// ============================================================

import type { ProjectStatus } from './supabase';

// Badge-matching label for every stored status. Used for the
// "from" side of a change, which can be any stage in the
// pipeline even though only draft can be moved to.
export const STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: 'Draft',
  wip: 'WIP',
  iqa_wip: 'IQA WIP',
  eqa_wip: 'EQA WIP',
  qa_pending: 'IQA',
  iqa_rejected: 'IQA Rejected',
  client_review: 'EQA',
  eqa_rejected: 'EQA Rejected',
  approved: 'Approved',
  on_hold: 'On Hold by Client',
};

// What a row reads as on screen right now. Takes the assignment
// because 'draft' alone can't tell YTA from YTS — same split
// StatusBadge performs.
export function currentStatusLabel(
  status: ProjectStatus,
  assigned: boolean
): string {
  if (status === 'draft') return assigned ? 'YTS' : 'YTA';
  return STATUS_LABELS[status] ?? String(status);
}

// ============================================================
// Selectable targets
// ============================================================
// Two kinds of move, and they are not the same kind of thing.
//
// RESET (yta / yts) sends a job back to the START of the
// pipeline. Everything forward of draft is reached by doing the
// work (Start, upload, approve, reject), and those paths write
// revision counts and files that a raw status write would leave
// inconsistent — which is why no stage in between is offered.
//
// PARK (hold / resume) takes a job OUT of the pipeline and puts
// it back. On Hold by Client isn't a stage, so it doesn't
// contradict the rule above: holding doesn't claim the work
// reached some point it didn't, it claims nobody is allowed to
// touch it. Resume is its exact inverse — it restores the stage
// the job paused at, read from hold_prev_status on the server.
//
// Resume is the reason hold is safe to offer at all. Without it
// the only way out of a hold would be a reset, so pausing a job
// awaiting client sign-off would cost it the entire pipeline
// back to draft.
export type StatusTarget = 'yta' | 'yts' | 'hold' | 'resume';

export type StatusTargetOption = {
  value: StatusTarget;
  label: string;
  // The status actually written. 'yta' and 'yts' are both
  // 'draft' — see the YTA/YTS note above.
  //
  // null on 'resume': the destination is whatever the row was
  // doing before it was held, which lives in hold_prev_status
  // and is resolved server-side. The client sends { resume: true }
  // rather than a status it would have to guess.
  status: ProjectStatus | null;
  // Whether picking this also removes the artist from the job.
  clearsAssignment: boolean;
  hint: string;
};

export const STATUS_TARGET_OPTIONS: StatusTargetOption[] = [
  {
    value: 'yta',
    label: 'YTA — Yet To Assign',
    status: 'draft',
    clearsAssignment: true,
    hint: 'Back to the start and unassigned. The job returns to Job Allocation for an artist to be picked.',
  },
  {
    value: 'yts',
    label: 'YTS — Yet To Start',
    status: 'draft',
    clearsAssignment: false,
    hint: "Back to the start, artist kept. It reappears in that artist's queue waiting for them to click Start.",
  },
  {
    value: 'hold',
    label: 'On Hold by Client',
    status: 'on_hold',
    // The artist stays on the job. A hold is expected to end, and
    // the person who was building it is who should pick it back
    // up — unassigning would quietly turn a pause into a
    // reallocation.
    clearsAssignment: false,
    hint: 'Parks the job. It leaves every queue — the artist’s list, IQA, EQA and Open Jobs — and appears under Hold until it’s resumed. Where it paused is remembered.',
  },
  {
    value: 'resume',
    label: 'Resume',
    status: null,
    clearsAssignment: false,
    hint: 'Puts the job back in the stage it was in when it went on hold, and it reappears in that queue.',
  },
];

// ------------------------------------------------------------
// targetsFor
//
// Which options a given row should actually offer. Hold and
// resume are mutually exclusive by definition — offering
// “Resume” on a job that was never paused is meaningless, and
// offering “On Hold” as a change on a job already held is a
// no-op the Save button would have to guard anyway.
//
// Held rows still get yta / yts. That's the escape hatch for a
// hold recorded before hold_prev_status existed, or one whose
// origin stage no longer makes sense to return to.
// ------------------------------------------------------------
export function targetsFor(status: ProjectStatus): StatusTargetOption[] {
  const by = (v: StatusTarget) =>
    STATUS_TARGET_OPTIONS.find((o) => o.value === v)!;
  if (status === 'on_hold') {
    // 'hold' leads so the dropdown opens on the row's current
    // state rather than pre-selecting a change — see currentTarget.
    return [by('hold'), by('resume'), by('yta'), by('yts')];
  }
  return [by('yta'), by('yts'), by('hold')];
}

// The label a resume option should carry for a specific row.
// The generic "Resume" says nothing about where the job lands,
// which is the one thing the admin needs to know before
// committing. Falls back to YTA/YTS wording when the origin
// wasn't recorded, matching what the server does.
export function resumeLabel(
  prev: ProjectStatus | null | undefined,
  assigned: boolean
): string {
  return `Resume — back to ${currentStatusLabel(prev ?? 'draft', assigned)}`;
}

const TARGET_VALUES = new Set<string>(
  STATUS_TARGET_OPTIONS.map((o) => o.value)
);

export function isStatusTarget(v: unknown): v is StatusTarget {
  return typeof v === 'string' && TARGET_VALUES.has(v);
}

export function targetOption(v: StatusTarget) {
  // Non-null: the type guarantees membership, and every caller
  // has already narrowed through isStatusTarget or the option
  // list itself.
  return STATUS_TARGET_OPTIONS.find((o) => o.value === v)!;
}

export function targetLabel(v: string | null | undefined): string {
  return (
    STATUS_TARGET_OPTIONS.find((o) => o.value === v)?.label ?? String(v ?? '—')
  );
}

export function targetHint(v: string | null | undefined): string | null {
  return STATUS_TARGET_OPTIONS.find((o) => o.value === v)?.hint ?? null;
}

// Which target a row is ALREADY sitting on, or null when it's
// somewhere else in the pipeline. Drives the dropdown's initial
// value and the "has this actually changed" check.
export function currentTarget(
  status: ProjectStatus,
  assigned: boolean
): StatusTarget | null {
  // A held row IS sitting on a selectable target, so the dropdown
  // opens on “On Hold by Client” with Save disabled, rather than
  // on a “Leave as …” placeholder plus a separate identical
  // option underneath it.
  if (status === 'on_hold') return 'hold';
  if (status !== 'draft') return null;
  return assigned ? 'yts' : 'yta';
}

// ------------------------------------------------------------
// Full-enum guard, still used by the API. The route stays
// general (it accepts any ProjectStatus) even though the UI only
// ever sends 'draft' — narrowing the endpoint to match today's
// dropdown would mean rewriting it the moment the dropdown grows.
// ------------------------------------------------------------
const STATUS_VALUES = new Set<string>(Object.keys(STATUS_LABELS));

export function isProjectStatus(v: unknown): v is ProjectStatus {
  return typeof v === 'string' && STATUS_VALUES.has(v);
}
