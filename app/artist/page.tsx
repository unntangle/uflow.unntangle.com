import { requireUser } from '../lib/auth';
import { supabase, ProjectStatus } from '../lib/supabase';
import ArtistDashboard from './ArtistDashboard';

// ============================================================
// 3D Artist dashboard
// - Lists projects assigned to this artist (filtered server-side)
// - Can upload zip for any non-approved project
// - Can view brief + reference images attached at job creation
// - Can view feedback images on rejected projects
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Artist Dashboard',
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  // Highest rejection round this artist has opened the feedback
  // gallery for. Drives the Rejected-tab "inbox" behaviour.
  feedback_seen_revision: number;
  zip_url: string | null;
  glb_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  updated_at: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
  // Reference images, collapsed to a single thumbnail below so
  // the table can show one without a fetch per row.
  references: { image_url: string; created_at: string }[] | null;
  model_type: 'parent' | 'child' | null;
  parent_id: string | null;
};

export default async function ArtistPage() {
  const user = await requireUser('3d_artist');

  const { data: projects, error } = await supabase()
    .from('uflow_projects')
    .select(
      `id, slug, name, status, revision_count, feedback_seen_revision, zip_url, glb_url, approved_glb_url, assigned_to, brief, updated_at, model_type, parent_id, client:uflow_clients(slug, name), references:uflow_project_references(image_url, created_at)`
    )
    .eq('assigned_to', user.userId)
    .order('updated_at', { ascending: false });

  // Fail loudly. This query previously discarded `error` and fell
  // through to `(projects || [])`, so any server-side failure —
  // a column added to the select before its migration ran, a
  // renamed relation, a network blip — rendered as a dashboard
  // full of zeros. An artist can't tell that apart from "no work
  // assigned to me", and neither could we: it looked like data
  // loss. Throwing surfaces the real cause immediately instead.
  if (error) {
    console.error('[artist.page] project query failed', error);
    throw new Error(`Could not load your jobs: ${error.message}`);
  }

  // A child's parent is resolved from the artist's OWN job list
  // rather than a self-referencing embed. The parent is often
  // assigned to somebody else, and this query is scoped to
  // assigned_to = me — so the name is frequently unresolvable
  // here. TypeBadge handles that by showing a bare "Child"
  // pill, which is the honest answer: the artist can see this
  // model is derived from another without being shown a job
  // that isn't theirs.
  const parentNames = new Map(
    (projects || []).map((p) => [p.id as string, p.name as string])
  );

  // Normalise the joined `client` field (supabase typing returns it as
  // either an object or a single-element array depending on version).
  const normalised = (projects || []).map((p) => {
    const row = p as ProjectRow;
    const c = Array.isArray(row.client) ? row.client[0] : row.client;
    // Earliest reference = the row thumbnail. Sorted here because
    // PostgREST can't order an embedded resource independently.
    const refs = Array.isArray(row.references) ? row.references : [];
    const firstRef = [...refs].sort((x, y) =>
      x.created_at < y.created_at ? -1 : 1
    )[0];
    return {
      ...row,
      client: c ?? { slug: '', name: '' },
      model_type: row.model_type ?? 'parent',
      parent_id: row.parent_id ?? null,
      parent_name: row.parent_id
        ? parentNames.get(row.parent_id) ?? null
        : null,
      thumb_url: firstRef?.image_url ?? null,
      references: undefined,
    };
  });

  return (
    <ArtistDashboard
      initialProjects={normalised as never}
      currentUser={{ name: user.name, role: user.role as '3d_artist' }}
    />
  );
}
