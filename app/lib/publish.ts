// ============================================================
// Publish helper
// ============================================================
// Writes an approved GLB into the public viewer folder so the
// model becomes browsable at officemate.unntangle.com/<slug>/.
//
// Layout produced on disk:
//   public/officemate/<slug>/
//   \u251c\u2500 index.html              (viewer page; src points at the GLB below)
//   \u251c\u2500 <slug>.glb              (the approved 3D model)
//   \u2514\u2500 officemate-logo.webp    (copied from the brand asset folder)
//
// Each publish OVERWRITES <slug>.glb in place so the viewer URL
// is stable across revisions \u2014 anyone with the link sees the
// latest approved model on next reload. index.html is rewritten
// from the template each time so styling fixes propagate to old
// folders too.
//
// IMPORTANT \u2014 deployment caveat:
// This writes to the local filesystem (Vercel's serverless
// runtime has a read-only deploy bundle, so writes there don't
// persist across requests). Deploy targets that support this:
//   - A long-running Node host (PM2, systemd, Hostinger Node,
//     a VPS, etc.) where the process's working directory is the
//     repo root.
//   - Local dev (next dev) on the maintainer's machine.
// On Vercel / Netlify Edge, the writes succeed inside the
// invocation but disappear on the next deploy. Use a long-running
// host for production publishing.
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchFromUrl } from './r2';
import { supabase } from './supabase';

// Resolve the public folder relative to the Next.js project root.
// process.cwd() is the project root when next dev / next start
// runs (and when route handlers execute), so this is stable.
const PUBLIC_OFFICEMATE_DIR = path.join(
  process.cwd(),
  'public',
  'officemate'
);

// The brand logo lives in the existing jupiter folder \u2014 we use
// it as the canonical source and copy it into every new project
// folder so each viewer page is self-contained.
const LOGO_SOURCE = path.join(
  PUBLIC_OFFICEMATE_DIR,
  'jupiter',
  'officemate-logo.webp'
);

export type PublishResult = {
  // Filesystem location the GLB landed at (logged for debugging).
  glbPath: string;
  // Public URL the viewer page is reachable at \u2014 written into
  // the project's approved_glb_url so dashboards can link to it.
  publicViewerUrl: string;
  // Direct URL of the GLB itself, in case external tools want
  // to fetch the raw asset rather than the wrapper page.
  publicGlbUrl: string;
};

