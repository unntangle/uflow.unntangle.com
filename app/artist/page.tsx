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
  zip_url: string | null;
  glb_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  updated_at: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
};

export default async function ArtistPage() {
  const user = await requireUser('3d_artist');

  const { data: projects } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, zip_url, glb_url, approved_glb_url, assigned_to, brief, updated_at, client:uflow_clients(slug, name)'
    )
    .eq('assigned_to', user.userId)
    .order('updated_at', { ascending: false });

  // Normalise the joined `client` field (supabase typing returns it as
  // either an object or a single-element array depending on version).
  const normalised = (projects || []).map((p) => {
    const row = p as ProjectRow;
    const c = Array.isArray(row.client) ? row.client[0] : row.client;
    return { ...row, client: c ?? { slug: '', name: '' } };
  });

  return (
    <ArtistDashboard
      initialProjects={normalised as never}
      currentUser={{ name: user.name, role: user.role as '3d_artist' }}
    />
  );
}
