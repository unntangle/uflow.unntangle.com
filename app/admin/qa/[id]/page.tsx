import { notFound, redirect } from 'next/navigation';
import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import QaReviewPage from './QaReviewPage';

// ============================================================
// QA Review page (one project per route)
// /admin/qa/[id]
//
// Replaces the in-modal "Review" experience from the Overview's
// Pending review tab. The reviewer gets the full page to:
//   - turn the GLB around in a larger viewer
//   - see the original reference images
//   - drop / click / paste feedback screenshots
//   - approve (no feedback) or reject (with feedback)
//
// We only render this page for projects whose status is
// 'qa_pending' (fresh artist submission, IQA queue) or
// 'eqa_rejected' (client pushed back, admin needs to triage).
// Anything else bounces back to the Overview to keep the state
// machine honest — the feedback API rejects other statuses anyway.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'QA Review',
};

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser('admin');
  const { id } = await params;

  const { data: project } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, glb_url, brief, updated_at, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), variants:uflow_project_variants(id, name, slug, status, revision_count, glb_url, approved_glb_url, is_primary, position, updated_at)'
    )
    .eq('id', id)
    .maybeSingle();

  if (!project) notFound();

  // Colourways, ordered for the switcher. PostgREST can't sort an
  // embedded resource independently of its parent.
  const variants = [...(project.variants ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0)
  );

  // Reviewable = the two admin-actionable states. A variant in
  // either one makes the PRODUCT reviewable, even when the
  // product's own status column says otherwise — that column is
  // only written on the legacy single-model path, so it goes
  // stale as soon as a colourway moves on its own.
  const REVIEWABLE = ['qa_pending', 'eqa_rejected'];
  const reviewableVariants = variants.filter((v) =>
    REVIEWABLE.includes(v.status)
  );

  // Wrong-state guard. Bounce back to the Overview only when
  // NOTHING here is reviewable — neither the product itself nor
  // any of its colourways.
  if (
    !REVIEWABLE.includes(project.status) &&
    reviewableVariants.length === 0
  ) {
    redirect('/admin');
  }

  // References attached at job creation, in upload order.
  const { data: references } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  // Normalise embedded relations (Supabase types these as arrays
  // even when the FK is single-valued, depending on how the join
  // is generated). Same pattern as the admin overview page.
  const c = Array.isArray(project.client) ? project.client[0] : project.client;
  const a = Array.isArray(project.assignee)
    ? project.assignee[0]
    : project.assignee;

  return (
    <QaReviewPage
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
        assignee: a ?? null,
      }}
      references={references ?? []}
      variants={variants}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
