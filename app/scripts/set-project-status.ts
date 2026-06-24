// ============================================================
// One-off operational script: set a project's status
// ------------------------------------------------------------
// Changes a single project's `status` field in uflow_projects.
// Used for manual corrections from the admin side (e.g. pulling
// an approved job back to artist WIP).
//
// Run (from the project root):
//   npx tsx app/scripts/set-project-status.ts <project-slug> <status> [client-slug]
//
// Examples:
//   npx tsx app/scripts/set-project-status.ts zen-pro wip
//   npx tsx app/scripts/set-project-status.ts zen-pro wip officemate
//
// Valid statuses:
//   draft, qa_pending, iqa_rejected, eqa_rejected,
//   wip, iqa_wip, eqa_wip, client_review, approved
//
// "artist WIP" = the plain `wip` status (fresh artist work). The
// iqa_wip / eqa_wip flavours are for work resuming after an IQA
// or EQA rejection respectively.
//
// SCOPE: this ONLY changes the status field (and updated_at). It
// does NOT touch assigned_to, glb_url, approved_glb_url, or the
// published public viewer page / manifest. Pulling an 'approved'
// job back to 'wip' removes it from the admin Approved tab and
// stops /api/public/model serving it (that filters on
// status='approved'), but any already-published static viewer
// folder + manifest entry remain until republish-all is re-run.
// ============================================================

import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

const VALID_STATUSES = [
  'draft',
  'qa_pending',
  'iqa_rejected',
  'eqa_rejected',
  'wip',
  'iqa_wip',
  'eqa_wip',
  'client_review',
  'approved',
] as const;

async function main() {
  const projectSlug = process.argv[2];
  const status = process.argv[3];
  const clientSlug = process.argv[4] || 'officemate';

  if (!projectSlug || !status) {
    console.error(
      'Usage: npx tsx app/scripts/set-project-status.ts <project-slug> <status> [client-slug]'
    );
    process.exit(1);
  }
  if (!(VALID_STATUSES as readonly string[]).includes(status)) {
    console.error(
      `\u2717 Invalid status "${status}".\n  Valid: ${VALID_STATUSES.join(', ')}`
    );
    process.exit(1);
  }

  const { supabase } = await import('../lib/supabase');
  const db = supabase();

  // ----- Resolve client -----
  const { data: client, error: cErr } = await db
    .from('uflow_clients')
    .select('id, slug, name')
    .eq('slug', clientSlug)
    .maybeSingle();
  if (cErr) throw new Error(`Client lookup failed: ${cErr.message}`);
  if (!client) throw new Error(`Client "${clientSlug}" not found.`);

  // ----- Resolve project -----
  const { data: project, error: pErr } = await db
    .from('uflow_projects')
    .select('id, slug, name, status')
    .eq('client_id', client.id)
    .eq('slug', projectSlug)
    .maybeSingle();
  if (pErr) throw new Error(`Project lookup failed: ${pErr.message}`);
  if (!project) {
    throw new Error(`Project "${projectSlug}" not found for "${clientSlug}".`);
  }

  if (project.status === status) {
    console.log(
      `\u2022 "${project.name}" is already "${status}". Nothing to change.`
    );
    return;
  }

  console.log(
    `\u2022 "${project.name}" (${clientSlug}/${projectSlug}): "${project.status}" \u2192 "${status}"`
  );

  // ----- Update -----
  const { error: uErr } = await db
    .from('uflow_projects')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', project.id);
  if (uErr) throw new Error(`Update failed: ${uErr.message}`);

  console.log(
    `\n\u2713 Done.\n` +
      `  To revert: npx tsx app/scripts/set-project-status.ts ${projectSlug} ${project.status} ${clientSlug}`
  );
}

main().catch((err) => {
  console.error('\n\u2717 Script failed:', err.message ?? err);
  process.exit(1);
});
