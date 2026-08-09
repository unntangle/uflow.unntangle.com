// ============================================================
// Job option vocabularies — complexity + category
// ============================================================
// Single source of truth for the two dropdowns on the admin
// Create Job / Edit Job forms. Imported by BOTH the client
// components (to render the <option> lists) and the route
// handlers (to validate what actually gets written), so the UI
// and the API can never drift apart.
//
// Storage format: we persist the lowercase `value`, not the
// human `label`. Labels are presentation and may be reworded
// ("Office Chair" -> "Task Chair") without a data migration;
// values are the contract with the DB CHECK constraints added
// in migrations/2026-08-09_add_complexity_category.sql.
//
// Adding a new option is a two-step change: append it here AND
// widen the matching CHECK constraint in a new migration.
// ============================================================

export const COMPLEXITY_OPTIONS = [
  { value: 'easy', label: 'Easy' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'hard', label: 'Hard' },
  { value: 'complex', label: 'Complex' },
] as const;

export const CATEGORY_OPTIONS = [
  { value: 'sofa', label: 'Sofa' },
  { value: 'table', label: 'Table' },
  { value: 'chair', label: 'Chair' },
  { value: 'office_chair', label: 'Office Chair' },
  { value: 'cushion_chair', label: 'Cushion Chair' },
  { value: 'bar_stool', label: 'Bar Stool' },
  { value: 'pouffe', label: 'Pouffe' },
] as const;

export type JobComplexity = (typeof COMPLEXITY_OPTIONS)[number]['value'];
export type JobCategory = (typeof CATEGORY_OPTIONS)[number]['value'];

// Flat value lists for O(1) membership checks in the API layer.
const COMPLEXITY_VALUES = new Set<string>(
  COMPLEXITY_OPTIONS.map((o) => o.value)
);
const CATEGORY_VALUES = new Set<string>(CATEGORY_OPTIONS.map((o) => o.value));

export function isJobComplexity(v: unknown): v is JobComplexity {
  return typeof v === 'string' && COMPLEXITY_VALUES.has(v);
}

export function isJobCategory(v: unknown): v is JobCategory {
  return typeof v === 'string' && CATEGORY_VALUES.has(v);
}

// Display helpers for dashboards / tables. Unknown or NULL
// values render as an em dash rather than blowing up — old rows
// created before this migration have neither field set.
export function complexityLabel(v: string | null | undefined): string {
  return COMPLEXITY_OPTIONS.find((o) => o.value === v)?.label ?? '—';
}

export function categoryLabel(v: string | null | undefined): string {
  return CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? '—';
}

// Sort key for a Complexity column. Alphabetical would order the
// band as Complex, Easy, Hard, Moderate — meaningless. This
// returns the option's position instead, so easy -> complex is
// the ascending order. Unclassified rows return null, which the
// shared table sorter always sinks to the bottom.
export function complexityRank(v: string | null | undefined): number | null {
  const i = COMPLEXITY_OPTIONS.findIndex((o) => o.value === v);
  return i === -1 ? null : i;
}

// Sentinel for the "not chosen yet" <option>. Both fields are
// nullable in the DB, so an empty select is a legitimate state —
// the forms translate this back to null on submit.
export const UNSET = '';
