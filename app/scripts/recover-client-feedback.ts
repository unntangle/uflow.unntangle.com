// ============================================================
// Recovery script: re-attach orphaned client (EQA) feedback
// ------------------------------------------------------------
// WHAT WENT WRONG
// /api/projects/[id]/client-feedback-sign mints presigned R2 PUT
// URLs, and the browser uploads immediately. The decision is only
// posted to /api/projects/[id]/client-review afterwards. So any
// guard that lived ONLY in client-review ran too late: the files
// were already in the bucket when it returned 400, and because no
// uflow_client_feedback_images rows were written, the screenshots
// became unreachable from every dashboard at once.
//
// The classic trigger: the client review page opens on the stale
// uflow_projects.status column, falls back to the product row as
// the review target, and that row has a null glb_url (uploads
// wrote glb_url onto the colourway after the 2026-08-06 variants
// migration). Sign passes, upload succeeds, client-review then
// refuses with "has no GLB to review".
//
// Both holes are now closed in the app. This script recovers the
// files that were lost before that.
//
// ------------------------------------------------------------
// WHAT IT DOES
//   1. Lists every object under the project's client-feedback/
//      prefix in R2 (including any OLD slug prefixes you name).
//   2. Diffs that against uflow_client_feedback_images.image_url
//      for the project.
//   3. Inserts a row for each orphan, tagged with the rev-N
//      folder it was filed under.
//   4. Optionally moves the job to 'eqa_rejected' and sets
//      revision_count to the highest recovered round, so it
//      reappears in the artist's EQA Rejected inbox, admin's EQA
//      Rejected tab, and the client's EQA Rejected tab.
//
// DRY RUN BY DEFAULT. Nothing is written without --apply.
//
// ------------------------------------------------------------
// SLUGS MATTER
// 2026-08-29_regenerate_slugs_from_names.sql renamed projects but
// deliberately did NOT move existing R2 objects. So files uploaded
// before that migration sit under the OLD prefix. Pass it with
// --old-slug so the scan finds them:
//
//   --old-slug=sync-workstation-4-seater---paria-oak
//
// (note the triple hyphen the old slugifier produced)
//
// ------------------------------------------------------------
// USAGE
//   npx tsx app/scripts/recover-client-feedback.ts <project-slug> [options]
//
// Options:
//   --client=<slug>       client brand slug        (default: officemate)
//   --old-slug=<slug>     extra R2 prefix to scan  (repeatable)
//   --as=<email>          stamp uploaded_by with this user's id
//   --set-rejected        also move the job back to 'eqa_rejected'
//   --apply               actually write (otherwise dry run)
//
// Examples:
//   # 1. Look first. Writes nothing.
//   npx tsx app/scripts/recover-client-feedback.ts \
//     sync-workstation-4-seater-paria-oak \
//     --old-slug=sync-workstation-4-seater---paria-oak
//
//   # 2. Recover the images and put the job back in the queue.
//   npx tsx app/scripts/recover-client-feedback.ts \
//     sync-workstation-4-seater-paria-oak \
//     --old-slug=sync-workstation-4-seater---paria-oak \
//     --as=client@officemate.com --set-rejected --apply
// ============================================================

import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

type Args = {
  projectSlug: string;
  clientSlug: string;
  oldSlugs: string[];
  asEmail: string | null;
  setRejected: boolean;
  apply: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  return {
    projectSlug: positional[0] ?? '',
    clientSlug: flag('client') ?? 'officemate',
    // Repeatable — collect every occurrence, not just the first.
    oldSlugs: argv
      .filter((a) => a.startsWith('--old-slug='))
      .map((a) => a.slice('--old-slug='.length))
      .filter(Boolean),
    asEmail: flag('as'),
    setRejected: argv.includes('--set-rejected'),
    apply: argv.includes('--apply'),
  };
}

