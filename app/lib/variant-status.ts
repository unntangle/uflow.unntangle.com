import { ProjectStatus } from './supabase';

// ============================================================
// Variant status roll-up
// ============================================================
// A product (uflow_projects row) is a container for colourways
// (uflow_project_variants rows). Each variant runs the nine-state
// pipeline independently — Grey can be approved while Black is
// still in IQA.
//
// Every dashboard still shows ONE row per product, so that row
// needs a single status. It cannot be uflow_projects.status:
// since the 2026-08-06 variants migration that column is only
// written on the legacy single-model path, so it goes stale the
// moment a colourway moves on its own.
//
// This module is the single definition of that derivation. Every
// surface that buckets or badges a product must import from here
// rather than reimplement it, or the admin Overview and the
// artist's list will disagree about where the same job belongs.
// ============================================================

// Pipeline progression. The three WIP flavours share a rank
// because the distinction between them (fresh build vs. revising
// IQA feedback vs. revising EQA feedback) says nothing about how
// far along the work is. Both rejection states likewise.
export const STATUS_RANK: Record<ProjectStatus, number> = {
  // Below draft, so a held colourway DOMINATES the roll-up: a
  // product with one paused colourway reports 'on_hold' and
  // badges as held. That's deliberate. The roll-up answers "how
  // far along is this product", and a product the client has
  // paused part of is not progressing — reporting the sibling's
  // stage instead would hide the block behind an encouraging
  // badge.
  //
  // It also keeps allVariantsApproved honest: a product with a
  // held colourway can never roll up to 'approved'.
  on_hold: -1,
  draft: 0,
  iqa_rejected: 1,
  eqa_rejected: 1,
  wip: 2,
  iqa_wip: 2,
  eqa_wip: 2,
  qa_pending: 3,
  client_review: 4,
  approved: 5,
};

// The minimal shape this module needs. Deliberately structural so
// each dashboard can pass its own richer variant type without
// converting.
export type VariantLike = {
  status: ProjectStatus;
  is_primary?: boolean;
};

export type ProductLike = {
  status: ProjectStatus;
  variants?: VariantLike[] | null;
};

// ------------------------------------------------------------
// rollupStatus
//
// The LEAST ADVANCED variant wins. Consequences worth knowing:
//
//   * a product reaches 'approved' only when EVERY colourway has
//   * a product stays in whatever earlier queue still has work,
//     which is the point of the tabs — they answer "what needs
//     attention", and an unstarted Grey needs attention even if
//     Black shipped last month
//
// Falls back to the product's own column when there are no
// variant rows at all (pre-migration data, or a backfill that
// didn't run), so dashboards degrade to their previous behaviour
// rather than showing nothing.
// ------------------------------------------------------------
export function rollupStatus(p: ProductLike): ProjectStatus {
  const vs = p.variants ?? [];
  if (vs.length === 0) return p.status;
  return vs.reduce((least, v) =>
    STATUS_RANK[v.status] < STATUS_RANK[least.status] ? v : least
  ).status;
}

// ------------------------------------------------------------
// anyVariantIn
//
// Membership test for the ACTION QUEUES, which is a different
// question from what rollupStatus answers.
//
// rollupStatus produces ONE summarising value for the badge and
// for sorting. Using it to bucket tabs is wrong: a product with
// Black awaiting QA and Original still in progress rolls up to
// 'wip', so it never reaches the IQA tab and the variant awaiting
// review becomes unreachable.
//
// The tabs answer "is there work of this kind here?", so a
// product belongs in a queue when ANY of its colourways is in
// that state. A product can legitimately appear in several tabs
// at once — that's accurate, not a bug: two different people
// each have something to do on it.
//
// Approved is the exception and is deliberately NOT expressed
// here: a product is only finished when EVERY variant is, which
// rollupStatus already gives (it returns 'approved' only when the
// least advanced variant is approved).
// ------------------------------------------------------------
export function anyVariantIn(
  p: ProductLike,
  statuses: ProjectStatus[]
): boolean {
  const vs = p.variants ?? [];
  // No variant rows — fall back to the product's own column so
  // pre-migration data still buckets sensibly.
  if (vs.length === 0) return statuses.includes(p.status);
  return vs.some((v) => statuses.includes(v.status));
}

