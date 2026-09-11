// ============================================================
// promote-to-iqa — push jobs back into the IQA queue, pointed
// at the newest GLB that actually exists in R2
// ============================================================
// WHY THIS EXISTS (and why set-project-status.ts wasn't enough)
// ------------------------------------------------------------
// set-project-status.ts flips `status` and nothing else. That's
// correct for a plain correction ("pull this approved job back
// to WIP"), but it can't fix the case this script is for:
//
//   The artist re-uploaded, the zip + extracted GLB landed in
//   R2, but the row never flipped to qa_pending — so the job is
//   stranded in IQA Rejected and `glb_url` may still point at
//   the PREVIOUS upload's file.
//
// Flipping the status alone would put the job in front of the
// reviewer showing the old model. So this script does both:
// finds the newest GLB in the bucket, and moves the row to
// qa_pending pointing at it.
//
// ------------------------------------------------------------
// SAFETY
// ------------------------------------------------------------
//   - DRY RUN by default. Prints the exact before/after for
//     every row and writes nothing. Pass --apply to commit.
//   - Read-only against R2. This script never deletes or
//     uploads a single object; it only LISTs to find the
//     newest key.
//   - Refuses to guess. If a revision folder contains GLBs for
//     more than one model and none matches the current
//     glb_url's basename, the job is SKIPPED with a warning
//     rather than picking one at random.
//   - Never advances revision_count. That counter is owned by
//     the rejection path (POST /feedback); a re-review of the
//     same revision must not bump it.
//   - Never touches approved_glb_url, assigned_to, feedback
//     images, or the published viewer/manifest.
//
// ------------------------------------------------------------
// USAGE
// ------------------------------------------------------------
// Dry run (default — shows what WOULD change):
//   npx tsx app/scripts/promote-to-iqa.ts scc-leaf-revolving model-50
//
// Commit:
//   npx tsx app/scripts/promote-to-iqa.ts scc-leaf-revolving model-50 --apply
//
// Options:
//   --client=<slug>   client slug (default: officemate)
//   --status-only     move to qa_pending but leave glb_url alone
//   --apply           actually write to the DB
//
// Each line of output ends with the exact revert command.
// ============================================================

import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

// ----- CLI -----
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const STATUS_ONLY = argv.includes('--status-only');

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const clientSlug = flagValue('client') || 'officemate';
const projectSlugs = argv.filter((a) => !a.startsWith('--'));

const TARGET_STATUS = 'qa_pending'; // = the "IQA" tab

// Statuses it makes sense to promote FROM. Anything else is a
// sign the caller has the wrong job, so we stop and ask rather
// than quietly dragging a live row sideways.
const PROMOTABLE_FROM = [
  'iqa_rejected',
  'iqa_wip',
  'eqa_wip',
  'wip',
  'eqa_rejected',
];

// Pull the cache-bust sequence off a GLB key: …/Chair_3.glb → 3
function glbSeq(key: string): number | null {
  const m = key.match(/_(\d+)\.glb$/i);
  return m ? parseInt(m[1], 10) : null;
}

// Basename with the sequence stripped: …/Chair_3.glb → Chair.glb
function glbBase(key: string): string {
  const file = key.split('/').pop() ?? key;
  return file.replace(/_(\d+)\.glb$/i, '.glb');
}

type Candidate = { key: string; rev: number; seq: number | null };