// Pull the revision number out of a client-feedback key.
// "officemate/foo/client-feedback/rev-3/uuid.png" -> 3
// Returns null for anything that doesn't sit in a rev-N folder,
// so a stray object can't be inserted with a nonsense round.
function revisionOf(key: string): number | null {
  const m = key.match(/\/client-feedback\/rev-(\d+)\//);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const args = parseArgs();

  if (!args.projectSlug) {
    console.error(
      'Usage: npx tsx app/scripts/recover-client-feedback.ts <project-slug> ' +
        '[--client=slug] [--old-slug=slug]... [--as=email] [--set-rejected] [--apply]'
    );
    process.exit(1);
  }

  const { supabase } = await import('../lib/supabase');
  const { listKeysByPrefix, publicUrlFor } = await import('../lib/r2');
  const db = supabase();

  // ----- Resolve client -----
  const { data: client, error: cErr } = await db
    .from('uflow_clients')
    .select('id, slug, name')
    .eq('slug', args.clientSlug)
    .maybeSingle();
  if (cErr) throw new Error(`Client lookup failed: ${cErr.message}`);
  if (!client) throw new Error(`Client "${args.clientSlug}" not found.`);

  // ----- Resolve project -----
  const { data: project, error: pErr } = await db
    .from('uflow_projects')
    .select('id, slug, name, status, revision_count, glb_url')
    .eq('client_id', client.id)
    .eq('slug', args.projectSlug)
    .maybeSingle();
  if (pErr) throw new Error(`Project lookup failed: ${pErr.message}`);
  if (!project) {
    throw new Error(
      `Project "${args.projectSlug}" not found for client "${args.clientSlug}".`
    );
  }

  console.log(`\nProject : ${project.name}  (${project.slug})`);
  console.log(`Client  : ${client.name}`);
  console.log(`Status  : ${project.status}   revision_count=${project.revision_count}`);
  console.log(args.apply ? 'Mode    : APPLY (will write)\n' : 'Mode    : DRY RUN (no writes)\n');

  // ----- Resolve the uploader, if one was named -----
  let uploadedBy: string | null = null;
  if (args.asEmail) {
    const { data: u, error: uErr } = await db
      .from('uflow_users')
      .select('id, email, role')
      .eq('email', args.asEmail)
      .maybeSingle();
    if (uErr) throw new Error(`User lookup failed: ${uErr.message}`);
    if (!u) throw new Error(`User "${args.asEmail}" not found.`);
    uploadedBy = u.id as string;
    console.log(`uploaded_by will be stamped as ${u.email} (${u.role})`);
  } else {
    console.log(
      'No --as given: uploaded_by will be left null (the column is nullable).'
    );
  }

  // ----- Scan R2 -----
  // Current slug first, then any old prefixes. Deduped because a
  // caller may pass the current slug as an --old-slug by mistake.
  const slugsToScan = Array.from(
    new Set([project.slug as string, ...args.oldSlugs])
  );

  const found: { key: string; url: string; revision: number }[] = [];
  for (const slug of slugsToScan) {
    const prefix = `${client.slug}/${slug}/client-feedback/`;
    const keys = await listKeysByPrefix(prefix);
    const usable = keys
      .map((key) => ({ key, revision: revisionOf(key) }))
      .filter((k): k is { key: string; revision: number } => k.revision !== null)
      .map(({ key, revision }) => ({ key, revision, url: publicUrlFor(key) }));

    console.log(
      `  ${prefix}  ->  ${keys.length} object(s), ${usable.length} in a rev-N folder`
    );
    found.push(...usable);
  }

  if (found.length === 0) {
    console.log(
      '\nNothing found under any scanned prefix. If the files were uploaded ' +
        'before the 2026-08-29 slug rename, pass the old slug with --old-slug.'
    );
    return;
  }

  // ----- Diff against what the DB already knows -----
  const { data: existing, error: eErr } = await db
    .from('uflow_client_feedback_images')
    .select('image_url')
    .eq('project_id', project.id);
  if (eErr) throw new Error(`Feedback lookup failed: ${eErr.message}`);

  const known = new Set((existing ?? []).map((r) => r.image_url as string));
  const orphans = found.filter((f) => !known.has(f.url));

  console.log(
    `\nIn R2: ${found.length}   already in DB: ${found.length - orphans.length}   ORPHANED: ${orphans.length}`
  );

  if (orphans.length === 0) {
    console.log('Nothing to recover — every uploaded image already has a row.');
    return;
  }

  // Group for a readable summary.
  const byRevision = new Map<number, typeof orphans>();
  for (const o of orphans) {
    const list = byRevision.get(o.revision) ?? [];
    list.push(o);
    byRevision.set(o.revision, list);
  }
  const rounds = [...byRevision.keys()].sort((a, b) => a - b);
  for (const r of rounds) {
    console.log(`  revision ${r}: ${byRevision.get(r)!.length} image(s)`);
  }

  const highestRound = rounds[rounds.length - 1];

  if (!args.apply) {
    console.log(
      `\nDry run. Re-run with --apply to insert ${orphans.length} row(s)` +
        (args.setRejected
          ? ` and move the job to 'eqa_rejected' with revision_count=${highestRound}.`
          : '. Add --set-rejected to also put the job back in the EQA Rejected queue.')
    );
    return;
  }

  // ----- Insert -----
  // variant_id is null: uflow_project_variants was emptied by
  // 2026-08-29_promote_variants_to_child_jobs.sql, so every job is
  // its own row and feedback hangs directly off project_id.
  const rows = orphans.map((o) => ({
    project_id: project.id,
    variant_id: null,
    revision_number: o.revision,
    image_url: o.url,
    uploaded_by: uploadedBy,
  }));

  const { error: iErr } = await db
    .from('uflow_client_feedback_images')
    .insert(rows);
  if (iErr) throw new Error(`Insert failed: ${iErr.message}`);
  console.log(`\n\u2713 Inserted ${rows.length} feedback row(s).`);

  // ----- Put the job back in the queue -----
  // revision_count is what every "Revision Round" link filters on,
  // so it has to reach the recovered round or the gallery opens on
  // an empty filter. feedback_seen_revision is pulled back one
  // round below it so the row counts as UNREAD and lands in the
  // artist's EQA Rejected inbox rather than sitting silently in
  // WIP.
  if (args.setRejected) {
    const { error: sErr } = await db
      .from('uflow_projects')
      .update({
        status: 'eqa_rejected',
        revision_count: Math.max(project.revision_count as number, highestRound),
        feedback_seen_revision: Math.max(0, highestRound - 1),
        updated_at: new Date().toISOString(),
      })
      .eq('id', project.id);
    if (sErr) throw new Error(`Status update failed: ${sErr.message}`);
    console.log(
      `\u2713 "${project.name}": ${project.status} \u2192 eqa_rejected, revision_count=${highestRound}.`
    );
    console.log(
      `  To revert: npx tsx app/scripts/set-project-status.ts ${project.slug} ${project.status} ${client.slug}`
    );
  } else {
    console.log(
      '\nStatus left untouched. The images are now visible in the feedback ' +
        'gallery, but the job stays where it is. Add --set-rejected to put it ' +
        "back in the artist's EQA Rejected inbox."
    );
  }
}

main().catch((err) => {
  console.error('\n\u2717 Script failed:', err?.message ?? err);
  process.exit(1);
});
