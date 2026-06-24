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

  let body: { zip_url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { zip_url } = body;
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
    .select('id, slug, status, revision_count, glb_url, client:uflow_clients(slug)')
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

  // revision_count tracks REJECTION rounds, not uploads. An
  // upload (first time or re-submission after rejection) doesn't
  // advance the counter — only an admin IQA rejection does. So
  // the rev folder used for this upload is the current counter:
  //   0 = fresh first submission (no rejections yet)
  //   N = the Nth re-submission, replacing what was rejected N times
  // Re-uploads within the same rejection round overwrite the
  // previous zip in that rev folder, which is what we want —
  // the rejected version is being replaced.
  const currentRevision = project.revision_count;

  // Cache-busting upload sequence. Every finalize bumps the GLB
  // filename's "_N" suffix so the new model gets a fresh public
  // URL — otherwise a re-upload within the same revision round
  // overwrites the same R2 key and QA / the client keep seeing
  // the cached old model. We derive the next number from the
  // current glb_url's suffix (".../Name_2.glb" -> 3); a missing
  // or unsuffixed URL (first upload, or a legacy row) starts at 1.
  const prevSeqMatch = project.glb_url?.match(/_(\d+)\.glb(?:[?#].*)?$/i);
  const uploadSeq = prevSeqMatch ? parseInt(prevSeqMatch[1], 10) + 1 : 1;

  // ----- 2. Extract + re-upload pieces -----
  let processed;
  try {
    processed = await processArtistZipFromUrl(
      zip_url,
      cSlug,
      project.slug,
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

  // ----- 3. Update project row -----
  // NOTE: revision_count is deliberately NOT written here. It's
  // owned by the rejection path (POST /feedback) which is the
  // only place that advances it. The upload just sets the new
  // file URLs and flips status back to qa_pending for re-review.
  const { error: uErr } = await supabase()
    .from('uflow_projects')
    .update({
      status: 'qa_pending',
      zip_url,
      glb_url: processed.glbUrl,
      fbx_url: processed.fbxUrl,
      gltf_url: processed.gltfUrl,
      spp_url: processed.sppUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (uErr) {
    console.error('[finalize-upload] db update', uErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    revision: currentRevision,
    upload_seq: uploadSeq,
    status: 'qa_pending',
    urls: processed,
  });
}
