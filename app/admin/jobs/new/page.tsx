import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import CreateJobForm from './CreateJobForm';

// ============================================================
// Create Job page
// Used to be a modal in AdminDashboard — broken out into its
// own route so the form has room to breathe and can be linked
// to / bookmarked.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Create Job',
};

export default async function CreateJobPage() {
  const user = await requireUser('admin');

  const [{ data: clients }, { data: artists }] = await Promise.all([
    supabase().from('uflow_clients').select('slug, name').order('name'),
    supabase()
      .from('uflow_users')
      .select('id, name, email')
      .eq('role', '3d_artist')
      .order('name'),
  ]);

  return (
    <CreateJobForm
      clients={clients || []}
      artists={artists || []}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
