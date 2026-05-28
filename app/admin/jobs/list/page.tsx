import { requireUser } from '../../../lib/auth';
import { supabase, ProjectStatus } from '../../../lib/supabase';
import ListJobsPage from './ListJobsPage';

// ============================================================
// Admin -> List Jobs
// /admin/jobs/list
//
// A flat, single-table listing of EVERY job across all statuses
// (no tab bar, no status filtering) with a dedicated Edit column
// that links to /admin/[id]/edit. This is the home for renaming
// / editing a job's name + brief, replacing the cramped inline
// Edit link that used to sit beside the slug on the Overview.
//
// Unlike the Overview's per-status tabs, this page is purely a
// management index: see all jobs at a glance, jump to edit any
// of them. It reuses the same query shape as app/admin/page.tsx
// (project + client + assignee) so the columns line up with what
// admins already know.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'List Jobs',
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
  assignee:
    | { id: string; name: string; email: string }
    | { id: string; name: string; email: string }[]
    | null;
};

export default async function AdminListJobsPage() {
  const user = await requireUser('admin');

  const { data: rawProjects } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, assigned_to, created_at, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email)'
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
    };
  });

  return (
    <ListJobsPage
      initialProjects={normalised as never}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
