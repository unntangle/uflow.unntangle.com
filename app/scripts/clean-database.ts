// ============================================================
// Clean Database: Delete all test and existing jobs (projects)
// to start fresh for going live.
//
// Run with:  npx tsx app/scripts/clean-database.ts
// ============================================================

import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import path from 'node:path';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_OFFICEMATE_DIR = path.join(ROOT, 'public', 'officemate');

async function main() {
  const { supabase } = await import('../lib/supabase');

  console.log('[clean-database] Starting database cleanup...');

  // 1. Delete all client feedback images
  console.log('[clean-database] Deleting from uflow_client_feedback_images...');
  const { error: errClientFeedback } = await supabase()
    .from('uflow_client_feedback_images')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows
  if (errClientFeedback) {
    console.error('[clean-database] Error deleting uflow_client_feedback_images:', errClientFeedback);
  }

  // 2. Delete all feedback images
  console.log('[clean-database] Deleting from uflow_feedback_images...');
  const { error: errFeedback } = await supabase()
    .from('uflow_feedback_images')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (errFeedback) {
    console.error('[clean-database] Error deleting uflow_feedback_images:', errFeedback);
  }

  // 3. Delete all project references
  console.log('[clean-database] Deleting from uflow_project_references...');
  const { error: errReferences } = await supabase()
    .from('uflow_project_references')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (errReferences) {
    console.error('[clean-database] Error deleting uflow_project_references:', errReferences);
  }

  // 4. Delete all projects (jobs)
  console.log('[clean-database] Deleting from uflow_projects...');
  const { error: errProjects } = await supabase()
    .from('uflow_projects')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (errProjects) {
    console.error('[clean-database] Error deleting uflow_projects:', errProjects);
  }

  // 5. Clean up published directories on disk
  console.log('[clean-database] Cleaning up static folders in public/officemate...');
  try {
    const items = await fs.readdir(PUBLIC_OFFICEMATE_DIR);
    for (const item of items) {
      const itemPath = path.join(PUBLIC_OFFICEMATE_DIR, item);
      const stat = await fs.stat(itemPath);
      if (stat.isDirectory()) {
        await fs.rm(itemPath, { recursive: true, force: true });
        console.log(`[clean-database] Removed directory: public/officemate/${item}`);
      }
    }
  } catch (err) {
    console.error('[clean-database] Error cleaning static directories:', err);
  }

  // 6. Reset manifest.json
  console.log('[clean-database] Resetting public/officemate/manifest.json...');
  const emptyManifest = {
    generated_at: new Date().toISOString(),
    models: []
  };
  try {
    await fs.writeFile(
      path.join(PUBLIC_OFFICEMATE_DIR, 'manifest.json'),
      JSON.stringify(emptyManifest, null, 2),
      'utf8'
    );
    console.log('[clean-database] Successfully reset manifest.json.');
  } catch (err) {
    console.error('[clean-database] Error resetting manifest.json:', err);
  }

  console.log('[clean-database] Database and disk cleanup finished successfully! Ready to go live.');
}

main().catch((err) => {
  console.error('[clean-database] Fatal error:', err);
  process.exit(1);
});
