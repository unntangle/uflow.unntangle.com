'use client';

// ============================================================
// useTableSort — shared client-side table sorting
// ============================================================
// One hook + one header component, reused by every table in the
// app (admin Overview, List Jobs, Job Allocation, Reassign, and
// the client dashboard) so sort behaviour is identical everywhere.
//
// Behaviour (per the agreed UX):
//   - Click a column header to cycle its sort: asc -> desc -> off.
//   - "off" restores the list's natural/default order (whatever
//     the server returned, usually updated_at desc).
//   - Sorting is mutually exclusive: activating one column clears
//     any other. Only one column drives the order at a time.
//
// Type-awareness:
//   Each sortable column provides an `accessor` returning a
//   primitive to compare (string | number | Date | null). The
//   comparator handles:
//     - numbers       : numeric order
//     - Date / dates  : chronological (via getTime)
//     - strings       : locale-aware, case-insensitive (so the
//                       A-Z icon does what users expect)
//     - null/undefined: always sorted last, regardless of dir
//   This lets Created/Updated sort chronologically and Status
//   sort by a caller-supplied rank rather than by label text.
// ============================================================

import { useMemo, useState, useCallback, ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';

// What a column's accessor may return for comparison.
export type SortValue = string | number | Date | null | undefined;

// Active sort state: which column key, and which direction.
// `null` key means "no active sort" -> default order.
export type SortState = {
  key: string | null;
  dir: SortDir;
};

// ---- comparator -------------------------------------------------
// Compares two accessor values for ascending order. nulls last.
function compareValues(a: SortValue, b: SortValue): number {
  // Null/undefined always sink to the bottom. We return a fixed
  // sign (not affected by direction) here; direction is applied
  // by the caller AFTER this for non-null pairs, but for null
  // handling we want "missing data last" in BOTH directions, so
  // those cases are resolved before the direction multiply.
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1; // a after b
  if (bNull) return -1; // a before b

  // Normalise Dates to their timestamp so they compare as numbers.
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;

  if (typeof av === 'number' && typeof bv === 'number') {
    return av - bv;
  }

  // Fall back to locale-aware, case-insensitive string compare.
  return String(av).localeCompare(String(bv), undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

// ---- the hook ---------------------------------------------------
// Generic over the row type T. Pass in the rows and a map of
// column key -> accessor. Returns the sorted rows plus the click
// handler + current state for the header component.
export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => SortValue>
) {
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'asc' });

  // Cycle: clicking the active column advances asc -> desc -> off.
  // Clicking a different column starts it fresh at asc.
  const onSort = useCallback((key: string) => {
    setSort((prev) => {
      if (prev.key !== key) {
        return { key, dir: 'asc' };
      }
      if (prev.dir === 'asc') {
        return { key, dir: 'desc' };
      }
      // was desc -> turn off (back to default order)
      return { key: null, dir: 'asc' };
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const accessor = accessors[sort.key];
    if (!accessor) return rows;
    const dirMul = sort.dir === 'asc' ? 1 : -1;
    // Stable sort: copy first (Array.prototype.sort is in-place
    // and isn't guaranteed stable pre-ES2019, but modern engines
    // are; copying also avoids mutating the caller's array which
    // could be React state).
    return [...rows].sort((ra, rb) => {
      const base = compareValues(accessor(ra), accessor(rb));
      // nulls already sink last via fixed sign inside compareValues;
      // multiplying by dir would float them to the top in desc, so
      // we only apply direction to the "real" comparison. Since
      // compareValues returns +/-1 for null cases, we detect those
      // and leave them unflipped.
      const av = accessor(ra);
      const bv = accessor(rb);
      const hasNull =
        av === null || av === undefined || bv === null || bv === undefined;
      return hasNull ? base : base * dirMul;
    });
  }, [rows, sort, accessors]);

  return { sorted, sort, onSort };
}

// ============================================================
// SortableTh — a <th> with a click-to-sort affordance + icon.
// ============================================================
// Renders the column label plus a small triangle that reflects
// state: neutral (unsorted) / ascending / descending. The whole
// header is the click target. Pass `align="right"` to mirror the
// layout used by right-aligned action columns.
export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
  style,
}: {
  label: ReactNode;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  style?: React.CSSProperties;
}) {
  const active = sort.key === sortKey;
  const dir = active ? sort.dir : null;

  return (
    <th style={style}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={
          dir === 'asc'
            ? 'Sorted A→Z — click for Z→A'
            : dir === 'desc'
            ? 'Sorted Z→A — click to clear'
            : 'Click to sort A→Z'
        }
        aria-label={`Sort by ${typeof label === 'string' ? label : sortKey}`}
        style={{
          // Strip native button chrome so it reads as a header.
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          width: align === 'right' ? '100%' : undefined,
          justifyContent:
            align === 'right'
              ? 'flex-end'
              : align === 'center'
              ? 'center'
              : 'flex-start',
        }}
      >
        <span>{label}</span>
        <SortGlyph dir={dir} />
      </button>
    </th>
  );
}

// Small triangle glyph. Neutral state is a dimmed up/down pair so
// the column reads as "sortable"; active state shows a single
// solid triangle in the sort direction.
function SortGlyph({ dir }: { dir: SortDir | null }) {
  if (dir === 'asc') {
    return (
      <span aria-hidden="true" style={{ fontSize: 10, lineHeight: 1 }}>
        ▲
      </span>
    );
  }
  if (dir === 'desc') {
    return (
      <span aria-hidden="true" style={{ fontSize: 10, lineHeight: 1 }}>
        ▼
      </span>
    );
  }
  // Neutral: dimmed up/down stack so it's clearly clickable but
  // visually quiet until used.
  return (
    <span
      aria-hidden="true"
      style={{
        fontSize: 9,
        lineHeight: 0.8,
        opacity: 0.35,
        display: 'inline-flex',
        flexDirection: 'column',
      }}
    >
      <span>▲</span>
      <span>▼</span>
    </span>
  );
}

// ============================================================
// Status rank — shared ordering for the ProjectStatus enum so a
// Status column sorts by pipeline stage (draft -> approved)
// rather than alphabetically by label. Lower number = earlier in
// the workflow. Callers pass this through an accessor:
//   (p) => statusRank(p.status)
// ============================================================
export function statusRank(status: string): number {
  const order: Record<string, number> = {
    // Held jobs sort ahead of everything, not into the middle of
    // the pipeline. on_hold is a parking state, so its "stage" is
    // whatever it paused at — a value this function can't see. A
    // negative rank at least keeps every held row together at one
    // end of the column instead of scattering them under a stage
    // they're no longer in.
    on_hold: -1,
    draft: 0,
    wip: 1,
    iqa_wip: 2,
    eqa_wip: 3,
    qa_pending: 4,
    iqa_rejected: 5,
    client_review: 6,
    eqa_rejected: 7,
    approved: 8,
  };
  return order[status] ?? 99;
}
