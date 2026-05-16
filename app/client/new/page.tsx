import { requireUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import CreateClientJobForm from './CreateClientJobForm';

// ============================================================
// Client \u2192 Create Job
// /client/new
//
// Client-side equivalent of /admin/jobs/new. Differences:
//   - No client picker (brand is locked to the session)
//   - No artist picker (admin allocates later)
//   - POSTs to /api/client/projects instead of /api/projects
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Create Job',
};

export default async function Page() {
  const user = await requireUser('client');

  if (!user.clientId) {
    // Same defensive path as /client/page.tsx \u2014 a 'client' user
    // missing a clientId can't create jobs.
    return (
      <div className="crm-shell">
        <main className="crm-main">
          <div className="crm-page">
            <div className="crm-empty">
              <h3>No brand linked</h3>
              <p>
                Your account isn&apos;t linked to a client brand yet.
                Contact your admin.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Fetch the brand record \u2014 the form needs the slug for the R2
  // reference upload signing call.
  const { data: brand } = await supabase()
    .from('uflow_clients')
    .select('id, slug, name')
    .eq('id', user.clientId)
    .maybeSingle();

  return (
    <CreateClientJobForm
      brand={brand ?? { id: user.clientId, slug: '', name: 'Unknown brand' }}
      currentUser={{ name: user.name, role: user.role as 'client' }}
    />
  );
}
