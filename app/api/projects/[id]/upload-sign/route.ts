import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { signUploadUrl, uploadKey } from '../../../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// POST /api/projects/:id/upload-sign
//
// Mints a Cloudflare R2 presigned PUT URL scoped to THIS
// project's next revision folder. The browser then PUTs the
// zip body directly to that URL — bypassing Vercel's 4.5 MB
// inbound limit and not bound by any per-file size cap from
// our storage layer.
//
// Returns:
//   {
//     upload_url:    string  // presigned URL the browser PUTs to
//     public_url:    string  // where the file will be readable from
//     revision:      number  // so the UI can label the upload
//   }
//
// Server-side validation:
//   - Project must exist
//   - Project must not be 'approved' (already done)
//   - Key is derived from project metadata, not from client input,
//     so a compromised browser can't write into another project.
// ============================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('3d_artist');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // Optional variant target. Omitted = the product's primary
  // variant (legacy single-model behaviour), so existing callers
  // keep working unchanged.
  let body: { variant_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    // No body is fine — treat as "primary variant".
  }
  const variantId = body.variant_id;

  // ----- Load project + client -----
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select('id, slug, status, revision_count, assigned_to, client:uflow_clients(slug)')
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

  // ----- Resolve the variant being uploaded for -----
  // Assets are namespaced per variant so nothing collides:
  //   primary      → <client>/smart/uploads/rev-N/
  //   "grey"       → <client>/smart-grey/uploads/rev-N/
  // The primary keeps the bare project slug so already-published
  // models and their public URLs are untouched.
  let assetSlug = project.slug;
  let currentRevision = project.revision_count;

  if (variantId) {
    const { data: variant, error: vErr } = await supabase()
      .from('uflow_project_variants')
      .select('id, project_id, slug, status, revision_count, assigned_to, is_primary')
      .eq('id', variantId)
      .maybeSingle();

    if (vErr || !variant) {
      return NextResponse.json({ error: 'Variant not found.' }, { status: 404 });
    }
    // Guard against a variant id from a different product being
    // passed in to write into this project's namespace.
    if (variant.project_id !== id) {
      return NextResponse.json(
        { error: 'That variant belongs to a different project.' },
        { status: 400 }
      );
    }
    // The artist must hold either this specific variant or the
    // product itself — variants can be split off to a different
    // artist than the one on the parent.
    const ownsVariant = variant.assigned_to === auth.userId;
    const ownsProject = project.assigned_to === auth.userId;
    if (!ownsVariant && !ownsProject) {
      return NextResponse.json(
        { error: 'This variant is not assigned to you.' },
        { status: 403 }
      );
    }
    if (variant.status === 'approved') {
      return NextResponse.json(
        { error: 'This variant is already approved.' },
        { status: 400 }
      );
    }
    assetSlug = variant.is_primary
      ? project.slug
      : `${project.slug}-${variant.slug}`;
    currentRevision = variant.revision_count;
  }

  // The zip lands at <client>/<assetSlug>/uploads/rev-N/source.zip.
  // Fixed filename so each revision has exactly one source zip;
  // the browser is told to PUT to this key.
  const key = uploadKey(cSlug, assetSlug, currentRevision, 'source.zip');

  try {
    const { url, publicUrl } = await signUploadUrl({
      key,
      contentType: 'application/zip',
      // Long enough for a slow connection uploading a big zip,
      // short enough that a leaked URL stops being useful soon.
      expiresInSeconds: 3600,
    });

    return NextResponse.json({
      upload_url: url,
      public_url: publicUrl,
      revision: currentRevision,
    });
  } catch (err) {
    console.error('[upload-sign]', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Could not sign upload.' },
      { status: 500 }
    );
  }
}
