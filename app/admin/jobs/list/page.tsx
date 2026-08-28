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
  // Classification set on the admin Create/Edit Job forms. Null
  // on any job created before the 2026-08-09 migration; the
  // table renders those as an em dash.
  complexity: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
  assignee:
    | { id: string; name: string; email: string }
    | { id: string; name: string; email: string }[]
    | null;
  // Reference images attached at job-creation time. Pulled inline
  // (id + url only) so the Reference column can render thumbnails
  // without a second round-trip per row.
  references: { id: string; image_url: string }[] | null;
  // Where this job sits in the hierarchy, per the 2026-08-28
  // migration. Every pre-existing job defaulted to 'parent'.
  model_type: 'parent' | 'child' | null;
  parent_id: string | null;
};

export default async function AdminListJobsPage() {
  const user = await requireUser('admin');

  const { data: rawProjects, error } = await supabase()
    .from('uflow_projects')
    .select(
      `id, slug, name, status, revision_count, assigned_to, complexity, category, created_at, updated_at, client_id, model_type, parent_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), references:uflow_project_references(id, image_url)`
    )
    .order('updated_at', { ascending: false });

  // Surface query failures instead of rendering an empty table —
  // an empty list is indistinguishable from "no jobs exist".
  if (error) {
    console.error('[admin.jobs.list] query failed', error);
    throw new Error(`Could not load jobs: ${error.message}`);
  }

  // This page loads EVERY job, so a child's parent is always in
  // the same result set — no second query needed. Resolved via a
  // map rather than a self-referencing PostgREST embed, which
  // would take the whole page down if the FK constraint hint
  // were ever wrong.
  const parentNames = new Map(
    (rawProjects || []).map((p) => [p.id as string, p.name as string])
  );

  const normalised = (rawProjects || []).map((p) => {
    const r = p as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      assignee: a,
      // Normalise undefined -> null so the client component's
      // label helpers get one "unclassified" shape to handle.
      complexity: r.complexity ?? null,
      category: r.category ?? null,
      references: r.references ?? [],
      model_type: r.model_type ?? 'parent',
      parent_id: r.parent_id ?? null,
      parent_name: r.parent_id ? parentNames.get(r.parent_id) ?? null : null,
    };
  });

  return (
    <ListJobsPage
      initialProjects={normalised as never}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
