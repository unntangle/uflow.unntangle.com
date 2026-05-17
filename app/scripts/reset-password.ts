// ============================================================
// Reset Password: Set password of artist@uflow.com to 'artist123'
// ============================================================

import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

async function main() {
  const { supabase } = await import('../lib/supabase');

  console.log('Resetting password for artist@uflow.com...');
  
  // The hash below is bcrypt for 'artist123' (cost 10)
  const hash = '$2b$10$bbrcVxL14gMxzoSzxbMAeehPX6b9UFnyhGUTSWSbztU7QO50vbhQ2';

  const { error } = await supabase()
    .from('uflow_users')
    .update({ password_hash: hash })
    .eq('email', 'artist@uflow.com');

  if (error) {
    console.error('Error updating password:', error);
    return;
  }

  console.log('Password successfully reset to: artist123');
}

main().catch(console.error);
