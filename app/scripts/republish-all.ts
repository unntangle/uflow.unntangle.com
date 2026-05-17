// ============================================================
// One-time bootstrap: regenerate every approved project's
// viewer page + the cross-project manifest.
//
// Run with:  npx tsx app/scripts/republish-all.ts
//
// Why:
//   - The viewer-template.ts file evolves over time (added the
//     sidebar drawer, the model picker, etc). Existing published
//     folders keep their old hand-written / old-template HTML
//     until their project gets approved again, which means new
//     features don't appear on those pages.
//   - Running this once after a template change brings every
//     existing folder up to the latest layout.
//   - It also (re)writes manifest.json from the current DB state
//     so the sidebar is populated on every page right after.
//
// This script does NOT re-download GLBs or touch any DB rows.
// It only rewrites index.html in each approved project's folder
// and refreshes the manifest. Safe to re-run.
// ============================================================

import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import path from 'node:path';
// Load environment variables from .env.local (Next.js default) and fall back to .env
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Resolve relative to project root so the script works no matter
// where it's invoked from.
const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_OFFICEMATE_DIR = path.join(ROOT, 'public', 'officemate');

async function main() {
  // Lazy-import so dotenv has already populated process.env
  // before the supabase client tries to read it.
  const { supabase } = await import('../lib/supabase');
  const { renderViewerHtml } = await import('../lib/viewer-template');

  console.log('[republish-all] querying approved projects\u2026');

  const { data, error } = await supabase()
    .from('uflow_projects')
    .select('slug, name, updated_at')
    .eq('status', 'approved')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[republish-all] DB error:', error);
    process.exit(1);
  }

  const projects = data ?? [];
  console.log(`[republish-all] found ${projects.length} approved project(s)`);

  // ----- 1) Rewrite each project's index.html from the template -----
  for (const p of projects) {
    const slug = p.slug as string;
    const name = p.name as string;
    const dir = path.join(PUBLIC_OFFICEMATE_DIR, slug);

    try {
      await fs.access(dir);
    } catch {
      console.warn(`[republish-all] skipping "${slug}" \u2014 folder missing`);
      continue;
    }

    // Pick the GLB filename. The standard layout is
    // <slug>.glb (written by the publish step), but the very
    // first hand-written folder (jupiter) used a different name.
    // We scan the folder and prefer <slug>.glb when present,
    // otherwise fall back to the first .glb we find.
    const files = await fs.readdir(dir);
    const preferred = `${slug}.glb`;
    let glbFilename: string | null = null;
    if (files.includes(preferred)) {
      glbFilename = preferred;
    } else {
      glbFilename = files.find((f) => f.toLowerCase().endsWith('.glb')) ?? null;
    }
    if (!glbFilename) {
      console.warn(`[republish-all] skipping "${slug}" \u2014 no .glb file`);
      continue;
    }

    const html = renderViewerHtml({ slug, projectName: name, glbFilename });
    await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');
    console.log(`[republish-all] rewrote ${slug}/index.html (glb: ${glbFilename})`);
  }

  // ----- 2) Refresh manifest.json -----
  const manifest = {
    generated_at: new Date().toISOString(),
    models: projects.map((p) => ({
      slug: p.slug as string,
      name: p.name as string,
      approved_at: (p.updated_at as string) ?? null,
    })),
  };
  await fs.writeFile(
    path.join(PUBLIC_OFFICEMATE_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
  console.log('[republish-all] wrote manifest.json');

  console.log('[republish-all] done.');
}

main().catch((err) => {
  console.error('[republish-all] fatal:', err);
  process.exit(1);
});
