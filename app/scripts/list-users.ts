// ============================================================
// Temporary utility script to list users in the database
// ============================================================

import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import path from 'node:path';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

async function main() {
  const { supabase } = await import('../lib/supabase');

  console.log('Querying uflow_users...');
  const { data, error } = await supabase()
    .from('uflow_users')
    .select('id, email, name, role');

  if (error) {
    console.error('Error fetching users:', error);
    return;
  }

  console.log('Users found in DB:');
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