// True when every colourway is signed off. The only queue that
// genuinely needs "all" rather than "any".
//
// There is deliberately no allVariantsOnHold counterpart. Hold
// is an "any" queue like the stage queues: one paused colourway
// puts the product under Hold and takes it out of Open Jobs.
// Approved is the odd one out because a product isn't finished
// until every colourway is — a hold, by contrast, blocks the
// product as soon as it touches any part of it.
export function allVariantsApproved(p: ProductLike): boolean {
  return rollupStatus(p) === 'approved';
}

// ============================================================
// clientFacingStatus
// ============================================================
// The ONE definition of what a job reads as on the client side.
// The client never sees the internal pipeline: everything the
// admin and artist are doing rolls up to "Open", and only the
// three states the client themselves participates in get their
// own label.
//
// Lives here rather than in either dashboard because it is used
// by BOTH the Overview (tab buckets, status pill, CSV export)
// and the List Jobs index, and those two silently disagreeing
// about where a job belongs is exactly the class of bug this
// module exists to prevent.
//
// ------------------------------------------------------------
// WHY THERE IS NO has_client_rejection FALLBACK HERE
// ------------------------------------------------------------
// Both dashboards used to add `|| p.has_client_rejection` to the
// EQA Rejected test, on the reasoning that a job the client had
// pushed back on stays theirs to watch. In practice that flag is
// set by the mere EXISTENCE of a row in
// uflow_client_feedback_images, so it is true forever once the
// client has rejected even once, and it is never cleared.
//
// The three states it could still influence are precisely the
// ones where the work has MOVED ON — the artist picked the
// feedback up (eqa_wip), re-uploaded (qa_pending), or admin
// re-triaged it (iqa_rejected). 'approved', 'client_review' and
// 'eqa_rejected' are all decided above it. So the flag could only
// ever mislabel a job that was actively being fixed, pinning it
// under EQA Rejected and taking it out of Open Jobs for the rest
// of its life.
//
// The honest answer is the row's actual state. A job the client
// rejected and that is now being reworked is Open; their own
// rejection history is still one click away in the Revision Round
// column, which reads client_revision_count and is unaffected.
export type ClientFacingStatus =
  | 'Approved'
  | 'EQA'
  | 'EQA Rejected'
  | 'Open';

export function clientFacingStatus(p: ProductLike): ClientFacingStatus {
  // Order matters: it is what the client most needs to know
  // first. Finished, then actionable, then pushed back, then
  // everything still internal.
  if (allVariantsApproved(p)) return 'Approved';
  if (anyVariantIn(p, ['client_review'])) return 'EQA';
  if (anyVariantIn(p, ['eqa_rejected'])) return 'EQA Rejected';
  return 'Open';
}

// Sort rank for the client-facing Status column. Kept next to the
// labels so a new label can't be added without a rank.
export const CLIENT_STATUS_ORDER: Record<ClientFacingStatus, number> = {
  Open: 0,
  EQA: 1,
  'EQA Rejected': 2,
  Approved: 3,
};

// Colourways excluding the primary. The parent row already stands
// for the primary, so this is what a disclosure toggle should
// count and what child rows should list — a product carrying only
// its backfilled 'Original' has no variants in user terms.
export function extraVariants<T extends VariantLike>(
  variants: T[] | null | undefined
): T[] {
  return (variants ?? []).filter((v) => !v.is_primary);
}

// ------------------------------------------------------------
// variantsIn / queueStatus
//
// These two exist because rollupStatus answers the wrong
// question for a row that's sitting INSIDE a queue tab.
//
// Tabs are populated with anyVariantIn: a product lands in IQA
// when ANY colourway is qa_pending. But the badge was drawn with
// rollupStatus, which reports the LEAST ADVANCED colourway. For a
// mixed product those are different states, so a job could sit
// under "IQA" wearing a "WIP" badge — technically both true, and
// unreadable.
//
// Inside a queue, the honest badge is the status that PUT the row
// there. queueStatus returns that; outside a queue (Open Jobs,
// Approved, or any caller that passes no statuses) it falls back
// to the roll-up, which is the right summary when the tab isn't
// asking about one particular stage.
// ------------------------------------------------------------
export function variantsIn<T extends VariantLike>(
  variants: T[] | null | undefined,
  statuses: ProjectStatus[]
): T[] {
  return (variants ?? []).filter((v) => statuses.includes(v.status));
}

