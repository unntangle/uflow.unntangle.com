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
// Deliberately just the two draft flavours: this page sends a
// job back to the start of the pipeline, it isn't a free-form
// jump to any stage. Everything forward of draft is reached by
// doing the work (Start, upload, approve, reject), and those
// paths write revision counts and files that a raw status write
// would leave inconsistent.
export type StatusTarget = 'yta' | 'yts';

export const STATUS_TARGET_OPTIONS: {
  value: StatusTarget;
  label: string;
  // The status actually written. Both are 'draft' — see above.
  status: ProjectStatus;
  // Whether picking this also removes the artist from the job.
  clearsAssignment: boolean;
  hint: string;
}[] = [
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
];

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
