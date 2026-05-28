import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import ModelViewerPage from './ModelViewerPage';

// ============================================================
// Full-screen model viewer (one project per route)
// /admin/qa/[id]/model
//
// A standalone page that renders the project's current GLB
// filling the entire viewport (full width + height). Opened in a
// NEW TAB from the review pages via a "View model" button, so the
// reviewer gets maximum room to inspect the model without the
// review page itself having to fit a tall viewer.
//
// Auth (mirrors the references gallery in the sibling folder):
//   - admin:     any project
//   - 3d_artist: only jobs assigned to them
//   - client:    only jobs in their own brand
// Server-side scoping means URL manipulation can't expose another
// brand's model; the /admin/qa/... prefix is legacy cosmetic.
//
// We render whatever the project's current working asset is
// (glb_url) so it works for in-review projects. For an approved
// project we fall back to approved_glb_url so the route still
// shows something sensible if hit after sign-off.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Model viewer',
};

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const { data: project } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, glb_url, approved_glb_url, assigned_to, client_id, revision_count, client:uflow_clients(slug, name)'
    )
    .eq('id', id)
    .maybeSingle();

  if (!project) notFound();

  // Per-role scoping — same rules as the references gallery.
  if (user.role === '3d_artist') {
    if (project.assigned_to !== user.userId) notFound();
  } else if (user.role === 'client') {
    if (!user.clientId || project.client_id !== user.clientId) notFound();
  }

  const c = Array.isArray(project.client) ? project.client[0] : project.client;

  // Prefer the working GLB (what's being reviewed); fall back to
  // the approved copy for already-signed-off projects.
  const glbUrl = project.glb_url || project.approved_glb_url;

  return (
    <ModelViewerPage
      name={project.name}
      clientName={c?.name ?? ''}
      revisionCount={project.revision_count ?? 0}
      glbUrl={glbUrl}
    />
  );
}
