import { requireUser } from '../lib/auth';
import { supabase, ProjectStatus } from '../lib/supabase';
import AdminDashboard from './AdminDashboard';

// ============================================================
// Admin dashboard
// - Lists all projects (across clients) with assignee info
// - Can create new jobs and assign to artists
// - Can add new 3D artist users
// - Can reassign existing jobs
// - Reviews qa_pending submissions (existing flow, unchanged)
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Admin Dashboard',
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  glb_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
  // Joined via FK constraint name `crm_projects_assigned_to_fkey`
  assignee:
    | { id: string; name: string; email: string }
    | { id: string; name: string; email: string }[]
    | null;
  // Joined via `uflow_projects_created_by_fkey`. Only the role is
  // pulled — we use it to decide whether the admin can delete a
  // 'draft' row from their dashboard. Jobs created by clients are
  // off-limits to admin deletion; their owning client deletes them
  // via /client. Possible shapes: single object, single-element
  // array, or null when created_by is itself null (legacy seed rows).
  creator:
    | { role: string }
    | { role: string }[]
    | null;
  // Reference images attached at job-creation time. We pull the
  // whole set (they're one small row each) and collapse to the
  // earliest one in the normaliser below, so the dashboard can
  // render a thumbnail without an N+1 fetch per row.
  references: { image_url: string; created_at: string }[] | null;
  // Colourways of this product. Rendered as collapsible child
  // rows beneath the product, so the table still shows ONE row
  // per product at rest.
  variants:
    | {
        id: string;
        name: string;
        slug: string;
        status: ProjectStatus;
        revision_count: number;
        glb_url: string | null;
        approved_glb_url: string | null;
        is_primary: boolean;
        position: number;
        updated_at: string;
      }[]
    | null;
};

export default async function AdminPage() {
  const user = await requireUser('admin');

  const [{ data: rawProjects, error: projectsError }, { data: artists, error: artistsError }] =
    await Promise.all([
      supabase()
        .from('uflow_projects')
        .select(
          'id, slug, name, status, revision_count, glb_url, approved_glb_url, assigned_to, brief, created_at, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), creator:uflow_users!uflow_projects_created_by_fkey(role), references:uflow_project_references(image_url, created_at), variants:uflow_project_variants(id, name, slug, status, revision_count, glb_url, approved_glb_url, is_primary, position, updated_at)'
        )
        .order('updated_at', { ascending: false }),
      supabase()
        .from('uflow_users')
        .select('id, name, email')
        .eq('role', '3d_artist')
        .order('name'),
    ]);

  // Same reasoning as the artist dashboard: swallowing `error`
  // here turns a failed query into an empty Overview, which reads
  // as "no jobs exist" rather than "the query broke". Surface it.
  if (projectsError) {
    console.error('[admin.page] project query failed', projectsError);
    throw new Error(`Could not load jobs: ${projectsError.message}`);
  }
  if (artistsError) {
    console.error('[admin.page] artist query failed', artistsError);
    throw new Error(`Could not load artists: ${artistsError.message}`);
  }

  const normalised = (rawProjects || []).map((p) => {
    const r = p as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    const cr = Array.isArray(r.creator) ? r.creator[0] : r.creator;
    // Earliest reference = the dashboard thumbnail. Sorted here
    // rather than in the query because PostgREST can't order an
    // embedded resource independently of the parent.
    const refs = Array.isArray(r.references) ? r.references : [];
    const firstRef = [...refs].sort((x, y) =>
      x.created_at < y.created_at ? -1 : 1
    )[0];
    // Collapse the joined creator role down to a boolean the
    // dashboard component can branch on without re-doing the
    // shape gymnastics every render. Null creator (e.g. legacy
    // rows with created_by = null) defaults to false so the
    // Delete button stays hidden — safer than guessing.
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      assignee: a,
      created_by_admin: cr?.role === 'admin',
      // Strip the raw joins out of the wire payload; the component
      // only consumes the boolean + single URL above.
      creator: undefined,
      thumb_url: firstRef?.image_url ?? null,
      references: undefined,
      // Ordered for the child-row list. PostgREST can't sort an
      // embedded resource independently, so it's done here.
      variants: [...(r.variants ?? [])].sort(
        (x, y) => (x.position ?? 0) - (y.position ?? 0)
      ),
    };
  });

  return (
    <AdminDashboard
      initialProjects={normalised as never}
      artists={artists || []}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
