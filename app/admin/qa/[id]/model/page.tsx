import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { sortVariants } from '../../../../lib/variant-status';
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ variant?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;

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

  // ----- Colourways -----
  // Fetched in full (not just the one in ?variant) so the viewer can
  // offer a switcher and flip between them client-side, without a
  // round-trip per colourway. Scoping is inherited from the parent
  // project, which was already checked above.
  const { data: rawVariants } = await supabase()
    .from('uflow_project_variants')
    .select(
      'id, name, glb_url, approved_glb_url, revision_count, is_primary, position'
    )
    .eq('project_id', id);

  const orderedVariants = sortVariants(rawVariants);

  const variants = orderedVariants.map((v) => ({
    id: v.id as string,
    // The primary colourway is a backfill artefact — the migration
    // named it 'Original', which tells a reviewer nothing. Show the
    // product's own name instead, since that IS what the primary
    // variant is.
    name: v.is_primary ? project.name : (v.name as string),
    isPrimary: !!v.is_primary,
    glbUrl: (v.glb_url as string | null) || (v.approved_glb_url as string | null),
    revisionCount: (v.revision_count as number | null) ?? 0,
  }));

  // ----- Variant target -----
  // The review page appends ?variant=<id> so the reviewer opens on
  // the colourway they're actually deciding on. Without this the
  // link would always show the product's own glb_url — i.e. someone
  // could approve Black while looking at the original's model.
  //
  // An id that isn't one of this product's colourways is a 404
  // rather than a silent fallback: a guessed id must never render
  // another product's model under this one's name.
  if (sp.variant && !variants.some((v) => v.id === sp.variant)) notFound();

  const primary = orderedVariants.find((v) => v.is_primary);
  const activeVariantId = sp.variant ?? (primary?.id as string | undefined) ?? null;

  return (
    <ModelViewerPage
      projectName={project.name}
      clientName={c?.name ?? ''}
      variants={variants}
      activeVariantId={activeVariantId}
      fallbackGlbUrl={project.glb_url || project.approved_glb_url}
      fallbackRevision={project.revision_count ?? 0}
    />
  );
}
