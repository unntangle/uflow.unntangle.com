import { requireUser } from '../../../lib/auth';
import { supabase, ProjectStatus } from '../../../lib/supabase';
import ChangeTypePage from './ChangeTypePage';

// ============================================================
// Change Type page
// ============================================================
// A structural override surface, sibling to Change Status and
// Reassign Jobs: one row per job, a Parent/Child dropdown per
// row, and a Save that writes nothing but model_type and
// parent_id.
//
// Type is normally set once at creation. This page exists for
// everything after that — a model that turns out to be a
// re-skin of an existing one, a child hung off the wrong
// parent, or the whole back catalogue that migrated in as
// parents by default and needs sorting into families.
//
// Loads ALL jobs at every status. Unlike Reassign (which hides
// finished work), re-parenting an approved model is a normal
// thing to want: the lineage is documentation, and it stays
// true after the job ships.
//
// Colourway variants are deliberately NOT loaded. The hierarchy
// lives entirely on uflow_projects — a child is a full job row,
// not a sub-row — so there is nothing per-variant to show here.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Change Type',
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  assigned_to: string | null;
  updated_at: string;
  client_id: string;
  model_type: 'parent' | 'child';
  parent_id: string | null;
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
  references: { image_url: string; created_at: string }[] | null;
};

export default async function Page() {
  const user = await requireUser('admin');

  const { data: raw, error } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, assigned_to, updated_at, client_id, model_type, parent_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name), references:uflow_project_references(image_url, created_at)'
    )
    .order('name');

  // Surfaced rather than swallowed, same as Change Status.
  // PostgREST rejects the whole query when a selected column is
  // missing, so without this the page would render an empty table
  // reading as "no jobs exist" when the real answer is "the
  // migration hasn't run".
  //
  // Everything is flattened into ONE STRING before logging. A
  // PostgREST error is a plain object, not an Error, and the
  // Next.js dev overlay renders a passed object as `{}` — which
  // is exactly as useless as no logging at all. JSON.stringify is
  // the last-resort branch for an error shape we didn't predict,
  // so something always reaches the screen.
  if (error) {
    const parts = [error.message, error.details, error.hint].filter(Boolean);
    const detail = parts.length ? parts.join(' — ') : JSON.stringify(error);
    const code = error.code || 'no-code';
    console.error(`[admin.jobs.type] query failed (${code}): ${detail}`);

    // 42703 is undefined_column. We also pattern-match the text,
    // because the code doesn't always survive the client layer
    // and this page has exactly one likely cause either way.
    const missingColumn =
      error.code === '42703' || /model_type|parent_id/i.test(detail);
    if (missingColumn) {
      throw new Error(
        'Could not load jobs: this page needs the model_type and parent_id ' +
          'columns. Run app/migrations/2026-08-28_add_parent_child_models.sql ' +
          `against the database, then reload. (${code}: ${detail})`
      );
    }
    throw new Error(
      `Could not load jobs (${code}): ${detail}. If this mentions an unknown ` +
        'column, run app/migrations/2026-08-28_add_parent_child_models.sql first.'
    );
  }

  // PostgREST returns embedded relations as either an object or a
  // one-element array depending on the cardinality it infers, so
  // both are normalised here rather than in the client component.
  const rows = (raw || []).map((p) => {
    const r = p as unknown as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    // Earliest reference is the thumbnail, the same rule the
    // Overview and Change Status use. Sorted here because
    // PostgREST can't order an embedded resource independently
    // of its parent.
    const refs = Array.isArray(r.references) ? r.references : [];
    const firstRef = [...refs].sort((x, y) =>
      x.created_at < y.created_at ? -1 : 1
    )[0];
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      assigned_to: r.assigned_to,
      updated_at: r.updated_at,
      client_id: r.client_id,
      // Defaulted rather than trusted: a row written before the
      // migration's default took effect would otherwise render a
      // blank dropdown that saves nothing.
      model_type: r.model_type ?? 'parent',
      parent_id: r.parent_id ?? null,
      client: c ?? { slug: '', name: '' },
      assignee: a ?? null,
      thumb_url: firstRef?.image_url ?? null,
    };
  });

  // Resolving the parent's name here rather than embedding a
  // self-referential relation keeps the query simple and gives
  // the client component the full candidate list it needs for
  // the dropdown anyway. Two uses, one pass.
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  const projects = rows.map((r) => ({
    ...r,
    // Null when the job is a parent, or when its parent was
    // deleted — the FK is ON DELETE SET NULL, so an orphaned
    // child keeps its work and shows as needing a new parent.
    parent_name: r.parent_id ? nameById.get(r.parent_id) ?? null : null,
  }));

  return (
    <ChangeTypePage
      initialProjects={projects}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
