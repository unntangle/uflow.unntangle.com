// ============================================================
// Prune old artist-upload ROUNDS in Cloudflare R2
// ============================================================
// Goal: keep ONLY the latest upload round (the highest rev-N
// folder under each project's uploads/ tree) and delete every
// older round's files, to reclaim storage.
//
// ------------------------------------------------------------
// HARD SAFETY RULE
// ------------------------------------------------------------
// This script NEVER touches anything that isn't directly under
//   <client>/<project>/uploads/
// Deletion candidates are built from an ALLOWLIST (uploads only),
// NOT a denylist, so any folder type we don't recognise is kept.
// That makes it structurally incapable of deleting:
//   - IQA feedback images    →  <client>/<project>/feedback/…
//   - EQA / client feedback  →  <client>/<project>/client-feedback/…
//   - reference images       →  <client>/<project>/references/…
//   - approved public GLBs   →  <client>/<project>/approved/…
//
// ------------------------------------------------------------
// What "latest round" means
// ------------------------------------------------------------
// Uploads are laid out as  <client>/<project>/uploads/rev-N/…
// where N is the rejection-round number (see lib/r2.ts). The
// latest round = the highest rev-N folder that actually contains
// upload files. Everything in that folder is kept; every lower
// rev-N folder is deleted.
//
// ------------------------------------------------------------
// Usage
// ------------------------------------------------------------
// DRY RUN (default — lists what WOULD be deleted, deletes nothing):
//   npx tsx app/scripts/prune-old-upload-rounds.ts
//
// Apply for real:
//   npx tsx app/scripts/prune-old-upload-rounds.ts --apply
//
// Optional flags:
//   --client=<slug>    limit to one client
//   --project=<slug>   limit to one project (combine with --client)
//   --collapse-glb     also, WITHIN the kept latest round, delete
//                      superseded cache-busted GLBs (Name_1.glb,
//                      Name_2.glb…), keeping only the highest _N
//                      per model. Off by default.
//
// ALWAYS dry-run first and read the summary before --apply.
// ============================================================

import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

// ----- CLI args -----
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const COLLAPSE_GLB = argv.includes('--collapse-glb');

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const clientFilter = flagValue('client');
const projectFilter = flagValue('project');

// Parsed view of a single R2 object key.
type Parsed = {
  key: string;
  clientSlug: string;
  projectSlug: string;
  root: string; // "<client>/<project>"
  category: string; // uploads | feedback | client-feedback | references | approved | …
  rev: number | null; // parsed from rev-N under uploads/, else null
};

function parseKey(key: string): Parsed | null {
  const parts = key.split('/');
  // Need at least <client>/<project>/<category>/…
  if (parts.length < 3) return null;
  const clientSlug = parts[0];
  const projectSlug = parts[1];
  const category = parts[2];
  let rev: number | null = null;
  if (category === 'uploads' && parts.length >= 4) {
    const m = parts[3].match(/^rev-(\d+)$/);
    rev = m ? parseInt(m[1], 10) : null;
  }
  return {
    key,
    clientSlug,
    projectSlug,
    root: `${clientSlug}/${projectSlug}`,
    category,
    rev,
  };
}

