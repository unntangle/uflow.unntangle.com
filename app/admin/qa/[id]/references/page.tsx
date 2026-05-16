import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import ReferencesGallery from './ReferencesGallery';

// ============================================================
// References gallery (one project per route)
// /admin/qa/[id]/references
//
// A standalone page that lists every reference image attached
// to a project at job-creation time. Opened in a NEW TAB from
// the dashboards so users can compare the model and the
// references side-by-side (one tab per monitor).
//
// Auth:
//   - admin: any project
//   - 3d_artist: only jobs assigned to them
//   - client: only jobs in their own brand
//
// The URL still lives under /admin/qa/... for historical reasons
// (same path was previously admin-only). Server-side scoping
// below means a client can't see another brand's references
// regardless of URL manipulation, so the path prefix is just a
// cosmetic legacy.
//
// We don't restrict by project status here (unlike /admin/qa/[id]
// which enforces qa_pending/eqa_rejected), since looking up
// references should still work for approved / rejected projects.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Reference images',
};

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Auth gate — any role, server enforces per-role scoping below.
  const user = await requireUser();
  const { id } = await params;

  // Load the project first so we can decide whether this user is
  // allowed to see it before fetching references. We pull the
  // assignment + brand FKs alongside the display fields.
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, assigned_to, client_id, client:uflow_clients(slug, name)'
    )
    .eq('id', id)
    .maybeSingle();

  if (!project) notFound();

  // Per-role scoping. Mirrors /api/projects/:id/references so the
  // two access paths stay consistent. We return 404 rather than
  // 403 to avoid leaking the existence of out-of-scope projects.
  if (user.role === '3d_artist') {
    if (project.assigned_to !== user.userId) notFound();
  } else if (user.role === 'client') {
    if (!user.clientId || project.client_id !== user.clientId) notFound();
  }
  // Admin: no extra check — full visibility.

  const { data: references } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  // Same client-relation normalisation as the parent page.
  const c = Array.isArray(project.client) ? project.client[0] : project.client;

  return (
    <ReferencesGallery
      project={{
        id: project.id,
        slug: project.slug,
        name: project.name,
        client: c ?? { slug: '', name: '' },
      }}
      references={references ?? []}
    />
  );
}
