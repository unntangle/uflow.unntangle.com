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
  model_type: 'parent' | 'child' | null;
  parent_id: string | null;
};

export default async function ReassignJobsPage() {
  const user = await requireUser('admin');

  const [{ data: rawProjects }, { data: artists }, { data: allNames }] =
    await Promise.all([
      supabase()
        .from('uflow_projects')
        .select(
          'id, slug, name, status, revision_count, assigned_to, updated_at, model_type, parent_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email)'
        )
        .in('status', [
          'draft',
          'iqa_rejected',
          'eqa_rejected',
          'wip',
          'iqa_wip',
          'eqa_wip',
        ])
        .order('updated_at', { ascending: false }),
      supabase()
        .from('uflow_users')
        .select('id, name, email')
        .eq('role', '3d_artist')
        .order('name'),
      // Names only, unfiltered. This page loads just the OPEN
      // jobs, but a child's parent is often approved or in
      // review, so resolving parent names from the filtered set
      // would leave most of them blank. Two columns across every
      // row is cheap next to a wrong-looking table.
      supabase().from('uflow_projects').select('id, name'),
    ]);

  const parentNames = new Map(
    (allNames || []).map((p) => [p.id as string, p.name as string])
  );

  const normalised = (rawProjects || []).map((p) => {
    const r = p as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      assignee: a,
      model_type: r.model_type ?? 'parent',
      parent_id: r.parent_id ?? null,
      parent_name: r.parent_id ? parentNames.get(r.parent_id) ?? null : null,
    };
  });

  return (
    <ReassignJobsForm
      initialProjects={normalised as never}
      artists={artists || []}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
