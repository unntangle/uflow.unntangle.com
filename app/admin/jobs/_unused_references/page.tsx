import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import ReferenceImagesPage from './ReferenceImagesPage';

// ============================================================
// Admin -> Reference Images
// /admin/jobs/references
//
// A flat index of every job alongside the reference images that
// were attached to it at creation time. Same table shape as List
// Jobs / Download Jobs (brand filter + search + sort), with an
// Images count column and two per-row actions:
//
//   - View     → opens the existing standalone references gallery
//                (/admin/qa/[id]/references) in a new tab, which
//                already has a thumbnail grid + lightbox.
//   - Download → zips that job's reference images and saves them.
//
// We pull the references inline (id + url only) via a nested
// select so each row knows its count and the download can run
// without a second round-trip. Jobs created without references
// render a muted "No references" state rather than being hidden,
// keeping the page a complete mirror of the job list.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Reference Images',
};

type ReferenceRow = { id: string; image_url: string };

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  assigned_to: string | null;
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

export default async function AdminReferenceImagesPage() {
  const user = await requireUser('admin');

  const { data: rawProjects } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, assigned_to, created_at, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), references:uflow_project_references(id, image_url)'
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
    <ReferenceImagesPage
      initialProjects={normalised as never}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
