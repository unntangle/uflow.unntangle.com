import { notFound } from 'next/navigation';
import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import ClientReviewPage from './ClientReviewPage';

// ============================================================
// Client final-review page
// /client/qa/[id]
//
// Same shape as /admin/qa/[id] but scoped to a client user.
// Auth gate:
//   - role must be 'client'
//   - project must belong to the caller's brand (client_id)
//   - project must be in 'client_review' status (the only point
//     in the lifecycle where a client can act)
//
// Anything else → 404 (we never leak "this project exists but
// you can't see it"; pretend it doesn't exist).
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Review',
};

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser('client');
  if (!user.clientId) notFound();

  const { id } = await params;

  // ----- Load project + verify brand + verify status -----
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, glb_url, brief, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email)'
    )
    .eq('id', id)
    .maybeSingle();

  if (!project) notFound();
  if (project.client_id !== user.clientId) notFound();
  if (project.status !== 'client_review') notFound();

  // ----- Load references (the client should see the same brief
  //       material the admin reviewed) -----
  const { data: references } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  // Normalise joined relations the same way the admin page does.
  type JoinedClient = { slug: string; name: string } | { slug: string; name: string }[] | null;
  type JoinedAssignee =
    | { id: string; name: string; email: string }
    | { id: string; name: string; email: string }[]
    | null;
  const c = Array.isArray(project.client)
    ? (project.client as { slug: string; name: string }[])[0]
    : (project.client as { slug: string; name: string } | null);
  const a = Array.isArray(project.assignee)
    ? (project.assignee as { id: string; name: string; email: string }[])[0]
    : (project.assignee as { id: string; name: string; email: string } | null);

  return (
    <ClientReviewPage
      project={{
        id: project.id,
        slug: project.slug,
        name: project.name,
        status: project.status,
        revision_count: project.revision_count,
        glb_url: project.glb_url,
        brief: project.brief,
        updated_at: project.updated_at,
        client: c ?? { slug: '', name: '' },
        assignee: a,
      }}
      references={references ?? []}
      currentUser={{ name: user.name, role: user.role as 'client' }}
    />
  );
}
