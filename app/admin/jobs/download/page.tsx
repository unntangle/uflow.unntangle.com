import { requireUser } from '../../../lib/auth';
import { supabase, ProjectStatus } from '../../../lib/supabase';
import DownloadJobsPage from './DownloadJobsPage';

// ============================================================
// Admin -> Download Jobs
// /admin/jobs/download
//
// A flat listing of every job and its files. Same query shape +
// columns as List Jobs, so the pages feel like siblings — but the
// action column is the hub for a job's assets:
//
//   - View GLB         → opens the full-screen model viewer
//   - Download GLB      → saves the latest .glb
//   - View References   → opens the reference-image gallery
//   - Download References → zips the reference images
//
// Whether a job has a downloadable GLB depends on its lifecycle:
// any job that's had at least one upload carries a `glb_url`.
// Reference images are attached at creation, so a job may have
// references but no GLB yet (or vice-versa). Rows missing either
// asset render a disabled state for just that asset rather than
// being hidden — so the list stays a complete index that mirrors
// List Jobs.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Download Jobs',
};

type ReferenceRow = { id: string; image_url: string };

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  glb_url: string | null;
  approved_glb_url: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
  assignee:
    | { id: string; name: string; email: string }
    | { id: string; name: string; email: string }[]
    | null;
  references: ReferenceRow[] | null;
};

export default async function AdminDownloadJobsPage() {
  const user = await requireUser('admin');

  const { data: rawProjects } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, assigned_to, glb_url, approved_glb_url, created_at, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), references:uflow_project_references(id, image_url)'
    )
    .order('updated_at', { ascending: false });

  const normalised = (rawProjects || []).map((p) => {
    const r = p as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      assignee: a,
      references: r.references ?? [],
    };
  });

  return (
    <DownloadJobsPage
      initialProjects={normalised as never}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
