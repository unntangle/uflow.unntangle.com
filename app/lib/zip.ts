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
} from './r2';

export type ProcessedUpload = {
  // The R2 public URL of the source zip. We keep it on the row
  // so re-extraction is possible if something fails downstream.
  zipUrl: string;
  glbUrl: string | null;
  fbxUrl: string | null;
  gltfUrl: string | null;
};

// "glb/Jupiter.glb" → "Jupiter.glb"
// "models/glb/Jupiter Chair.glb" → "Jupiter_Chair.glb"
// R2 keys may technically contain spaces, but most CDN tooling
// and `<model-viewer>` are happier without them; we normalise.
function baseName(entryName: string): string {
  const tail = entryName.split('/').pop() || entryName;
  return tail.replace(/\s+/g, '_');
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
  revision: number
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

  if (!glbEntry) {
    // GLB is the only one we strictly require because QA
    // previews it. FBX/GLTF are nice-to-have.
    throw new Error(
      'No .glb file found inside a glb/ folder in the zip. ' +
        'Expected structure: glb/<model>.glb, fbx/<model>.fbx, gltf/<model>.gltf'
    );
  }

  // ----- 3. Upload each model in parallel -----
  const glbFile = baseName(glbEntry.entryName);
  const fbxFile = fbxEntry ? baseName(fbxEntry.entryName) : null;
  const gltfFile = gltfEntry ? baseName(gltfEntry.entryName) : null;

  const [glb, fbx, gltf] = await Promise.all([
    uploadBuffer({
      key: uploadKey(clientSlug, projectSlug, revision, `glb/${glbFile}`),
      body: glbEntry.getData(),
      contentType: contentTypeFor(glbFile),
    }),
    fbxEntry && fbxFile
      ? uploadBuffer({
          key: uploadKey(clientSlug, projectSlug, revision, `fbx/${fbxFile}`),
          body: fbxEntry.getData(),
          contentType: contentTypeFor(fbxFile),
        })
      : Promise.resolve(null),
    gltfEntry && gltfFile
      ? uploadBuffer({
          key: uploadKey(clientSlug, projectSlug, revision, `gltf/${gltfFile}`),
          body: gltfEntry.getData(),
          contentType: contentTypeFor(gltfFile),
        })
      : Promise.resolve(null),
  ]);

  return {
    glbUrl: glb.publicUrl,
    fbxUrl: fbx?.publicUrl ?? null,
    gltfUrl: gltf?.publicUrl ?? null,
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
  revision: number
): Promise<ProcessedUpload> {
  const buffer = await fetchFromUrl(zipUrl);
  const extracted = await extractAndUpload(
    buffer,
    clientSlug,
    projectSlug,
    revision
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
  revision: number
): Promise<ProcessedUpload> {
  const sourceKey = uploadKey(clientSlug, projectSlug, revision, 'source.zip');

  const [{ publicUrl: zipUrl }, extracted] = await Promise.all([
    uploadBuffer({
      key: sourceKey,
      body: zipBuffer,
      contentType: 'application/zip',
    }),
    extractAndUpload(zipBuffer, clientSlug, projectSlug, revision),
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
