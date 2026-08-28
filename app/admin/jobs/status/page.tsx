import { requireUser } from '../../../lib/auth';
import { supabase, ProjectStatus } from '../../../lib/supabase';
import { VARIANT_SELECT_WITH_HOLD, sortVariants } from '../../../lib/variant-status';
import ChangeStatusPage from './ChangeStatusPage';

// ============================================================
// Change Status page
// ============================================================
// A manual override surface: one row per job, a dropdown per
// row, and a Save that writes nothing but the status field.
//
// Every OTHER status transition in this app is a side effect of
// doing the work — an artist clicks Start, an upload lands, a
// reviewer approves or rejects. That's the right default, but it
// leaves no way to fix a job that ended up in the wrong state
// (an accidental rejection, a job that stalled after a failed
// upload, a status left behind by a data migration). Until now
// the only fix was scripts/set-project-status.ts over SSH, which
// isn't something the people who notice the problem can run.
//
// Loads ALL statuses, unlike Reassign Jobs which excludes the
// finished ones. Correcting an approved job that shouldn't be
// approved is one of the main reasons to open this page, so
// filtering it out would remove the point.
//
// Colourways are included because since the 2026-08-06 variants
// migration the variant rows hold the authoritative status —
// changing only uflow_projects.status on a job that has them
// would appear to do nothing on every dashboard. The client
// component renders them as expandable child rows, each with
// its own dropdown.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Change Status',
};

type Variant = {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  revision_count: number;
  is_primary: boolean;
  position: number;
  updated_at: string;
  // Where this colourway was when it went On Hold by Client.
  // Only this page needs it — it's what lets the Resume option
  // name the stage the row will land back in instead of an
  // unhelpful bare "Resume". Comes in via VARIANT_SELECT.
  hold_prev_status: ProjectStatus | null;
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  updated_at: string;
  client_id: string;
  // Product-level equivalent of the variant column above. Only
  // meaningful on pre-migration jobs that have no variant rows,
  // where uflow_projects is still the row the pipeline runs on.
  hold_prev_status: ProjectStatus | null;
  client:
    | { slug: string; name: string }
    | { slug: string; name: string }[]
    | null;
  assignee:
    | { id: string; name: string }
    | { id: string; name: string }[]
    | null;
  // Reference images attached at job creation. Pulled whole (one
  // small row each) and collapsed to the earliest below, so the
  // References column can show a thumbnail without an N+1 fetch.
  // They belong to the PRODUCT, not the colourway — the variants
  // migration deliberately left uflow_project_references keyed on
  // project_id — so child rows leave the cell empty rather than
  // repeating the parent's image.
  references: { image_url: string; created_at: string }[] | null;
  variants?: Variant[] | null;
};

export default async function Page() {
  const user = await requireUser('admin');

  const { data: rawProjects, error } = await supabase()
    .from('uflow_projects')
    .select(
      `id, slug, name, status, revision_count, assigned_to, updated_at, client_id, hold_prev_status, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name), references:uflow_project_references(image_url, created_at), ${VARIANT_SELECT_WITH_HOLD}`
    )
    .order('updated_at', { ascending: false });

  // Surfaced rather than swallowed, same as the Overview and List
  // Jobs. This query is the one that depends on
  // migrations/2026-08-28 (hold_prev_status), and PostgREST
  // rejects the whole query when a selected column is missing —
  // so without this the page would render an empty table that
  // reads as "no jobs exist" when the real answer is "the
  // migration hasn't run".
  //
  // The fields are pulled out by hand because a PostgREST error
  // isn't a real Error and its properties don't survive being
  // passed as an object to console.error — the overlay renders it
  // as `{}`, which says nothing. 42703 is undefined_column, which
  // on this page has exactly one likely cause, so it gets named.
  if (error) {
    console.error('[admin.jobs.status] query failed', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    if (error.code === '42703') {
      throw new Error(
        'Could not load jobs: this page needs the hold_prev_status column. ' +
          'Run app/migrations/2026-08-28_add_on_hold_status.sql against the ' +
          `database, then reload. (${error.message})`
      );
    }
    throw new Error(`Could not load jobs: ${error.message}`);
  }

  // PostgREST returns embedded relations as either an object or a
  // one-element array depending on the cardinality it infers, so
  // both are normalised here rather than in the client component.
  const projects = (rawProjects || []).map((p) => {
    const r = p as unknown as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    // Earliest reference is the thumbnail, same rule the Overview
    // uses. Sorted here rather than in the query because PostgREST
    // can't order an embedded resource independently of its parent.
    const refs = Array.isArray(r.references) ? r.references : [];
    const firstRef = [...refs].sort((x, y) =>
      x.created_at < y.created_at ? -1 : 1
    )[0];
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      revision_count: r.revision_count,
      assigned_to: r.assigned_to,
      updated_at: r.updated_at,
      client_id: r.client_id,
      hold_prev_status: r.hold_prev_status ?? null,
      thumb_url: firstRef?.image_url ?? null,
      client: c ?? { slug: '', name: '' },
      assignee: a ?? null,
      // Embedded resources can't be ordered by PostgREST
      // independently of their parent, so ordering happens here.
      variants: sortVariants(r.variants),
    };
  });

  return (
    <ChangeStatusPage
      initialProjects={projects}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
