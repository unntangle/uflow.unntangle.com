// ============================================================
// Publish helper
// ============================================================
// Writes an approved GLB plus its viewer page, brand logo, and
// cross-project manifest to R2 under the `officemate/` prefix.
//
// Layout produced in R2:
//   officemate/<slug>/index.html              (viewer page)
//   officemate/<slug>/<slug>.glb              (the approved 3D model)
//   officemate/<slug>/officemate-logo.webp    (copied from a canonical source)
//   officemate/manifest.json                  (cross-project sidebar feed)
//
// Each publish OVERWRITES the slug folder's files in place so the
// viewer URL is stable across revisions — anyone with the link
// sees the latest approved model on next reload. The viewer HTML
// is rewritten from the template each time so styling fixes
// propagate to old folders too.
//
// IMPORTANT — why this lives on R2 (not the Next.js public folder):
// The previous implementation wrote into `public/officemate/<slug>/`
// using fs.writeFile. That works on long-running Node hosts but
// fails on serverless deploy targets (Vercel, Netlify functions,
// AWS Lambda) where the function root is read-only — the visible
// error is `ENOENT: mkdir '/var/task/public/officemate/<slug>'`.
// R2 is already where the approved GLB lives, has no egress fees,
// and is host-agnostic, so we publish every artifact there now.
// The viewer page references assets via relative URLs so it can
// be served from any host (the raw `pub-*.r2.dev` domain today,
// a custom Cloudflare domain tomorrow) without rewrites.
// ============================================================

import { uploadBuffer, fetchFromUrl, publicUrlFor } from './r2';
import { supabase } from './supabase';
import { renderViewerHtml } from './viewer-template';

// ============================================================
// Layout constants
// ============================================================
// Every published artifact lives under this prefix in the R2
// bucket. We keep it as a single source of truth so renames are
// one-line changes.
const OFFICEMATE_PREFIX = 'officemate';

// The brand logo source. We fetch it from R2 if a previous
// publish already pushed one (so future logo changes only need
// one upload), and otherwise fall back to bundling a copy in
// the deploy artifact. To keep the code dependency-free we just
// reuse whatever jupiter has — every existing approved page
// already has officemate-logo.webp colocated, so this is
// guaranteed to exist once any publish has happened. For the
// first-ever publish we degrade gracefully (the viewer page
// still loads; the loader shows a broken-image icon, which is
// cosmetic).
const LOGO_R2_KEY = `${OFFICEMATE_PREFIX}/_assets/officemate-logo.webp`;

// Public viewer base — what gets written into approved_glb_url.
// Defaults to the R2 public host with `/officemate` prefix. Set
// OFFICEMATE_PUBLIC_BASE in env to override (e.g. when you put
// a custom Cloudflare domain in front of the bucket — point that
// domain at the R2 bucket and set the var to that domain).
function publicBase(): string {
  const fromEnv = process.env.OFFICEMATE_PUBLIC_BASE;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  // Fall through to constructing from R2_PUBLIC_URL. We don't
  // import `env()` from lib/r2 because it's not exported; we
  // read directly and trust the same env var the SDK relies on.
  const r2 = process.env.R2_PUBLIC_URL;
  if (!r2) {
    throw new Error(
      'OFFICEMATE_PUBLIC_BASE (or R2_PUBLIC_URL) must be set so the publish step knows where viewer URLs live.'
    );
  }
  return `${r2.replace(/\/+$/, '')}/${OFFICEMATE_PREFIX}`;
}

export type PublishResult = {
  // R2 key the GLB landed at (logged for debugging).
  glbKey: string;
  // Public URL of the viewer page — written into the project's
  // approved_glb_url so dashboards link to it. R2's raw public
  // host doesn't do directory-index serving, so this URL points
  // at /index.html explicitly rather than at /.
  publicViewerUrl: string;
  // Direct URL of the GLB itself, in case external tools want
  // to fetch the raw asset rather than the wrapper page.
  publicGlbUrl: string;
};

