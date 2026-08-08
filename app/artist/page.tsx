import { requireUser } from '../lib/auth';
import { supabase, ProjectStatus } from '../lib/supabase';
import { sortVariants } from '../lib/variant-status';
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
  // Colourways of this product. Each is its own piece of work
  // with its own zip, so they render as child rows the artist can
  // Start and Upload against individually.
  variants:
    | {
        id: string;
        name: string;
        slug: string;
        status: ProjectStatus;
        revision_count: number;
        feedback_seen_revision: number;
        glb_url: string | null;
        approved_glb_url: string | null;
        is_primary: boolean;
        position: number;
        updated_at: string;
      }[]
    | null;
};

export default async function ArtistPage() {
  const user = await requireUser('3d_artist');

  const { data: projects, error } = await supabase()
    .from('uflow_projects')
    .select(
      `id, slug, name, status, revision_count, feedback_seen_revision, zip_url, glb_url, approved_glb_url, assigned_to, brief, updated_at, client:uflow_clients(slug, name), references:uflow_project_references(image_url, created_at), variants:uflow_project_variants(id, name, slug, status, revision_count, feedback_seen_revision, glb_url, approved_glb_url, is_primary, position, updated_at)`
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
      variants: sortVariants(row.variants),
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