export function queueStatus(
  p: ProductLike,
  statuses?: ProjectStatus[] | null
): ProjectStatus {
  if (!statuses || statuses.length === 0) return rollupStatus(p);
  const matching = variantsIn(p.variants, statuses);
  // No variant rows (pre-migration data) — the product's own
  // column is what put it in the tab, so report that.
  if (matching.length === 0) {
    return statuses.includes(p.status) ? p.status : rollupStatus(p);
  }
  // Several colourways can match one tab (WIP covers three
  // flavours). Least advanced wins, same tie-break rollupStatus
  // uses, so the badge is stable rather than order-dependent.
  return matching.reduce((least, v) =>
    STATUS_RANK[v.status] < STATUS_RANK[least.status] ? v : least
  ).status;
}

// How many colourways a product has in user terms. Products with
// no variant rows count as one (themselves), so callers can
// compare "N of M" without special-casing pre-migration data.
export function variantCount(p: ProductLike): number {
  return Math.max(1, (p.variants ?? []).length);
}

// True when the product has colourways beyond the original, i.e.
// when a disclosure toggle is worth rendering at all.
export function hasExtraVariants(
  variants: VariantLike[] | null | undefined
): boolean {
  return extraVariants(variants).length > 0;
}

// The PostgREST embed used by every product query that needs the
// roll-up. Kept here so the field list can't drift between the
// admin SSR select, /api/projects, and the per-role dashboards —
// a missing column would silently change how a product buckets.
//
// hold_prev_status is deliberately NOT in this list. Only the
// Change Status page needs it, and PostgREST fails the WHOLE
// query when a selected column is missing — so putting a newer
// column here would take down every page that shares the
// constant if the app ever ran ahead of a migration. Pages that
// want it use VARIANT_SELECT_WITH_HOLD below.
export const VARIANT_SELECT =
  'variants:uflow_project_variants(id, name, slug, status, revision_count, glb_url, approved_glb_url, is_primary, position, updated_at)';

// The same embed plus the hold bookkeeping column. Requires
// migrations/2026-08-28_add_on_hold_status.sql. Used only by the
// Change Status page, which is the one surface that has to name
// the stage a resumed row will land back in.
export const VARIANT_SELECT_WITH_HOLD =
  'variants:uflow_project_variants(id, name, slug, status, revision_count, glb_url, approved_glb_url, is_primary, position, updated_at, hold_prev_status)';

// PostgREST can't order an embedded resource independently of its
// parent, so ordering happens after the fetch. Every normaliser
// should run this so child rows appear in a stable order.
export function sortVariants<T extends { position?: number }>(
  variants: T[] | null | undefined
): T[] {
  return [...(variants ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0)
  );
}

// ============================================================
// Recency: which job was touched most recently?
// ============================================================
// `order('updated_at', desc)` on uflow_projects is no longer a
// reliable "latest first", for the same reason its status column
// isn't reliable: since the 2026-08-06 variants migration, every
// pipeline transition (start, upload, IQA decision, client
// sign-off) stamps updated_at on the COLOURWAY row and leaves the
// product's own column untouched. A job whose model moved to EQA
// five minutes ago can therefore still carry a product-level
// updated_at from the day it was created, and sink below jobs
// that haven't moved in weeks.
//
// The honest answer is the most recent timestamp anywhere on the
// product: its own column OR any of its colourways. Products with
// no variant rows (pre-migration data) fall back to their own
// column, so nothing regresses for legacy jobs.
//
// Returns epoch milliseconds. Unparseable / missing timestamps
// yield 0 so they sort last rather than throwing NaN into the
// comparator (NaN comparisons are always false, which silently
// corrupts a sort).
export type TimestampedProduct = {
  updated_at?: string | null;
  created_at?: string | null;
  variants?: { updated_at?: string | null }[] | null;
};

function toMillis(value: string | null | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

export function effectiveUpdatedAt(p: TimestampedProduct): number {
  let latest = toMillis(p.updated_at);
  for (const v of p.variants ?? []) {
    const t = toMillis(v?.updated_at);
    if (t > latest) latest = t;
  }
  // A job created but never touched since may have no usable
  // updated_at at all; created_at still places it correctly
  // relative to older work.
  return latest || toMillis(p.created_at);
}

// Most recently active first. This is the DEFAULT order for every
// product list — the order a table shows when no column sort is
// active — so the newest job, and anything that just moved stage,
// lands in the first row.
//
// Ties break on created_at (newer first) so two rows stamped in
// the same millisecond don't swap places between renders.
export function sortByLatest<T extends TimestampedProduct>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const diff = effectiveUpdatedAt(b) - effectiveUpdatedAt(a);
    if (diff !== 0) return diff;
    return toMillis(b.created_at) - toMillis(a.created_at);
  });
}
