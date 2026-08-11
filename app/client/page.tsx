import { requireUser } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { VARIANT_SELECT, sortVariants, sortByLatest } from '../lib/variant-status';
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
        // VARIANT_SELECT is not optional decoration. Since the
        // 2026-08-06 variants migration, uflow_projects.status is
        // only written on the legacy single-model path, so a job
        // whose colourway was forwarded to EQA still reads 'wip'
        // (or worse) on the product row. Without the colourways in
        // hand the dashboard buckets on a stale column and the
        // client's EQA queue comes back empty.
        //
        // The references join drives the References column
        // thumbnail. We pull the whole set (one small row each)
        // and collapse to the earliest below, so the table can
        // render a thumbnail without an N+1 fetch per row.
        `id, slug, name, status, revision_count, glb_url, approved_glb_url, assigned_to, brief, created_at, updated_at, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), client_feedback:uflow_client_feedback_images(revision_number), references:uflow_project_references(image_url, created_at), ${VARIANT_SELECT}`
      )
      .eq('client_id', user.clientId)
      // Ordering is finalised client-side by sortByLatest below —
      // the DB can only order on the product's own updated_at,
      // which goes stale the moment a colourway moves. This just
      // gives the normaliser a sensible starting order.
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
    // Supabase returns the embedded client-feedback rows as an
    // array of { revision_number }. We use the DISTINCT revision
    // numbers to derive how many rounds the CLIENT (EQA) rejected,
    // deliberately ignoring internal IQA rejection rounds that are
    // also folded into uflow_projects.revision_count.
    client_feedback?:
      | { revision_number: number | null }[]
      | null;
    // Colourways. Each runs the pipeline independently, so the
    // product's client-facing state is a roll-up of these rather
    // than the (legacy) uflow_projects.status column.
    variants?: { position?: number }[] | null;
    // Reference images attached at job creation, collapsed to a
    // single thumbnail URL below.
    references?: { image_url: string; created_at: string }[] | null;
  };
  const normalised = (projects || []).map((p) => {
    const r = p as Joined & Record<string, unknown>;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    // Distinct EQA (client) rejection rounds. uflow_projects
    // .revision_count mixes IQA + EQA rounds; the client must only
    // ever see the rounds they themselves rejected, so we rebuild
    // a client-scoped count from their own feedback rows.
    const clientFeedback = Array.isArray(r.client_feedback)
      ? r.client_feedback
      : [];
    const clientRevisions = Array.from(
      new Set(
        clientFeedback
          .map((row) => row?.revision_number)
          .filter((n): n is number => typeof n === 'number')
      )
    );
    const clientRevisionCount = clientRevisions.length;
    const latestClientRevision =
      clientRevisionCount > 0 ? Math.max(...clientRevisions) : null;
    const refs = Array.isArray(r.references) ? r.references : [];
    const firstRef = [...refs].sort((x, y) =>
      x.created_at < y.created_at ? -1 : 1
    )[0];
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      assignee: a,
      // Strip the raw embedded rows from the payload, the component
      // only consumes the derived count + flag, not the wrapper.
      client_feedback: undefined,
      // Client-facing revision round = number of distinct rounds
      // the client rejected. IQA rounds are excluded entirely.
      client_revision_count: clientRevisionCount,
      // Highest client revision number, used to deep-link the
      // Revision Round cell into the client feedback gallery.
      latest_client_revision: latestClientRevision,
      has_client_rejection: clientRevisionCount > 0,
      // PostgREST can't order an embedded resource independently
      // of its parent, so ordering happens here.
      variants: sortVariants(r.variants),
      // Earliest reference = the table thumbnail. Sorted here for
      // the same PostgREST reason. Null when the job was created
      // without references.
      thumb_url: firstRef?.image_url ?? null,
      // Strip the raw join out of the wire payload; the component
      // only consumes the single URL above.
      references: undefined,
    };
  });

  return (
    <ClientDashboard
      initialProjects={sortByLatest(normalised) as never}
      brand={brand ?? { id: user.clientId, slug: '', name: 'Unknown brand' }}
      currentUser={{
        name: user.name,
        role: user.role as 'client',
      }}
    />
  );
}
