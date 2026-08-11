import { notFound } from 'next/navigation';
import { requireUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { sortVariants } from '../../../../lib/variant-status';
import {
  MODEL_VIEWER_ORIGIN,
  MODEL_VIEWER_SCRIPT_URL,
  HDR_ORIGIN,
  originOf,
} from '../../../../lib/model-viewer-config';
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

  const fallbackGlbUrl = project.glb_url || project.approved_glb_url;

  // ----- Preload target -----
  // Resolve, on the server, the exact GLB the viewer will show on
  // first paint — the same resolution ModelViewerPage does on the
  // client. Knowing it here is what lets us start the download from
  // the HTML <head> instead of waiting for hydration (see
  // lib/model-viewer-config.ts for the full reasoning).
  // Mirrors ModelViewerPage's own resolution EXACTLY, including the
  // case of a variant that exists but has no model yet — that shows
  // the "No GLB uploaded" state, so falling back to the product's
  // asset here would preload megabytes the page never renders.
  const activeVariant = activeVariantId
    ? variants.find((v) => v.id === activeVariantId) ?? null
    : null;
  const activeGlbUrl = activeVariant ? activeVariant.glbUrl : fallbackGlbUrl;
  const glbOrigin = originOf(activeGlbUrl);

  return (
    <>
      {/* ----------------------------------------------------------
          Resource hints. React 19 hoists these into <head>, so they
          ship with the initial HTML and the browser opens the R2
          connection + starts BOTH the model-viewer bundle and the
          GLB before any of our JS has run. Previously the GLB fetch
          couldn't begin until hydration had appended the script and
          the custom element had upgraded — a dead serial wait of
          several hundred ms to a couple of seconds.

          The GLB preload MUST carry crossOrigin="anonymous" to match
          model-viewer's own CORS fetch; without it the browser
          treats them as different requests and downloads the model
          twice, which is worse than not preloading at all.
         ---------------------------------------------------------- */}
      {glbOrigin && glbOrigin !== MODEL_VIEWER_ORIGIN && (
        <link rel="preconnect" href={glbOrigin} crossOrigin="anonymous" />
      )}
      <link rel="preconnect" href={MODEL_VIEWER_ORIGIN} crossOrigin="anonymous" />
      {/* Environment maps live on a different host and are only
          fetched if the reviewer picks a photographic environment.
          The preconnect costs nothing when they don't, and saves
          the DNS + TLS round trip when they do. */}
      {HDR_ORIGIN && HDR_ORIGIN !== MODEL_VIEWER_ORIGIN && (
        <link rel="preconnect" href={HDR_ORIGIN} crossOrigin="anonymous" />
      )}
      <link
        rel="modulepreload"
        href={MODEL_VIEWER_SCRIPT_URL}
        crossOrigin="anonymous"
      />
      {activeGlbUrl && (
        <link
          rel="preload"
          href={activeGlbUrl}
          as="fetch"
          crossOrigin="anonymous"
        />
      )}
      {/* Load the custom element definition from the document itself
          rather than from a client-side effect. React dedupes async
          scripts by src, and ModelViewer checks for an existing tag
          before injecting its own, so this never loads twice. */}
      <script type="module" src={MODEL_VIEWER_SCRIPT_URL} async />

      <ModelViewerPage
        projectName={project.name}
        clientName={c?.name ?? ''}
        variants={variants}
        activeVariantId={activeVariantId}
        fallbackGlbUrl={fallbackGlbUrl}
        fallbackRevision={project.revision_count ?? 0}
      />
    </>
  );
}
