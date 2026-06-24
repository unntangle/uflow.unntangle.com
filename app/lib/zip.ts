// ============================================================
// Zip processing — server-side (Cloudflare R2 edition)
// ============================================================
// The artist uploads a single .zip containing three subfolders:
//   fbx/
//   glb/
//   gltf/
//
// Flow:
//   1. The browser uploads the zip DIRECTLY to R2 via a
//      presigned PUT URL minted by /api/projects/:id/upload-sign.
//      This bypasses Vercel's 4.5 MB request-body limit and
//      avoids Cloudinary's 10 MB free-tier cap.
//   2. The browser then POSTs the resulting public URL to
//      /api/projects/:id/finalize-upload.
//   3. THIS module: fetches that zip back from R2, finds the
//      .glb / .fbx / .gltf inside, and re-uploads each piece to
//        <client>/<project>/uploads/rev-N/{glb,fbx,gltf}/<file>
//      so QA can preview the .glb via a stable URL.
// ============================================================

import AdmZip from 'adm-zip';
import {
  uploadBuffer,
  uploadKey,
  fetchFromUrl,
  publicUrlFor,
  listKeysByPrefix,
  deleteKeys,
} from './r2';

export type ProcessedUpload = {
  // The R2 public URL of the source zip. We keep it on the row
  // so re-extraction is possible if something fails downstream.
  zipUrl: string;
  glbUrl: string | null;
  fbxUrl: string | null;
  gltfUrl: string | null;
  sppUrl: string | null;
};

// "glb/Jupiter.glb" → "Jupiter.glb"
// "models/glb/Jupiter Chair.glb" → "Jupiter_Chair.glb"
// R2 keys may technically contain spaces, but most CDN tooling
// and `<model-viewer>` are happier without them; we normalise.
function baseName(entryName: string): string {
  const tail = entryName.split('/').pop() || entryName;
  return tail.replace(/\s+/g, '_');
}

// Strip a trailing "_<digits>" from a base name so repeated
// uploads don't accumulate (Jupiter_1 -> Jupiter, not
// Jupiter_1 -> Jupiter_1_2).
function stripSeq(base: string): string {
  return base.replace(/_\d+$/, '');
}

// Insert an incrementing "_<seq>" before the extension so every
// upload produces a BRAND-NEW GLB filename, and therefore a
// brand-new public URL. Without this, re-uploading within the
// same revision round overwrites the same R2 key in place, and
// the browser / CDN keeps serving the cached previous model to
// QA and the client. e.g. ("Jupiter.glb", 3) -> "Jupiter_3.glb".
function withSeq(filename: string, seq: number): string {
  const dot = filename.lastIndexOf('.');
  const name = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  return `${stripSeq(name)}_${seq}${ext}`;
}

// Best-effort content type for the three model formats. R2
// stores whatever we set, and the public URL serves it back
// verbatim, which is what `<model-viewer>` needs.
function contentTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.glb')) return 'model/gltf-binary';
  if (lower.endsWith('.gltf')) return 'model/gltf+json';
  if (lower.endsWith('.fbx')) return 'application/octet-stream';
  return 'application/octet-stream';
}

