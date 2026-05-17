// ============================================================
// Delete ALL projects (jobs) from the database — fresh start
// ============================================================

import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function main() {
  const { supabase } = await import('../lib/supabase');

  console.log('Deleting all feedback images...');
  const { error: fbErr } = await supabase()
    .from('uflow_feedback_images')
    .delete()
    .not('id', 'is', null);
  if (fbErr) console.warn('feedback_images:', fbErr.message);

  console.log('Deleting all client feedback images...');
  const { error: cfErr } = await supabase()
    .from('uflow_client_feedback_images')
    .delete()
    .not('id', 'is', null);
  if (cfErr) console.warn('client_feedback_images:', cfErr.message);

  console.log('Deleting all project references...');
  const { error: refErr } = await supabase()
    .from('uflow_project_references')
    .delete()
    .not('id', 'is', null);
  if (refErr) console.warn('project_references:', refErr.message);

  console.log('Deleting all projects...');
  const { error: projErr, count } = await supabase()
    .from('uflow_projects')
    .delete()
    .not('id', 'is', null);
  if (projErr) {
    console.error('ERROR deleting projects:', projErr.message);
    return;
  }

  console.log(`✅ Done! All jobs/projects deleted (${count ?? 'all'} rows removed).`);
}

main().catch(console.error);
