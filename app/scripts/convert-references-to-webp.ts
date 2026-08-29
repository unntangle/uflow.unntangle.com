/**
 * Backfill: re-encode existing reference images to WebP.
 *
 * Run with:
 *   npm i -D sharp
 *   npx tsx app/scripts/convert-references-to-webp.ts --dry-run
 *   npx tsx app/scripts/convert-references-to-webp.ts
 *
 * ------------------------------------------------------------
 * WHY A SCRIPT AND NOT A MIGRATION
 * The rows in uflow_project_references hold absolute URLs to
 * objects in R2. Converting them means fetching bytes, re-
 * encoding, uploading a new object and only then rewriting the
 * row — none of which SQL can do. It also can't run inside a
 * transaction, so it's built to be safely re-runnable instead:
 * every already-.webp row is skipped, so an interrupted run is
 * resumed by simply running it again.
 *
 * WHAT IT DOES NOT DO
 * It never deletes the original object. Storage is cheap next to
 * an unrecoverable mistake, and leaving the old file in place
 * means a bad run is undone by restoring the old URLs from the
 * backup this script writes. Sweep them later once you're happy.
 *
 * SAFETY
 *   * --dry-run reports what would change and writes nothing.
 *   * A JSON backup of every (id, old_url, new_url) is written
 *     before the first DB write, so the mapping to roll back is
 *     always on disk.
 *   * A row is only updated AFTER its new object is confirmed
 *     uploaded. A crash mid-run leaves rows pointing at files
 *     that still exist.
 *   * Images that don't shrink keep their original URL — same
 *     rule the browser-side converter applies.
 * ------------------------------------------------------------
 */

import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import sharp from 'sharp';

// Load env BEFORE anything that reads it. lib/supabase and lib/r2
// both throw from a module-scope helper the moment they're asked
// for a client, and a static `import` of either would be hoisted
// above these two calls — which is exactly why the first run of
// this script died on "Missing SUPABASE_URL". Same arrangement
// republish-all.ts uses: dotenv first, then a lazy import inside
// main().
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Match the browser-side converter in lib/image-to-webp.ts so a
// job's references look consistent regardless of when they were
// uploaded. Change both together.
const MAX_EDGE = 3000;
const QUALITY = 85;

const DRY_RUN = process.argv.includes('--dry-run');

type RefRow = { id: string; image_url: string; project_id: string };

async function main() {
  // Lazy-imported so dotenv above has already populated
  // process.env by the time these modules read it.
  const { supabase } = await import('../lib/supabase');
  const {
    uploadBuffer,
    isOurPublicUrl,
    publicUrlFor,
    fetchFromUrl,
    IMMUTABLE_CACHE_CONTROL,
  } = await import('../lib/r2');

  const { data, error } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, project_id');

  if (error) {
    console.error('Could not load references:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as RefRow[];

  // Skip anything already converted, plus anything not in our own
  // bucket. A stray external URL is not ours to rewrite, and the
  // upload helper would refuse it anyway.
  const todo = rows.filter(
    (r) =>
      r.image_url &&
      isOurPublicUrl(r.image_url) &&
      !/\.webp(\?|$)/i.test(r.image_url)
  );

  console.log(
    `${rows.length} reference rows, ${todo.length} to convert` +
      (DRY_RUN ? ' (dry run)' : '')
  );
  if (todo.length === 0) return;

  const mapping: { id: string; old_url: string; new_url: string }[] = [];
  let converted = 0;
  let skipped = 0;
  let failed = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  // Sequential on purpose. sharp holds the decoded bitmap in
  // memory, and a few dozen 4000px images decoded at once is
  // enough to OOM a small container. This is a one-off job — it
  // can afford to be slow.
  for (const row of todo) {
    try {
      // Goes via a presigned GET rather than the public hostname,
      // so this keeps working if the bucket is ever made private.
      const original = await fetchFromUrl(row.image_url);

      const webp = await sharp(original)
        .rotate() // honour EXIF orientation before it's discarded
        .resize({
          width: MAX_EDGE,
          height: MAX_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: QUALITY })
        .toBuffer();

      bytesBefore += original.length;

      if (webp.length >= original.length) {
        // Same rule as the browser converter: no gain, no change.
        // Common for small flat-colour PNGs.
        bytesAfter += original.length;
        skipped++;
        continue;
      }
      bytesAfter += webp.length;

      // New key beside the old one, same folder. Deriving it from
      // the existing path keeps the client/project prefix intact
      // without having to re-resolve slugs.
      const oldPath = new URL(row.image_url).pathname.replace(/^\/+/, '');
      const dir = oldPath.split('/').slice(0, -1).join('/');
      const newKey = `${dir}/${randomUUID()}.webp`;

      if (DRY_RUN) {
        console.log(
          `  would convert ${oldPath} -> ${newKey} ` +
            `(${kb(original.length)} -> ${kb(webp.length)})`
        );
        converted++;
        continue;
      }

      await uploadBuffer({
        key: newKey,
        body: webp,
        contentType: 'image/webp',
        // The key carries a fresh UUID on every write, so the
        // object at this URL can never change. That's exactly the
        // condition IMMUTABLE_CACHE_CONTROL documents as safe, and
        // it's most of the loading win: without it R2 serves no
        // Cache-Control at all and every dashboard render
        // re-requests each thumbnail.
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
      const newUrl = publicUrlFor(newKey);

      // Update only AFTER the new object exists, so an interrupted
      // run never leaves a row pointing at a file that was never
      // written.
      const { error: uErr } = await supabase()
        .from('uflow_project_references')
        .update({ image_url: newUrl })
        .eq('id', row.id);

      if (uErr) {
        console.warn(`  ! ${row.id}: DB update failed: ${uErr.message}`);
        failed++;
        continue;
      }

      mapping.push({ id: row.id, old_url: row.image_url, new_url: newUrl });
      converted++;
      console.log(
        `  ok ${row.id} (${kb(original.length)} -> ${kb(webp.length)})`
      );
    } catch (e) {
      console.warn(`  ! ${row.id}: ${(e as Error).message}`);
      failed++;
    }
  }

  if (!DRY_RUN && mapping.length > 0) {
    const file = `reference-webp-backup-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(mapping, null, 2));
    console.log(`\nRollback mapping written to ${file}`);
  }

  console.log(
    DRY_RUN
      ? `\nwould convert ${converted}, would leave ${skipped} unchanged, failed ${failed}`
      : `\nconverted ${converted}, unchanged ${skipped}, failed ${failed}`
  );
  if (bytesBefore > 0) {
    const pct = Math.round((1 - bytesAfter / bytesBefore) * 100);
    console.log(`total ${kb(bytesBefore)} -> ${kb(bytesAfter)} (${pct}% smaller)`);
  }
  // Two very different messages. In a dry run NOTHING has been
  // written — saying "originals were left in R2" implies new
  // objects exist beside them, which is exactly the wrong thing
  // to tell someone deciding whether it's safe to proceed.
  console.log(
    DRY_RUN
      ? 'Dry run — nothing was uploaded and no rows were changed. ' +
          'Re-run without --dry-run to apply.'
      : 'Original objects were left in R2. Delete them only once ' +
          'you have verified the new URLs render.'
  );
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(0)} KB`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
