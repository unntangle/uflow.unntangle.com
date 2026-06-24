import { NextRequest, NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // Prefer a select that includes spp_url, but fall back to one
  // without it if that column doesn't exist yet (the 2026-06-24
  // migration hasn't been run). Otherwise a missing column would
  // 500 EVERY download — even GLB/FBX/Source that don't need spp.
  const COLS_BASE =
    'id, slug, name, glb_url, fbx_url, gltf_url, zip_url, assigned_to, client_id';
  const COLS_WITH_SPP = COLS_BASE.replace('zip_url,', 'zip_url, spp_url,');

  let project: Record<string, string | null> | null = null;
  const withSpp = await supabase()
    .from('uflow_projects')
    .select(COLS_WITH_SPP)
    .eq('id', id)
    .maybeSingle();
  if (!withSpp.error) {
    project = withSpp.data as Record<string, string | null> | null;
  } else {
    console.error(
      '[projects.download] spp_url select failed, retrying without it:',
      withSpp.error.message
    );
    const noSpp = await supabase()
      .from('uflow_projects')
      .select(COLS_BASE)
      .eq('id', id)
      .maybeSingle();
    if (noSpp.error) {
      console.error('[projects.download]', noSpp.error);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
    project = noSpp.data as Record<string, string | null> | null;
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

  // Which asset to stream. Defaults to 'glb' so existing callers
  // that hit /download with no query param keep getting the GLB.
  // Source is the artist's complete upload zip; spp is the
  // Substance Painter project file (both extracted at finalize).
  const ASSETS = {
    glb: {
      url: project.glb_url,
      filename: `${project.slug}.glb`,
      contentType: 'model/gltf-binary',
    },
    fbx: {
      url: project.fbx_url,
      filename: `${project.slug}.fbx`,
      contentType: 'application/octet-stream',
    },
    gltf: {
      url: project.gltf_url,
      filename: `${project.slug}.gltf`,
      contentType: 'model/gltf+json',
    },
    zip: {
      url: project.zip_url,
      filename: `${project.slug}-source.zip`,
      contentType: 'application/zip',
    },
    spp: {
      url: project.spp_url,
      filename: `${project.slug}.spp`,
      contentType: 'application/octet-stream',
    },
  } as const;

  const typeParam = (
    req.nextUrl.searchParams.get('type') || 'glb'
  ).toLowerCase();
  if (!(typeParam in ASSETS)) {
    return NextResponse.json(
      { error: `Unknown asset type "${typeParam}".` },
      { status: 400 }
    );
  }

  // ----- FBX special-case: download the ENTIRE fbx/ folder -----
  // The extractor only stored the lone .fbx, but the artist may
  // have bundled textures/companions in the fbx/ folder. The
  // source zip always holds the complete folder, so we rebuild a
  // fbx zip from it on the fly — works for every existing job
  // without a re-upload and without extra storage. We preserve the
  // path from the `fbx/` segment onward so the download contains a
  // clean fbx/ folder. If the source zip has no fbx/ folder (or
  // there's no source zip), we fall through to streaming the
  // single .fbx file below.
  if (typeParam === 'fbx' && project.zip_url) {
    let outBuf: Buffer | null = null;
    try {
      const srcBuf = await fetchFromUrl(project.zip_url);
      const src = new AdmZip(srcBuf);
      const out = new AdmZip();
      let count = 0;
      for (const e of src.getEntries()) {
        if (e.isDirectory) continue;
        // Match an `fbx/` path segment (root or wrapped) and keep
        // everything from it onward: wrapper/fbx/tex/wood.png ->
        // fbx/tex/wood.png. A folder like `myfbx/` won't match.
        const m = e.entryName.match(/(?:^|\/)(fbx\/.+)$/i);
        if (!m) continue;
        out.addFile(m[1], e.getData());
        count++;
      }
      if (count > 0) outBuf = out.toBuffer();
    } catch (err) {
      console.error('[projects.download] fbx folder zip failed', err);
      return NextResponse.json(
        { error: 'Could not build the FBX folder zip from storage.' },
        { status: 502 }
      );
    }
    if (outBuf) {
      return new NextResponse(new Uint8Array(outBuf), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${project.slug}-fbx.zip"`,
          'Content-Length': String(outBuf.length),
          'Cache-Control': 'private, no-store',
        },
      });
    }
    // count === 0: no fbx/ folder in the source zip — fall through
    // to the single-file path (404s if fbx_url is also empty).
  }

  const asset = ASSETS[typeParam as keyof typeof ASSETS];

  if (!asset.url) {
    return NextResponse.json(
      { error: `This job has no ${typeParam.toUpperCase()} file to download yet.` },
      { status: 404 }
    );
  }

  let buf: Buffer;
  try {
    buf = await fetchFromUrl(asset.url);
  } catch (err) {
    console.error('[projects.download] fetch', err);
    return NextResponse.json(
      { error: 'Could not fetch the file from storage.' },
      { status: 502 }
    );
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': asset.contentType,
      'Content-Disposition': `attachment; filename="${asset.filename}"`,
      'Content-Length': String(buf.length),
      // Assets can change on re-upload and are session-scoped, so
      // don't let a shared cache hold a copy.
      'Cache-Control': 'private, no-store',
    },
  });
}
