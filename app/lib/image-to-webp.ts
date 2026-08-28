'use client';

// ============================================================
// toWebp — re-encode a picked image to WebP before upload
// ============================================================
// Reference photos come straight off a phone or a supplier's
// website, so they're routinely 3–8 MB JPEGs at 4000px. Every
// artist, reviewer and client then downloads the full original
// just to see a 44px thumbnail in a table cell. Re-encoding to
// WebP typically cuts that by 60–80% with no visible difference
// at the sizes these are actually viewed at.
//
// Done in the BROWSER, before the signed PUT, rather than on the
// server. Uploads go directly from the browser to R2 — that's
// the whole reason the sign/PUT/finalize split exists (Vercel
// has a 4.5 MB inbound body limit). Converting server-side would
// mean routing every image back through the app, reintroducing
// exactly the bottleneck that design avoids. The conversion also
// costs the uploader's CPU rather than a serverless invocation,
// and it means the smaller file is what crosses the network.
//
// /api/references-sign already accepts image/webp and maps it to
// a .webp key, so nothing server-side needs to change.
// ============================================================

// Quality/размер trade-off. These are the two knobs worth
// touching if artists ever report losing detail they needed.
//
// MAX_EDGE caps the longest side. A 4032px phone photo carries
// far more resolution than anyone uses to judge a chair's
// proportions, and it's the single biggest contributor to file
// size. 3000 keeps enough to zoom into stitching or a label
// while still cutting most of the weight.
//
// QUALITY 0.85 is the usual sweet spot for photographic content
// — artefacts start being visible on flat colour and text below
// roughly 0.75.
const MAX_EDGE = 3000;
const QUALITY = 0.85;

// GIFs are deliberately excluded. Canvas only ever sees the
// first frame, so converting an animated GIF would silently
// throw away every other frame. They're rare as references and
// small enough not to matter.
const SKIP_TYPES = new Set(['image/gif', 'image/webp']);

// ------------------------------------------------------------
// Convert one file. Returns the ORIGINAL file unchanged if:
//   * it's a GIF or already WebP
//   * the browser can't decode or encode it
//   * the result came out no smaller than the original
//
// That last case is real: small PNG screenshots with flat colour
// and sharp text sometimes encode larger as lossy WebP than as
// the original PNG. Uploading the bigger file to claim the
// optimisation would be worse than doing nothing.
// ------------------------------------------------------------
export async function toWebp(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (SKIP_TYPES.has(file.type)) return file;

  try {
    const bitmap = await createImageBitmap(file);

    const scale = Math.min(
      1,
      MAX_EDGE / Math.max(bitmap.width, bitmap.height)
    );
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    // Frees the decoded pixels immediately rather than waiting
    // for GC. A batch of 20 phone photos is easily 500 MB decoded.
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', QUALITY)
    );
    // Release the canvas backing store too.
    canvas.width = 0;
    canvas.height = 0;

    if (!blob) return file;
    // No gain — keep the original rather than upload something
    // bigger under a .webp name.
    if (blob.size >= file.size) return file;

    const base = file.name.replace(/\.[^.]+$/, '') || 'reference';
    return new File([blob], `${base}.webp`, {
      type: 'image/webp',
      lastModified: Date.now(),
    });
  } catch {
    // Unsupported codec, corrupt file, OOM on a huge image —
    // any of these should degrade to "upload what they picked",
    // never to a failed upload.
    return file;
  }
}

// ------------------------------------------------------------
// Convert a batch, sequentially.
//
// Deliberately NOT Promise.all: decoding several 4000px images
// at once spikes memory hard enough to crash a tab on a modest
// laptop, and the work is CPU-bound anyway so parallelism buys
// nothing. Twenty images take a couple of seconds.
// ------------------------------------------------------------
export async function toWebpAll(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    out.push(await toWebp(f));
  }
  return out;
}