// Extract the cache-bust sequence from a glb key (…/Name_3.glb → 3).
function glbSeq(key: string): number | null {
  const m = key.match(/_(\d+)\.glb$/i);
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  const { listKeysByPrefix, deleteKeys, bucketName } = await import('../lib/r2');

  // Narrowest listing prefix the filters allow (saves API calls).
  let listPrefix = '';
  if (clientFilter && projectFilter) {
    listPrefix = `${clientFilter}/${projectFilter}/uploads/`;
  } else if (clientFilter) {
    listPrefix = `${clientFilter}/`;
  }

  console.log('============================================================');
  console.log(' Prune old artist-upload rounds in R2');
  console.log('============================================================');
  console.log(`Bucket:        ${bucketName()}`);
  console.log(
    `Mode:          ${APPLY ? 'APPLY (will delete)' : 'DRY RUN (no deletions)'}`
  );
  console.log(
    `Collapse GLBs: ${COLLAPSE_GLB ? 'yes (within kept round)' : 'no'}`
  );
  console.log(`List prefix:   ${listPrefix || '(whole bucket)'}`);
  console.log(
    'Protected (never touched): feedback/ (IQA), client-feedback/ (EQA), references/, approved/'
  );
  console.log('------------------------------------------------------------');

  const allKeys = await listKeysByPrefix(listPrefix);
  console.log(`Listed ${allKeys.length} object(s).`);

  // Group ONLY uploads keys by project root. Non-uploads keys are
  // tallied for reporting but are never deletion candidates.
  const uploadsByRoot = new Map<string, Parsed[]>();
  let protectedCount = 0;
  const protectedByCat = new Map<string, number>();

  for (const key of allKeys) {
    const p = parseKey(key);
    if (!p) continue;
    if (clientFilter && p.clientSlug !== clientFilter) continue;
    if (projectFilter && p.projectSlug !== projectFilter) continue;

    if (p.category === 'uploads') {
      const arr = uploadsByRoot.get(p.root) ?? [];
      arr.push(p);
      uploadsByRoot.set(p.root, arr);
    } else {
      protectedCount++;
      protectedByCat.set(
        p.category,
        (protectedByCat.get(p.category) ?? 0) + 1
      );
    }
  }

  console.log(
    `Protected objects preserved: ${protectedCount}` +
      (protectedByCat.size
        ? ` (${[...protectedByCat.entries()]
            .map(([c, n]) => `${c}: ${n}`)
            .join(', ')})`
        : '')
  );
  console.log('------------------------------------------------------------');

  const toDelete: string[] = [];
  let projectsWithSavings = 0;

  const sortedRoots = [...uploadsByRoot.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [root, keys] of sortedRoots) {
    // Latest round = highest rev among parseable keys.
    const revs = keys
      .map((k) => k.rev)
      .filter((r): r is number => r !== null);
    if (revs.length === 0) {
      console.log(`• ${root}: no rev-N folders under uploads/ — skipped.`);
      continue;
    }
    const latest = Math.max(...revs);

    const delForProject: string[] = [];
    let unknown = 0;

    for (const k of keys) {
      if (k.rev === null) {
        // A key directly under uploads/ that isn't uploads/rev-N/… —
        // unknown shape, keep it to be safe.
        unknown++;
        continue;
      }
      if (k.rev !== latest) {
        delForProject.push(k.key); // older round → delete
      }
    }

    // Optional: collapse superseded cache-busted GLBs WITHIN the
    // kept latest round, keeping only the highest _N per model.
    if (COLLAPSE_GLB) {
      const latestGlbKeys = keys.filter(
        (k) => k.rev === latest && /\/glb\/[^/]+\.glb$/i.test(k.key)
      );
      // Group by base name (seq stripped) so a model renamed mid-round
      // doesn't lose its current file.
      const bestByBase = new Map<string, { key: string; seq: number }>();
      for (const k of latestGlbKeys) {
        const s = glbSeq(k.key);
        if (s === null) continue; // unsuffixed → always keep
        const base = k.key.replace(/_(\d+)\.glb$/i, '.glb');
        const cur = bestByBase.get(base);
        if (!cur || s > cur.seq) bestByBase.set(base, { key: k.key, seq: s });
      }
      const keepSet = new Set([...bestByBase.values()].map((v) => v.key));
      for (const k of latestGlbKeys) {
        const s = glbSeq(k.key);
        if (s === null) continue; // keep unsuffixed
        if (!keepSet.has(k.key)) delForProject.push(k.key);
      }
    }

    const keptCount = keys.length - delForProject.length;
    const note = unknown ? ` (+${unknown} non-rev upload object(s) kept)` : '';
    if (delForProject.length > 0) {
      projectsWithSavings++;
      console.log(
        `• ${root}: latest round rev-${latest}. ` +
          `keep ${keptCount}, delete ${delForProject.length}${note}.`
      );
      for (const k of delForProject) console.log(`    - ${k}`);
      toDelete.push(...delForProject);
    } else {
      console.log(
        `• ${root}: latest round rev-${latest}. already clean (${keptCount} kept)${note}.`
      );
    }
  }

  // Defensive de-dup (the two passes shouldn't overlap, but be safe).
  const uniqueToDelete = [...new Set(toDelete)];

  console.log('------------------------------------------------------------');
  console.log(`Projects scanned:        ${uploadsByRoot.size}`);
  console.log(`Projects with old files: ${projectsWithSavings}`);
  console.log(`Objects to delete:       ${uniqueToDelete.length}`);

  if (uniqueToDelete.length === 0) {
    console.log('Nothing to delete. Done.');
    return;
  }

  if (!APPLY) {
    console.log('');
    console.log('DRY RUN — nothing was deleted.');
    console.log('Re-run with --apply to delete the objects listed above.');
    return;
  }

  console.log('');
  console.log(`Deleting ${uniqueToDelete.length} object(s)…`);
  const deleted = await deleteKeys(uniqueToDelete);
  console.log(`✅ Deleted ${deleted} object(s).`);
}

main().catch((err) => {
  console.error('[prune-old-upload-rounds] fatal:', err);
  process.exit(1);
});
