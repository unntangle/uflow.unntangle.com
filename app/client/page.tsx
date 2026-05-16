import { requireUser } from '../lib/auth';
import { supabase } from '../lib/supabase';
import ClientDashboard from './ClientDashboard';

// ============================================================
// Client dashboard
// /client
//
// Lists all jobs belonging to the caller's client brand. Server-
// side rendered with the initial project list so first paint
// already has data \u2014 same pattern as the admin dashboard.
//
// Auth: 'client' role only. The session's clientId determines
// which brand's jobs are visible; clients can never see another
// brand's data, regardless of URL manipulation.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Client Dashboard',
};

export default async function ClientPage() {
  const user = await requireUser('client');

  // Defensive check \u2014 a 'client' user without a clientId is a
  // data integrity issue. Render an explanatory empty state
  // instead of crashing or silently showing nothing.
  if (!user.clientId) {
    return (
      <div className="crm-shell">
        <main className="crm-main">
          <div className="crm-page">
            <div className="crm-empty">
              <h3>No brand linked</h3>
              <p>
                Your account isn&apos;t linked to a client brand yet.
                Contact your admin to fix this.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Fetch projects + the brand record (so we can show its name in
  // the page header). Run in parallel to keep TTFB low.
  const [{ data: projects }, { data: brand }] = await Promise.all([
    supabase()
      .from('uflow_projects')
      .select(
        'id, slug, name, status, revision_count, glb_url, approved_glb_url, assigned_to, brief, created_at, updated_at, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), client_feedback_count:uflow_client_feedback_images(count)'
      )
      .eq('client_id', user.clientId)
      .order('updated_at', { ascending: false }),
    supabase()
      .from('uflow_clients')
      .select('id, slug, name')
      .eq('id', user.clientId)
      .maybeSingle(),
  ]);

  // Normalise the joined relations \u2014 Supabase returns them as
  // arrays-or-objects depending on the cardinality hint, so we
  // unwrap to consistent shapes the component expects.
  type Joined = {
    client: { slug: string; name: string } | { slug: string; name: string }[] | null;
    assignee:
      | { id: string; name: string; email: string }
      | { id: string; name: string; email: string }[]
      | null;
    // Supabase aggregate counts come back as either { count: N }
    // or [{ count: N }] depending on the join shape. We collapse
    // both into a single boolean flag the component branches on.
    client_feedback_count?:
      | { count: number }
      | { count: number }[]
      | null;
  };
  const normalised = (projects || []).map((p) => {
    const r = p as Joined & Record<string, unknown>;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    const fc = Array.isArray(r.client_feedback_count)
      ? r.client_feedback_count[0]
      : r.client_feedback_count;
    const feedbackCount = fc?.count ?? 0;
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      assignee: a,
      // Strip the raw aggregate from the payload, the component
      // only consumes the boolean flag, not the wrapper shape.
      client_feedback_count: undefined,
      has_client_rejection: feedbackCount > 0,
    };
  });

  return (
    <ClientDashboard
      initialProjects={normalised as never}
      brand={brand ?? { id: user.clientId, slug: '', name: 'Unknown brand' }}
      currentUser={{
        name: user.name,
        role: user.role as 'client',
      }}
    />
  );
}
