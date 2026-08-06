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

// Colourways excluding the primary. The parent row already stands
// for the primary, so this is what a disclosure toggle should
// count and what child rows should list — a product carrying only
// its backfilled 'Original' has no variants in user terms.
export function extraVariants<T extends VariantLike>(
  variants: T[] | null | undefined
): T[] {
  return (variants ?? []).filter((v) => !v.is_primary);
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
export const VARIANT_SELECT =
  'variants:uflow_project_variants(id, name, slug, status, revision_count, glb_url, approved_glb_url, is_primary, position, updated_at)';

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
