// ============================================================
// One-off operational script
// ------------------------------------------------------------
// Goal:
//   1. Upload a new Jupiter GLB to R2 (the artist's latest asset).
//   2. Ensure a 3D artist named "Arjun" exists and is assigned
//      to the Jupiter project (so the ARTIST column in the admin
//      dashboard reads "Arjun").
//   3. Move the Jupiter project into the 'client_review' status
//      so it shows up in the CLIENT dashboard's EQA (review) tab.
//
// What it intentionally does NOT do:
//   - It does not approve/publish the model. 'client_review' is
//     the state where the model is waiting on the client's
//     sign-off; the public OfficeMate viewer only serves
//     'approved' models, so nothing goes live until the client
//     approves it from /client/qa/[id].
//
// Run with (from the project root):
//   npx tsx app/scripts/set-jupiter-client-review.ts "C:\\path\\to\\jupiter_latest.glb"
//
// If you omit the path, the script looks for ./jupiter_latest.glb
// in the project root.
//
// Safe to re-run: re-running just re-uploads the GLB to the same
// rev folder and re-applies the same status/assignment.
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

const ARTIST_NAME = 'Arjun';
const CLIENT_SLUG = 'officemate';
const PROJECT_SLUG = 'jupiter';

async function main() {
  // Lazy-import after dotenv so env vars are populated first.
  const { supabase } = await import('../lib/supabase');
  const { uploadBuffer, uploadKey, publicUrlFor } = await import('../lib/r2');

  const db = supabase();

  // ---------------------------------------------------------
  // 0. Resolve and read the GLB from disk.
  // ---------------------------------------------------------
  const argPath = process.argv[2];
  const glbPath = argPath
    ? path.resolve(argPath)
    : path.join(process.cwd(), 'jupiter_latest.glb');

  let glbBuffer: Buffer;
  try {
    glbBuffer = await fs.readFile(glbPath);
  } catch {
    console.error(
      `\n✗ Could not read GLB at: ${glbPath}\n` +
        `  Pass the path explicitly, e.g.:\n` +
        `  npx tsx app/scripts/set-jupiter-client-review.ts "C:\\\\Users\\\\you\\\\Downloads\\\\jupiter_latest.glb"\n`
    );
    process.exit(1);
  }
  console.log(`• Read GLB (${(glbBuffer.length / 1_048_576).toFixed(1)} MB) from ${glbPath}`);

  // ---------------------------------------------------------
  // 1. Locate the client + project rows.
  // ---------------------------------------------------------
  const { data: client, error: cErr } = await db
    .from('uflow_clients')
    .select('id, slug, name')
    .eq('slug', CLIENT_SLUG)
    .maybeSingle();
  if (cErr) throw new Error(`Client lookup failed: ${cErr.message}`);
  if (!client) throw new Error(`Client "${CLIENT_SLUG}" not found.`);

  const { data: project, error: pErr } = await db
    .from('uflow_projects')
    .select('id, slug, name, status, revision_count, client_id')
    .eq('client_id', client.id)
    .eq('slug', PROJECT_SLUG)
    .maybeSingle();
  if (pErr) throw new Error(`Project lookup failed: ${pErr.message}`);
  if (!project) throw new Error(`Project "${PROJECT_SLUG}" not found for ${CLIENT_SLUG}.`);
  console.log(`• Found project "${project.name}" (status: ${project.status})`);

  // ---------------------------------------------------------
  // 2. Ensure a 3D artist named "Arjun" exists.
  //    The ARTIST column in the admin dashboard renders
  //    assignee.name, so the project must be assigned to a user
  //    whose name is "Arjun".
  // ---------------------------------------------------------
  let { data: arjun, error: aErr } = await db
    .from('uflow_users')
    .select('id, name, email, role')
    .eq('role', '3d_artist')
    .ilike('name', ARTIST_NAME)
    .maybeSingle();
  if (aErr) throw new Error(`Artist lookup failed: ${aErr.message}`);

  if (!arjun) {
    // Create a minimal artist account. password_hash is required
    // (NOT NULL) — we set a bcrypt hash of a random throwaway so
    // the row is valid; reset it from the admin UI / reset-password
    // script before anyone logs in as this user.
    const bcrypt = await import('bcryptjs');
    const hash = bcrypt.hashSync(
      'change-me-' + Math.random().toString(36).slice(2),
      10
    );
    const { data: created, error: insErr } = await db
      .from('uflow_users')
      .insert({
        name: ARTIST_NAME,
        email: 'arjun@unntangle.com',
        password_hash: hash,
        role: '3d_artist',
      })
      .select('id, name, email, role')
      .single();
    if (insErr) throw new Error(`Could not create artist: ${insErr.message}`);
    arjun = created;
    console.log(`• Created 3D artist "${arjun.name}" (${arjun.email})`);
  } else {
    console.log(`• Using existing 3D artist "${arjun.name}" (${arjun.email})`);
  }

  // ---------------------------------------------------------
  // 3. Upload the GLB to R2 under the standard upload layout.
  //    We bump to a fresh rev folder based on revision_count + 1
  //    so we never overwrite a previous revision's asset.
  // ---------------------------------------------------------
  const rev = (project.revision_count ?? 0) + 1;
  const key = uploadKey(CLIENT_SLUG, PROJECT_SLUG, rev, 'glb/Jupiter.glb');
  await uploadBuffer({
    key,
    body: glbBuffer,
    contentType: 'model/gltf-binary',
  });
  const glbUrl = publicUrlFor(key);
  console.log(`• Uploaded GLB to R2: ${glbUrl}`);

  // ---------------------------------------------------------
  // 4. Flip the project to 'client_review', assign Arjun, and
  //    point glb_url at the freshly uploaded asset. The client
  //    dashboard buckets status='client_review' into its EQA
  //    (review) tab and renders "View GLB" from glb_url.
  // ---------------------------------------------------------
  const { error: uErr } = await db
    .from('uflow_projects')
    .update({
      status: 'client_review',
      assigned_to: arjun.id,
      glb_url: glbUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', project.id);
  if (uErr) throw new Error(`Project update failed: ${uErr.message}`);

  console.log(
    `\n✓ Done.\n` +
      `  • Project "${project.name}" → status "client_review"\n` +
      `  • Artist (assignee) → "${arjun.name}"\n` +
      `  • glb_url → ${glbUrl}\n\n` +
      `  It now appears in the CLIENT dashboard's EQA tab awaiting\n` +
      `  the client's sign-off, with Arjun shown as the artist in\n` +
      `  the admin dashboard.\n`
  );
}

main().catch((err) => {
  console.error('\n✗ Script failed:', err.message ?? err);
  process.exit(1);
});