// ============================================================
// publishGlbToPublicFolder
//
// Writes the GLB + viewer page for one project into the public
// folder. Idempotent \u2014 re-publishing the same project overwrites
// the existing files, never creates a parallel folder.
//
// Parameters:
//   - glbSourceUrl: an R2 public URL pointing at the GLB to
//                   publish. Usually the project's glb_url for
//                   the current (just-approved) revision.
//   - slug:         the project's URL slug \u2014 used as both the
//                   folder name under public/officemate/ AND the
//                   .glb filename so the viewer src is stable.
//   - projectName:  human-readable name interpolated into the
//                   viewer page's <title> and alt text.
//
// Throws on filesystem or network failures. The caller (the
// approve route) catches and surfaces the error message so the
// admin sees what went wrong instead of a generic 500.
// ============================================================
export async function publishGlbToPublicFolder(opts: {
  glbSourceUrl: string;
  slug: string;
  projectName: string;
}): Promise<PublishResult> {
  const { glbSourceUrl, slug, projectName } = opts;

  // 1) Ensure the per-project folder exists. `recursive: true`
  //    is essential so the very first publish doesn't fail when
  //    public/officemate/<slug>/ doesn't exist yet, and so a
  //    re-publish on an existing folder is a no-op.
  const projectDir = path.join(PUBLIC_OFFICEMATE_DIR, slug);
  await fs.mkdir(projectDir, { recursive: true });

  // 2) Fetch the GLB bytes from R2. We re-use the same helper
  //    the rejection / approval flows already use, which speaks
  //    presigned-GET via the AWS SDK and falls back to a plain
  //    HTTPS fetch for legacy / external URLs.
  const glbBuffer = await fetchFromUrl(glbSourceUrl);

  // 3) Write the GLB to disk. Filename matches the slug so the
  //    viewer's <model-viewer src> is predictable AND so the
  //    folder reads naturally when you browse it.
  const glbFilename = `${slug}.glb`;
  const glbPath = path.join(projectDir, glbFilename);
  await fs.writeFile(glbPath, glbBuffer);

  // 4) Copy the brand logo into the project folder. Each viewer
  //    page is self-contained, so we never share assets via
  //    a parent path \u2014 it's two extra KB of disk for clarity.
  //    Best-effort: if the logo source is missing (someone
  //    moved it), we still publish the GLB; the viewer page
  //    will show a broken image in the loader, which is a
  //    cosmetic issue, not a blocker.
  try {
    const logoTarget = path.join(projectDir, 'officemate-logo.webp');
    const logoBytes = await fs.readFile(LOGO_SOURCE);
    await fs.writeFile(logoTarget, logoBytes);
  } catch (err) {
    console.warn('[publish] could not copy logo into', projectDir, err);
  }

  // 5) Write the viewer HTML. Always rewritten so a styling fix
  //    in viewer-template.ts propagates to old folders on the
  //    next approval round.
  const { renderViewerHtml } = await import('./viewer-template');
  const html = renderViewerHtml({ slug, projectName, glbFilename });
  await fs.writeFile(path.join(projectDir, 'index.html'), html, 'utf8');

  // 6) Refresh the cross-project manifest. Every viewer page's
  //    sidebar reads this file at runtime to populate the
  //    "Other models" list, so re-writing it on every publish
  //    means newly-approved projects appear in the sidebar of
  //    pre-existing pages on the next refresh — no need to
  //    rebuild any HTML. We do this after the HTML write so a
  //    manifest error doesn't strand a half-written viewer.
  try {
    await writeManifest();
  } catch (err) {
    // Manifest failure is non-fatal: the viewer page still loads
    // and just shows an empty sidebar. Log and continue.
    console.warn('[publish] could not write manifest:', err);
  }

  // 7) Compose the URLs the caller will store in the DB. The
  //    OFFICEMATE_PUBLIC_BASE env var is the front-of-site
  //    origin \u2014 typically https://officemate.unntangle.com in
  //    production and http://localhost:3000/officemate during
  //    local dev (since Next serves /public at the app root,
  //    the officemate subdir sits at /officemate/<slug>/).
  //
  //    Default is the local-dev URL so a missing env var still
  //    produces a working link on a developer's machine.
  const base = (
    process.env.OFFICEMATE_PUBLIC_BASE ??
    'http://localhost:3000/officemate'
  ).replace(/\/+$/, '');

  return {
    glbPath,
    publicViewerUrl: `${base}/${slug}/`,
    publicGlbUrl: `${base}/${slug}/${glbFilename}`,
  };
}

// ============================================================
// Manifest of all published models
// ============================================================
// Every viewer page's sidebar fetches /manifest.json at runtime
// and renders the list, so the sidebar of every page stays in
// sync with the latest publish state — no need to rebuild HTML
// for every existing page when a new model is approved.
//
// Shape (kept simple so the viewer's vanilla JS can render it
// without any framework or build step):
//
//   {
//     "generated_at": "2026-05-16T20:30:00.000Z",
//     "models": [
//       { "slug": "jupiter",  "name": "Jupiter",  "approved_at": "2026-05-15T…" },
//       { "slug": "jupiter2", "name": "Jupiter2", "approved_at": "2026-05-16T…" }
//     ]
//   }
//
// Models are listed in approval order (newest first) so the
// sidebar surfaces what's just shipped.
// ============================================================

type ManifestModel = {
  slug: string;
  name: string;
  approved_at: string | null;
};

async function writeManifest(): Promise<void> {
  // Pull every approved project from the DB. We include only the
  // fields the sidebar needs — don't leak revision counts, brief
  // text, or other internal data into a public manifest.
  const { data, error } = await supabase()
    .from('uflow_projects')
    .select('slug, name, updated_at')
    .eq('status', 'approved')
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  const models: ManifestModel[] = (data ?? []).map((row) => ({
    slug: row.slug as string,
    name: row.name as string,
    // updated_at on an approved row is the approval timestamp
    // since the approve handler stamps it during the transition.
    approved_at: (row.updated_at as string) ?? null,
  }));

  const manifest = {
    generated_at: new Date().toISOString(),
    models,
  };

  const manifestPath = path.join(PUBLIC_OFFICEMATE_DIR, 'manifest.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
}