async function main() {
  if (projectSlugs.length === 0) {
    console.error(
      'Usage: npx tsx app/scripts/promote-to-iqa.ts <project-slug> [<project-slug>…] [--client=officemate] [--status-only] [--apply]'
    );
    process.exit(1);
  }

  const { supabase } = await import('../lib/supabase');
  const { listKeysByPrefix, publicUrlFor } = await import('../lib/r2');
  const db = supabase();

  console.log('============================================================');
  console.log(' promote-to-iqa — move jobs into the IQA queue');
  console.log('============================================================');
  console.log(`Mode:     ${APPLY ? 'APPLY (will write to DB)' : 'DRY RUN (no writes)'}`);
  console.log(`Client:   ${clientSlug}`);
  console.log(`Jobs:     ${projectSlugs.join(', ')}`);
  console.log(`GLB:      ${STATUS_ONLY ? 'left untouched (--status-only)' : 'repointed to newest in R2'}`);
  console.log('------------------------------------------------------------');

  // ----- Resolve client -----
  const { data: client, error: cErr } = await db
    .from('uflow_clients')
    .select('id, slug, name')
    .eq('slug', clientSlug)
    .maybeSingle();
  if (cErr) throw new Error(`Client lookup failed: ${cErr.message}`);
  if (!client) throw new Error(`Client "${clientSlug}" not found.`);

  let changed = 0;
  let skipped = 0;

  for (const projectSlug of projectSlugs) {
    console.log('');

    // ----- Resolve project -----
    const { data: project, error: pErr } = await db
      .from('uflow_projects')
      .select('id, slug, name, status, revision_count, glb_url, approved_glb_url')
      .eq('client_id', client.id)
      .eq('slug', projectSlug)
      .maybeSingle();

    if (pErr) throw new Error(`Project lookup failed: ${pErr.message}`);
    if (!project) {
      console.log(`✗ ${projectSlug}: not found under "${clientSlug}" — skipped.`);
      skipped++;
      continue;
    }

    console.log(`• ${project.name}  (${clientSlug}/${project.slug})`);
    console.log(`    status now:   ${project.status}`);
    console.log(`    revision:     ${project.revision_count}`);
    console.log(`    glb_url now:  ${project.glb_url ?? '(none)'}`);

    if (project.status === 'approved') {
      console.log('    ⚠ SKIPPED — job is approved. Pull it back deliberately');
      console.log('      with set-project-status.ts if that is really intended.');
      skipped++;
      continue;
    }
    if (!PROMOTABLE_FROM.includes(project.status)) {
      console.log(
        `    ⚠ SKIPPED — status "${project.status}" is not one this script`
      );
      console.log(`      promotes from (${PROMOTABLE_FROM.join(', ')}).`);
      skipped++;
      continue;
    }

    // ----- Find the newest GLB in R2 -----
    let newGlbUrl: string | null = null;

    if (!STATUS_ONLY) {
      const prefix = `${clientSlug}/${project.slug}/uploads/`;
      const keys = await listKeysByPrefix(prefix);

      const candidates: Candidate[] = [];
      for (const key of keys) {
        // <client>/<project>/uploads/rev-N/glb/<file>.glb
        const parts = key.split('/');
        if (parts.length < 6) continue;
        const m = parts[3].match(/^rev-(\d+)$/);
        if (!m) continue;
        if (parts[4] !== 'glb') continue;
        if (!/\.glb$/i.test(key)) continue;
        candidates.push({ key, rev: parseInt(m[1], 10), seq: glbSeq(key) });
      }

      if (candidates.length === 0) {
        console.log(`    ⚠ SKIPPED — no GLB found under ${prefix}`);
        console.log('      Nothing to point IQA at. Re-run the artist upload,');
        console.log('      or pass --status-only if that is intentional.');
        skipped++;
        continue;
      }

      const latestRev = Math.max(...candidates.map((c) => c.rev));
      const inRound = candidates.filter((c) => c.rev === latestRev);

      // More than one model in the round? Prefer the one whose
      // basename matches the current glb_url. Refuse to guess if
      // there's no match.
      const bases = [...new Set(inRound.map((c) => glbBase(c.key)))];
      let pool = inRound;
      if (bases.length > 1) {
        const currentBase = project.glb_url ? glbBase(project.glb_url) : null;
        const matched = currentBase
          ? inRound.filter((c) => glbBase(c.key) === currentBase)
          : [];
        if (matched.length === 0) {
          console.log(
            `    ⚠ SKIPPED — rev-${latestRev} holds ${bases.length} different models:`
          );
          for (const b of bases) console.log(`        ${b}`);
          console.log('      None matches the current glb_url, so this script will');
          console.log('      not pick one. Set it by hand in Supabase.');
          skipped++;
          continue;
        }
        pool = matched;
      }

      // Highest cache-bust sequence wins; unsuffixed sorts lowest.
      pool.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const winner = pool[pool.length - 1];
      newGlbUrl = publicUrlFor(winner.key);

      console.log(`    latest round: rev-${latestRev}`);
      console.log(`    glb_url new:  ${newGlbUrl}`);

      if (newGlbUrl === project.glb_url) {
        console.log('    (glb_url already current — only the status moves)');
      }
    }

    const noStatusChange = project.status === TARGET_STATUS;
    const noGlbChange = STATUS_ONLY || newGlbUrl === project.glb_url;
    if (noStatusChange && noGlbChange) {
      console.log('    Nothing to change.');
      continue;
    }

    console.log(
      `    → ${project.status} → ${TARGET_STATUS}` +
        (noGlbChange ? '' : ' + glb_url repointed')
    );

    if (!APPLY) {
      changed++;
      continue;
    }

    const patch: Record<string, unknown> = {
      status: TARGET_STATUS,
      updated_at: new Date().toISOString(),
    };
    if (!noGlbChange && newGlbUrl) patch.glb_url = newGlbUrl;

    const { error: uErr } = await db
      .from('uflow_projects')
      .update(patch)
      .eq('id', project.id);
    if (uErr) throw new Error(`Update failed for ${project.slug}: ${uErr.message}`);

    changed++;
    console.log('    ✓ written.');
    console.log(
      `    revert status: npx tsx app/scripts/set-project-status.ts ${project.slug} ${project.status} ${clientSlug}`
    );
    if (!noGlbChange) {
      console.log(`    previous glb_url (keep this): ${project.glb_url ?? '(none)'}`);
    }
  }

  console.log('');
  console.log('------------------------------------------------------------');
  console.log(`Jobs to change: ${changed}`);
  console.log(`Jobs skipped:   ${skipped}`);
  if (!APPLY && changed > 0) {
    console.log('');
    console.log('DRY RUN — nothing was written.');
    console.log('Re-run with --apply to commit.');
  }
}

main().catch((err) => {
  console.error('\n✗ promote-to-iqa failed:', err?.message ?? err);
  process.exit(1);
});
