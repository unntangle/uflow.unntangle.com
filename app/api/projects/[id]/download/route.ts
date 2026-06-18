import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { fetchFromUrl } from '../../../../lib/r2';

export const runtime = 'nodejs';
// Never cache this route — every hit must re-read the row so a
// download issued after a fresh upload returns the new file, not
// a framework-cached response.
export const dynamic = 'force-dynamic';
// Pulls the GLB bytes back from R2 and re-streams them, so give
// it room for a large model on a slow link.
export const maxDuration = 120;

// ============================================================
// GET /api/projects/:id/download
//
// Streams the project's current GLB back to the browser as a
// file download (Content-Disposition: attachment) named
// <slug>.glb. Going through our own server (rather than linking
// straight at the R2 public URL) does two things:
//   1. Forces a real download with a clean filename instead of
//      the browser navigating to / previewing the raw asset
//      (the `download` attribute is ignored cross-origin).
//   2. Keeps the request auth-gated and brand-scoped — the raw
//      R2 URL is public, but the list of which job maps to which
//      file stays behind our session.
//
// LATEST VERSION ONLY. We resolve `glb_url` from the DB on every
// request — the client sends just the job id, never a URL — and
// the upload pipeline rewrites `glb_url` to the newest file on
// each submission (every finalize bumps the GLB's "_N" suffix so
// a re-upload lands at a fresh key and `glb_url` follows it). So
// the row's `glb_url` always points at the most recent revision,
// and a download can never hand back a superseded version — even
// if the page was loaded before the latest upload happened.
//
// `glb_url` is present for any job that has had an upload,
// including approved ones (approval doesn't clear it). We
// deliberately do NOT use `approved_glb_url`: that points at the
// public viewer *page* (index.html), not the raw model.
//
// Auth / scoping mirrors the model-viewer page:
//   - admin:     any project
//   - 3d_artist: only jobs assigned to them
//   - client:    only jobs in their own brand
// ============================================================
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const { data: project, error } = await supabase()
    .from('uflow_projects')
    .select('id, slug, name, glb_url, assigned_to, client_id')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[projects.download]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Per-role scoping. A 404 (not 403) for the wrong brand/artist
  // so we don't even confirm the job exists to someone who
  // shouldn't see it.
  if (auth.role === '3d_artist') {
    if (project.assigned_to !== auth.userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  } else if (auth.role === 'client') {
    if (!auth.clientId || project.client_id !== auth.clientId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  if (!project.glb_url) {
    return NextResponse.json(
      { error: 'This job has no GLB file to download yet.' },
      { status: 404 }
    );
  }

  let buf: Buffer;
  try {
    buf = await fetchFromUrl(project.glb_url);
  } catch (err) {
    console.error('[projects.download] fetch', err);
    return NextResponse.json(
      { error: 'Could not fetch the GLB from storage.' },
      { status: 502 }
    );
  }

  // slug is normalised to [a-z0-9-] on create, so it's safe to
  // drop straight into the filename without escaping.
  const filename = `${project.slug}.glb`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
      // The GLB can change on re-upload and is session-scoped, so
      // don't let a shared cache hold a copy.
      'Cache-Control': 'private, no-store',
    },
  });
}
