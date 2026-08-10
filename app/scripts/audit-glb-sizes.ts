// ============================================================
// audit-glb-sizes — how heavy are our models, really?
// ============================================================
// Front-end loading tricks (preload, preconnect, caching) remove
// the WAITING from a model load; they can't remove the BYTES. If
// the viewer still feels slow after those, the file itself is the
// problem — and this tells you by how much.
//
// HEADs every GLB referenced by uflow_projects + uflow_project_
// variants and prints them worst-first, with the Cache-Control R2
// is actually serving so you can confirm the caching fix landed
// on newly uploaded models.
//
// Run:  npx tsx app/scripts/audit-glb-sizes.ts
//
// Rough reading of the numbers, over a typical office connection:
//   < 5 MB    fine, loads in ~1s
//   5-15 MB   noticeable but tolerable
//   15-40 MB  this is what "taking too long" feels like
//   > 40 MB   the model needs compressing, not the page tuning
// ============================================================

import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

type Row = { label: string; url: string };

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const { supabase } = await import('../lib/supabase');
  const db = supabase();

  const rows: Row[] = [];

  const { data: projects, error: pErr } = await db
    .from('uflow_projects')
    .select('name, slug, glb_url, approved_glb_url');
  if (pErr) {
    console.error(JSON.stringify(pErr, null, 2));
    process.exit(1);
  }
  for (const p of projects || []) {
    const url = (p.glb_url as string | null) || (p.approved_glb_url as string | null);
    if (url) rows.push({ label: p.name as string, url });
  }

  const { data: variants, error: vErr } = await db
    .from('uflow_project_variants')
    .select('name, glb_url, approved_glb_url, is_primary');
  if (vErr) {
    console.error(JSON.stringify(vErr, null, 2));
    process.exit(1);
  }
  for (const v of variants || []) {
    // The primary variant duplicates the product's own asset, so
    // listing it again would just double every row.
    if (v.is_primary) continue;
    const url = (v.glb_url as string | null) || (v.approved_glb_url as string | null);
    if (url) rows.push({ label: `  \u21b3 ${v.name as string}`, url });
  }

  // HEAD in small batches — enough parallelism to finish quickly,
  // not so much that we look like a scraper to R2.
  const results: {
    label: string;
    bytes: number;
    cacheControl: string;
    url: string;
  }[] = [];

  const BATCH = 8;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const settled = await Promise.all(
      batch.map(async (r) => {
        try {
          const res = await fetch(r.url, { method: 'HEAD' });
          return {
            label: r.label,
            bytes: Number(res.headers.get('content-length') ?? 0),
            cacheControl: res.headers.get('cache-control') ?? '(none)',
            url: r.url,
          };
        } catch {
          return { label: r.label, bytes: -1, cacheControl: '(unreachable)', url: r.url };
        }
      })
    );
    results.push(...settled);
  }

  results.sort((a, b) => b.bytes - a.bytes);

  console.log('\nGLB sizes, largest first\n');
  for (const r of results) {
    const size = r.bytes < 0 ? '   ERROR' : mb(r.bytes).padStart(8);
    console.log(`${size}  ${r.label}`);
    console.log(`          cache-control: ${r.cacheControl}`);
  }

  const ok = results.filter((r) => r.bytes > 0);
  const total = ok.reduce((s, r) => s + r.bytes, 0);
  const uncached = ok.filter((r) => !/max-age=\d+/.test(r.cacheControl)).length;

  console.log(`\n${ok.length} models, ${mb(total)} total, ${mb(total / (ok.length || 1))} average`);
  console.log(`${uncached} of them are served with no cache lifetime.`);
  console.log(
    'Models uploaded before the Cache-Control fix keep their old headers ' +
      'until the artist re-uploads, or until you re-PUT them with the new metadata.\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
