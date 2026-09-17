import { notFound } from 'next/navigation';
import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import { sortVariants } from '../../../lib/variant-status';
import ClientReviewPage from './ClientReviewPage';

// ============================================================
// Client final-review page
// /client/qa/[id]
//
// Same shape as /admin/qa/[id] but scoped to a client user.
// Auth gate:
//   - role must be 'client'
//   - project must belong to the caller's brand (client_id)
//   - SOMETHING here must be in 'client_review' — either a
//     colourway or, on the legacy single-model path, the product
//     row itself. That's the only point in the lifecycle where a
//     client can act.
//
// Why not just check project.status: since the 2026-08-06
// variants migration that column is only written on the legacy
// path, so it goes stale the moment a colourway moves on its
// own. Gating on it 404'd every variant job the admin had just
// forwarded for sign-off. Same question the admin QA page asks
// (app/admin/qa/[id]/page.tsx), with the client's status.
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
      'id, slug, name, status, revision_count, glb_url, brief, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), variants:uflow_project_variants(id, name, slug, status, revision_count, glb_url, approved_glb_url, is_primary, position, updated_at)'
    )
    .eq('id', id)
    .maybeSingle();

  if (!project) notFound();
  // Brand check FIRST so we never leak state about another
  // brand's job through the status gate below.
  if (project.client_id !== user.clientId) notFound();

  // Colourways, ordered for the review blocks. PostgREST can't
  // sort an embedded resource independently of its parent.
  const variants = sortVariants(project.variants ?? []);

  // Reviewable = awaiting THIS client's sign-off. A colourway in
  // that state makes the product reviewable even when the
  // product's own status column says otherwise.
  const reviewableVariants = variants.filter(
    (v) => v.status === 'client_review'
  );

  // 404 only when nothing here is the client's to decide on —
  // neither the product row nor any of its colourways.
  if (project.status !== 'client_review' && reviewableVariants.length === 0) {
    notFound();
  }

  // ----- Load references (the client should see the same brief
  //       material the admin reviewed) -----
  const { data: references } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  // ----- Past EQA rounds (the client's OWN feedback only) -----
  // Read ONLY from uflow_client_feedback_images, which holds the
  // screenshots clients upload when they reject. Admin's internal
  // IQA feedback (uflow_feedback_images) is deliberately never
  // queried here, so it can't reach the client's page. Brand
  // scoping is already enforced above (project.client_id check).
  //
  // Only the distinct round numbers go down; the images are viewed
  // in the feedback gallery, which also forces source=client for
  // client users server-side. Non-fatal: a failure just shows
  // "No feedback yet".
  const { data: eqaRows, error: eqaErr } = await supabase()
    .from('uflow_client_feedback_images')
    .select('revision_number')
    .eq('project_id', id);
  if (eqaErr) console.error('[client.qa.page] EQA rounds', eqaErr);

  const eqaRounds = Array.from(
    new Set(
      (eqaRows ?? [])
        .map((r) => r.revision_number)
        .filter((n): n is number => typeof n === 'number')
    )
  ).sort((x, y) => y - x);

  // Normalise joined relations the same way the admin page does.
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
      variants={variants}
      eqaRounds={eqaRounds}
      currentUser={{ name: user.name, role: user.role as 'client' }}
    />
  );
}
