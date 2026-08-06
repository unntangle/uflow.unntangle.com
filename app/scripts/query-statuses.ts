import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function main() {
  const { supabase } = await import('../lib/supabase');
  const db = supabase();
  const { data, error } = await db.from('uflow_projects').select('status');
  if (error) {
    console.error(JSON.stringify(error, null, 2));
    process.exit(1);
  }
  const counts = (data || []).reduce((acc, row) => {
    const status = row.status ?? 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(JSON.stringify(counts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