// ============================================================
// Core extractor — takes an in-memory zip buffer, finds the
// three model files, and uploads each to R2.
// ============================================================
async function extractAndUpload(
  zipBuffer: Buffer,
  clientSlug: string,
  projectSlug: string,
  revision: number,
  // Monotonic per-project upload counter. Appended to the GLB
  // filename for cache-busting (see withSeq).
  uploadSeq: number
): Promise<Omit<ProcessedUpload, 'zipUrl'>> {
  // ----- 1. Parse zip -----
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new Error(`Could not read zip file: ${(err as Error).message}`);
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new Error('Zip file is empty.');
  }

  // ----- 2. Locate the three model files -----
  // Match anywhere inside the path so that both
  //   glb/Jupiter.glb         (zip with 3 top-level folders)
  //   models/glb/Jupiter.glb  (zip with a wrapping folder)
  // both work.
  const findInFolder = (folder: string, ext: string) => {
    const folderRe = new RegExp(`(^|/)${folder}/`, 'i');
    const extRe = new RegExp(`\\.${ext}$`, 'i');
    return entries.find(
      (e) =>
        !e.isDirectory &&
        folderRe.test(e.entryName) &&
        extRe.test(e.entryName)
    );
  };

  const glbEntry = findInFolder('glb', 'glb');
  const fbxEntry = findInFolder('fbx', 'fbx');
  const gltfEntry = findInFolder('gltf', 'gltf');

  // SPP (Substance Painter project) — artists may include the
  // source .spp so QA/admin can re-open the texturing project.
  // Unlike glb/fbx/gltf it isn't expected in a fixed subfolder,
  // so we match the first .spp found anywhere in the zip.
  const sppEntry = entries.find(
    (e) => !e.isDirectory && /\.spp$/i.test(e.entryName)
  );

  if (!glbEntry) {
    // GLB is the only one we strictly require because QA
    // previews it. FBX/GLTF are nice-to-have.
    throw new Error(
      'No .glb file found inside a glb/ folder in the zip. ' +
        'Expected structure: glb/<model>.glb, fbx/<model>.fbx, gltf/<model>.gltf'
    );
  }

  // ----- 3. Upload each model in parallel -----
  // The GLB is the file QA + the client preview, so it's the one
  // that must get a unique name every upload (cache-busting).
  // FBX/GLTF aren't previewed, so they keep their plain names.
  const glbFile = withSeq(baseName(glbEntry.entryName), uploadSeq);
  const fbxFile = fbxEntry ? baseName(fbxEntry.entryName) : null;
  const gltfFile = gltfEntry ? baseName(gltfEntry.entryName) : null;
  const sppFile = sppEntry ? baseName(sppEntry.entryName) : null;

  // Resolve the exact keys up front so we can (a) upload to them
  // and (b) know precisely which keys to KEEP when pruning below.
  const glbKey = uploadKey(clientSlug, projectSlug, revision, `glb/${glbFile}`);
  const fbxKey = fbxFile
    ? uploadKey(clientSlug, projectSlug, revision, `fbx/${fbxFile}`)
    : null;
  const gltfKey = gltfFile
    ? uploadKey(clientSlug, projectSlug, revision, `gltf/${gltfFile}`)
    : null;
  const sppKey = sppFile
    ? uploadKey(clientSlug, projectSlug, revision, `spp/${sppFile}`)
    : null;

  const [glb, fbx, gltf, spp] = await Promise.all([
    uploadBuffer({
      key: glbKey,
      body: glbEntry.getData(),
      contentType: contentTypeFor(glbFile),
    }),
    fbxEntry && fbxKey
      ? uploadBuffer({
          key: fbxKey,
          body: fbxEntry.getData(),
          contentType: contentTypeFor(fbxFile!),
        })
      : Promise.resolve(null),
    gltfEntry && gltfKey
      ? uploadBuffer({
          key: gltfKey,
          body: gltfEntry.getData(),
          contentType: contentTypeFor(gltfFile!),
        })
      : Promise.resolve(null),
    sppEntry && sppKey
      ? uploadBuffer({
          key: sppKey,
          body: sppEntry.getData(),
          // .spp is an opaque binary blob to us; octet-stream is
          // the right neutral type for a forced download.
          contentType: 'application/octet-stream',
        })
      : Promise.resolve(null),
  ]);

  // ----- 4. Prune superseded model files -----
  // The GLB cache-busting suffix means every re-upload writes a
  // BRAND-NEW glb key, and a renamed model can also leave a stale
  // fbx/gltf behind. Left alone these orphans accumulate in R2
  // forever (storage bloat). So after the new files are safely
  // up, we list this revision's model subfolders and delete every
  // glb/fbx/gltf object that ISN'T one we just wrote.
  //
  // Scope is deliberately tight:
  //   - Only keys under uploads/rev-N/{glb,fbx,gltf}/ are touched.
  //   - source.zip (at rev-N/ root) is never matched, so the
  //     source of truth for re-extraction survives.
  //   - Other revision folders and the approved/ copy are never
  //     touched.
  //
  // Best-effort: a prune failure must NOT fail the upload — the
  // new model is already live and the DB will point at it. Worst
  // case is leftover storage, which the next upload re-attempts.
  try {
    const keep = new Set(
      [glbKey, fbxKey, gltfKey, sppKey].filter((k): k is string => Boolean(k))
    );
    const revPrefix = uploadKey(clientSlug, projectSlug, revision, '');
    const existing = await listKeysByPrefix(revPrefix);
    const stale = existing.filter(
      (k) => /\/(glb|fbx|gltf|spp)\//i.test(k) && !keep.has(k)
    );
    if (stale.length > 0) {
      await deleteKeys(stale);
    }
  } catch (err) {
    console.error('[zip] superseded-file prune failed (non-fatal)', err);
  }

  return {
    glbUrl: glb.publicUrl,
    fbxUrl: fbx?.publicUrl ?? null,
    gltfUrl: gltf?.publicUrl ?? null,
    sppUrl: spp?.publicUrl ?? null,
  };
}

// ============================================================
// processArtistZipFromUrl
// Used by /api/projects/:id/finalize-upload. The browser has
// already pushed the zip to R2; we fetch it back, extract
// pieces, and reuse the existing public URL for the source zip.
// ============================================================
export async function processArtistZipFromUrl(
  zipUrl: string,
  clientSlug: string,
  projectSlug: string,
  revision: number,
  uploadSeq: number
): Promise<ProcessedUpload> {
  const buffer = await fetchFromUrl(zipUrl);
  const extracted = await extractAndUpload(
    buffer,
    clientSlug,
    projectSlug,
    revision,
    uploadSeq
  );
  return { zipUrl, ...extracted };
}

// ============================================================
// processArtistZip (legacy — kept for the FormData upload route)
// Used by /api/projects/:id/upload (Vercel 4.5 MB limit applies).
// Uploads the source zip AND extracts in one shot.
// ============================================================
export async function processArtistZip(
  zipBuffer: Buffer,
  clientSlug: string,
  projectSlug: string,
  revision: number,
  uploadSeq: number
): Promise<ProcessedUpload> {
  const sourceKey = uploadKey(clientSlug, projectSlug, revision, 'source.zip');

  const [{ publicUrl: zipUrl }, extracted] = await Promise.all([
    uploadBuffer({
      key: sourceKey,
      body: zipBuffer,
      contentType: 'application/zip',
    }),
    extractAndUpload(zipBuffer, clientSlug, projectSlug, revision, uploadSeq),
  ]);

  // Defensive: the parallel call returns a `publicUrl` we already
  // could have computed, but using the returned one keeps the
  // shape symmetric with processArtistZipFromUrl. Discard the
  // computed-anyway alternative.
  void publicUrlFor;

  return {
    zipUrl,
    ...extracted,
  };
}
