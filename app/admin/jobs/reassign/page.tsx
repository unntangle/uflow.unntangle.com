import { requireUser } from '../../../lib/auth';
import { supabase, ProjectStatus } from '../../../lib/supabase';
import ReassignJobsForm from './ReassignJobsForm';

// ============================================================
// Reassign Jobs page
// Lists every reassignable job (draft + rejected + wip) with its
// current artist and lets the admin change the assignee inline.
// Each row saves independently so many jobs can be reshuffled
// without leaving the page.
//
// Approved + qa_pending jobs are intentionally excluded:
//   - approved jobs are done, no point reassigning
//   - qa_pending jobs are in QA's queue; reassigning mid-review
//     would be confusing. If that's ever needed, surface it from
//     the Review screen instead.
//
// WIP jobs ARE reassignable, but the artist has already started
// work — the form shows a warning + confirmation modal before
// committing the reassignment (handled in ReassignJobsForm).
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Reassign Jobs',
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  updated_at: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
  assignee:
    | { id: string; name: string; email: string }
    | { id: string; name: string; email: string }[]
    | null;
};

export default async function ReassignJobsPage() {
  const user = await requireUser('admin');

  const [{ data: rawProjects }, { data: artists }] = await Promise.all([
    supabase()
      .from('uflow_projects')
      .select(
        'id, slug, name, status, revision_count, assigned_to, updated_at, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email)'
      )
      .in('status', ['draft', 'rejected', 'wip'])
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
    <ReassignJobsForm
      initialProjects={normalised as never}
      artists={artists || []}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