// ============================================================
// publishGlbToPublicFolder
//
// Publishes the GLB + viewer page + logo for one project to R2,
// then refreshes the cross-project manifest. Idempotent —
// re-publishing the same slug overwrites the existing keys.
//
// Parameters:
//   - glbSourceUrl: an R2 public URL pointing at the GLB to
//                   publish. Usually the project's approved/
//                   copy made by the caller just before this
//                   helper runs.
//   - slug:         the project's URL slug — used as both the
//                   subfolder name AND the .glb filename so the
//                   viewer src stays predictable.
//   - projectName:  human-readable name interpolated into the
//                   viewer page's <title> and alt text.
//
// Throws on R2 upload failures. The caller (the approve route)
// catches and surfaces the error message so the user sees what
// went wrong instead of a generic 500.
// ============================================================
export async function publishGlbToPublicFolder(opts: {
  glbSourceUrl: string;
  slug: string;
  projectName: string;
}): Promise<PublishResult> {
  const { glbSourceUrl, slug, projectName } = opts;

  // ---- 1. Fetch the GLB bytes from R2 ----
  // The source URL points at <client>/<slug>/approved/<slug>.glb;
  // we copy it into the public-facing officemate/<slug>/ folder
  // so the viewer page lives next to the file it references.
  const glbBuffer = await fetchFromUrl(glbSourceUrl);

  // ---- 2. Upload the GLB into the published folder ----
  const glbFilename = `${slug}.glb`;
  const glbKey = `${OFFICEMATE_PREFIX}/${slug}/${glbFilename}`;
  await uploadBuffer({
    key: glbKey,
    body: glbBuffer,
    contentType: 'model/gltf-binary',
  });

  // ---- 3. Copy the brand logo into the project folder ----
  // We first try the per-project canonical copy at
  //   officemate/_assets/officemate-logo.webp
  // (this is where the first-ever publish stored it, written
  // alongside the very first model). If that fetch fails we
  // skip the logo silently — the viewer page still renders, the
  // loader just shows a broken-image icon. Cosmetic, not fatal.
  try {
    const logoUrl = publicUrlFor(LOGO_R2_KEY);
    const logoBytes = await fetchFromUrl(logoUrl);
    await uploadBuffer({
      key: `${OFFICEMATE_PREFIX}/${slug}/officemate-logo.webp`,
      body: logoBytes,
      contentType: 'image/webp',
    });
  } catch (err) {
    // First publish ever, or someone moved the canonical asset.
    // Log and continue — see comment above for why this isn't
    // fatal. We don't try to backfill the canonical source here
    // because we don't have a logo buffer in hand; that's a
    // separate one-time admin task.
    console.warn(
      '[publish] could not copy logo into',
      slug,
      '— viewer page will still load.',
      err
    );
  }

  // ---- 4. Render and upload the viewer HTML ----
  // Always rewritten so a styling fix in viewer-template.ts
  // propagates to old folders on the next approval round. The
  // template uses relative URLs so it works wherever R2 is
  // served from (raw pub-*.r2.dev today, custom CDN tomorrow).
  const html = renderViewerHtml({ slug, projectName, glbFilename });
  await uploadBuffer({
    key: `${OFFICEMATE_PREFIX}/${slug}/index.html`,
    body: Buffer.from(html, 'utf8'),
    // Explicit text/html with utf-8 charset so the browser
    // doesn't sniff and pick something stranger.
    contentType: 'text/html; charset=utf-8',
  });

  // ---- 5. Refresh the cross-project manifest ----
  // Every viewer page fetches this file at runtime to render
  // its "Other models" sidebar, so re-writing on every publish
  // means newly-approved projects appear in the sidebar of
  // pre-existing pages on next refresh — no need to rebuild
  // any HTML. We do this AFTER the HTML write so a manifest
  // failure doesn't strand a half-written viewer.
  try {
    await writeManifest();
  } catch (err) {
    // Manifest failure is non-fatal: the viewer page still
    // loads and just shows an empty sidebar.
    console.warn('[publish] could not write manifest:', err);
  }

  // ---- 6. Compose the URLs the caller will store in the DB ----
  // R2's raw `pub-*.r2.dev` host doesn't auto-serve index.html
  // on a `/` request, so the viewer URL must include the
  // filename explicitly. When OFFICEMATE_PUBLIC_BASE is set to
  // a custom domain that's been configured with directory-index
  // rewrites, you can strip `/index.html` from URLs you share
  // externally — but for what we store in the DB we keep the
  // explicit filename so it works regardless.
  const base = publicBase();
  return {
    glbKey,
    publicViewerUrl: `${base}/${slug}/index.html`,
    publicGlbUrl: `${base}/${slug}/${glbFilename}`,
  };
}

// ============================================================
// Manifest of all published models
// ============================================================
// Every viewer page fetches this at runtime to populate the
// sidebar. Lives at <base>/manifest.json so the viewer's vanilla
// JS can request `../manifest.json` relative to its own URL.
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
  // Pull every approved project from the DB. We include only
  // the fields the sidebar needs — don't leak revision counts,
  // brief text, or other internal data into a public manifest.
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
    // because the approve handler stamps it during the transition.
    approved_at: (row.updated_at as string) ?? null,
  }));

  const manifest = {
    generated_at: new Date().toISOString(),
    models,
  };

  await uploadBuffer({
    key: `${OFFICEMATE_PREFIX}/manifest.json`,
    body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    // application/json with charset so the viewer page's
    // `fetch().then(r => r.json())` parses correctly regardless
    // of browser sniffing rules.
    contentType: 'application/json; charset=utf-8',
  });
}
