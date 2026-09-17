import { supabase } from './supabase';

// ============================================================
// EQA revision rounds
//
// Per-job summary of the CLIENT's rejection history, read from
// uflow_client_feedback_images. Drives the "EQA" column that sits
// beside the Revision column on the admin and artist dashboards.
//
//   eqa_revision_count  - distinct EQA rejection rounds
//   latest_eqa_revision - the newest of those round numbers, so a
//                         link can open the gallery on a filter
//                         that actually has rows
//
// Why a separate query instead of a PostgREST embed
// -------------------------------------------------
// The dashboard selects already carry several embeds, and an
// embed whose relationship can't be resolved fails the ENTIRE
// query - taking the dashboard down with it. A standalone read
// can fail on its own, and does so softly: the EQA column falls
// back to "no rounds" rather than blanking the page.
//
// Paging
// ------
// Supabase caps a single response at 1000 rows by default, and
// every screenshot is its own row, so the table outgrows one page
// quickly. We page with a stable order until a short page comes
// back. When scoped to specific jobs, ids are chunked so the
// `in (...)` filter can't overflow the request URL.
// ============================================================

export type EqaRounds = {
  eqa_revision_count: number;
  latest_eqa_revision: number | null;
};

const PAGE_SIZE = 1000;
const ID_CHUNK = 100;

/**
 * Load EQA round summaries.
 *
 * @param projectIds Jobs to summarise. Omit to summarise every job
 *                   (admin views, which load all jobs anyway).
 */
export async function loadEqaRounds(
  projectIds?: string[]
): Promise<Map<string, EqaRounds>> {
  const roundsByProject = new Map<string, Set<number>>();

  async function pull(ids?: string[]) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const base = supabase()
        .from('uflow_client_feedback_images')
        .select('id, project_id, revision_number');
      const filtered = ids ? base.in('project_id', ids) : base;
      const { data, error } = await filtered
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;

      for (const row of data ?? []) {
        const pid = row.project_id as string;
        const rev = row.revision_number as number;
        if (!pid || typeof rev !== 'number') continue;
        let set = roundsByProject.get(pid);
        if (!set) {
          set = new Set<number>();
          roundsByProject.set(pid, set);
        }
        set.add(rev);
      }

      if (!data || data.length < PAGE_SIZE) break;
    }
  }

  try {
    if (projectIds === undefined) {
      await pull();
    } else if (projectIds.length > 0) {
      for (let i = 0; i < projectIds.length; i += ID_CHUNK) {
        await pull(projectIds.slice(i, i + ID_CHUNK));
      }
    }
  } catch (err) {
    // Deliberately non-fatal: this feeds one secondary column.
    // Rows simply render as having no EQA rounds.
    console.error('[eqa-rounds] load failed', err);
    return new Map();
  }

  const result = new Map<string, EqaRounds>();
  for (const [pid, set] of roundsByProject) {
    result.set(pid, {
      eqa_revision_count: set.size,
      latest_eqa_revision: set.size ? Math.max(...set) : null,
    });
  }
  return result;
}

/** Summary for one job, defaulting to "no EQA rounds". */
export function eqaRoundsFor(
  map: Map<string, EqaRounds>,
  projectId: string
): EqaRounds {
  return (
    map.get(projectId) ?? { eqa_revision_count: 0, latest_eqa_revision: null }
  );
}
