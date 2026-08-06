import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { processArtistZipFromUrl } from '../../../../lib/zip';
import { isOurPublicUrl } from '../../../../lib/r2';

export const runtime = 'nodejs';
// Long-running because we fetch the zip back from R2 and extract
// + re-upload its pieces. The zip is already on R2 (uploaded
// direct from the browser), so this server only handles the
// extraction step.
export const maxDuration = 300;

// ============================================================
// POST /api/projects/:id/finalize-upload
// Body: { zip_url: string }
//
// Called AFTER the browser has PUT the .zip directly to R2.
// We:
//   1. Verify the project exists and isn't already approved
//   2. Compute next revision number
//   3. Fetch the zip from R2, extract its parts, push each
//      part back to R2 under .../uploads/rev-N/
//   4. Update project row → qa_pending
//
// Why split from upload-sign?
//   - The sign endpoint is hit ONCE before upload — fast.
//   - This endpoint runs AFTER upload — slow (downloads, parses
//     zip, uploads 3 files). Splitting lets the signing path stay
//     snappy and lets us safely set a long maxDuration just for
//     the heavy step.
// ============================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('3d_artist');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: { zip_url?: string; variant_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { zip_url } = body;
  const variantId = body.variant_id;
  if (!zip_url || !isOurPublicUrl(zip_url)) {
    // Refuse arbitrary URLs — only our R2 bucket is trusted.
    // (Legacy Cloudinary URLs are rejected on purpose; existing
    // approved rows aren't re-finalised through here.)
    return NextResponse.json(
      { error: 'zip_url must be an R2 URL from our bucket.' },
      { status: 400 }
    );
  }

  // ----- 1. Load project + client -----
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select('id, slug, status, revision_count, glb_url, assigned_to, client:uflow_clients(slug)')
    .eq('id', id)
    .maybeSingle();

  if (pErr || !project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  if (project.status === 'approved') {
    return NextResponse.json(
      { error: 'Project is already approved.' },
      { status: 400 }
    );
  }
  const clientRel = project.client as
    | { slug: string }
    | { slug: string }[]
    | null;
  const cSlug = Array.isArray(clientRel) ? clientRel[0]?.slug : clientRel?.slug;
  if (!cSlug) {
    return NextResponse.json(
      { error: 'Project has no client.' },
      { status: 500 }
    );
  }

  // ----- 1b. Resolve the variant target -----
  // Mirrors upload-sign so the extracted assets land beside the
  // zip the browser already PUT. Omitting variant_id keeps the
  // legacy single-model path writing onto uflow_projects.
  type VariantRow = {
    id: string;
    project_id: string;
    slug: string;
    status: string;
    revision_count: number;
    glb_url: string | null;
    assigned_to: string | null;
    is_primary: boolean;
  };
  let variant: VariantRow | null = null;

  if (variantId) {
    const { data: v, error: vErr } = await supabase()
      .from('uflow_project_variants')
      .select(
        'id, project_id, slug, status, revision_count, glb_url, assigned_to, is_primary'
      )
      .eq('id', variantId)
      .maybeSingle();

    if (vErr || !v) {
      return NextResponse.json({ error: 'Variant not found.' }, { status: 404 });
    }
    if (v.project_id !== id) {
      return NextResponse.json(
        { error: 'That variant belongs to a different project.' },
        { status: 400 }
      );
    }
    const ownsVariant = v.assigned_to === auth.userId;
    const ownsProject = project.assigned_to === auth.userId;
    if (!ownsVariant && !ownsProject) {
      return NextResponse.json(
        { error: 'This variant is not assigned to you.' },
        { status: 403 }
      );
    }
    if (v.status === 'approved') {
      return NextResponse.json(
        { error: 'This variant is already approved.' },
        { status: 400 }
      );
    }
    variant = v as VariantRow;
  }

  // Asset namespace + revision come from whichever row owns this
  // upload. Primary variants keep the bare project slug so their
  // published URLs don't move.
  const assetSlug =
    variant && !variant.is_primary
      ? `${project.slug}-${variant.slug}`
      : project.slug;
  const currentRevision = variant
    ? variant.revision_count
    : project.revision_count;

  // Cache-busting upload sequence, read from whichever row we're
  // about to write.
  const prevGlb = variant ? variant.glb_url : project.glb_url;
  const prevSeqMatch = prevGlb?.match(/_(\d+)\.glb(?:[?#].*)?$/i);
  const uploadSeq = prevSeqMatch ? parseInt(prevSeqMatch[1], 10) + 1 : 1;

  // ----- 2. Extract + re-upload pieces -----
  let processed;
  try {
    processed = await processArtistZipFromUrl(
      zip_url,
      cSlug,
      assetSlug,
      currentRevision,
      uploadSeq
    );
  } catch (err) {
    console.error('[finalize-upload] zip error', err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  // ----- 3. Update the owning row -----
  // NOTE: revision_count is deliberately NOT written here. It's
  // owned by the rejection path (POST /feedback) which is the
  // only place that advances it. The upload just sets the new
  // file URLs and flips status back to qa_pending for re-review.
  //
  // When a variant was targeted we write ONLY the variant row.
  // The product's own status is a roll-up of its variants, so
  // flipping uflow_projects here would let one colourway drag
  // the whole product into IQA while its siblings are untouched.
  const assetPatch = {
    status: 'qa_pending',
    zip_url,
    glb_url: processed.glbUrl,
    fbx_url: processed.fbxUrl,
    gltf_url: processed.gltfUrl,
    updated_at: new Date().toISOString(),
  };

  const { error: uErr } = variant
    ? await supabase()
        .from('uflow_project_variants')
        .update(assetPatch)
        .eq('id', variant.id)
    : await supabase()
        .from('uflow_projects')
        .update({ ...assetPatch, spp_url: processed.sppUrl })
        .eq('id', id);

  if (uErr) {
    console.error('[finalize-upload] db update', uErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    variant_id: variant?.id ?? null,
    revision: currentRevision,
    upload_seq: uploadSeq,
    status: 'qa_pending',
    urls: processed,
  });
}
