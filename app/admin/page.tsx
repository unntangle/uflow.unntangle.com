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
};

export default async function AdminPage() {
  const user = await requireUser('admin');

  const [{ data: rawProjects }, { data: artists }] =
    await Promise.all([
      supabase()
        .from('uflow_projects')
        .select(
          'id, slug, name, status, revision_count, glb_url, approved_glb_url, assigned_to, brief, created_at, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email)'
        )
        .order('updated_at', { ascending: false }),
      supabase()
        .from('uflow_users')
        .select('id, name, email')
        .eq('role', '3d_artist')
        .order('name'),
    ]);

  const normalised = (rawProjects || []).map((p) => {
    const r = p as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    return { ...r, client: c ?? { slug: '', name: '' }, assignee: a };
  });

  return (
    <AdminDashboard
      initialProjects={normalised as never}
      artists={artists || []}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
