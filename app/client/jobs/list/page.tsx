import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import { VARIANT_SELECT, sortVariants, sortByLatest } from '../../../lib/variant-status';
import ListClientJobsPage from './ListClientJobsPage';

// ============================================================
// Client -> List Jobs
// /client/jobs/list
//
// A flat, single-table listing of EVERY job belonging to the
// caller's brand, across all statuses (no tab bar, no per-bucket
// filtering). The client equivalent of /admin/jobs/list — a
// management index where the client can see everything at a
// glance and search by name/slug.
//
// It reuses the exact same query shape + client-scoped revision
// derivation as app/client/page.tsx, so the columns line up with
// the Overview dashboard the client already knows. In particular,
// the Revision Round column counts ONLY the client's own (EQA)
// rejection rounds — internal IQA rounds are never surfaced.
//
// Auth: 'client' role only; scoped to the session's clientId so
// a client can never see another brand's jobs.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'List Jobs',
};

export default async function ClientListJobsPage() {
  const user = await requireUser('client');

  // Defensive: a 'client' user with no linked brand can't be
  // scoped to any jobs. Mirror the Overview's empty state rather
  // than crashing or leaking everyone's jobs.
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

  const [{ data: projects }, { data: brand }] = await Promise.all([
    supabase()
      .from('uflow_projects')
      .select(
        // Colourways included so the Status column derives from the
        // same roll-up the Overview uses — uflow_projects.status is
        // stale on any job whose variants have moved on their own.
        // The references join drives the References column thumbnail.
        `id, slug, name, status, revision_count, glb_url, approved_glb_url, assigned_to, brief, created_at, updated_at, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), client_feedback:uflow_client_feedback_images(revision_number), references:uflow_project_references(image_url, created_at), ${VARIANT_SELECT}`
      )
      .eq('client_id', user.clientId)
      .order('updated_at', { ascending: false }),
    supabase()
      .from('uflow_clients')
      .select('id, slug, name')
      .eq('id', user.clientId)
      .maybeSingle(),
  ]);

  // Same normalisation as app/client/page.tsx: unwrap the joined
  // client relation and derive the client-scoped revision count
  // (distinct EQA rejection rounds) so IQA rounds stay hidden.
  type Joined = {
    client:
      | { slug: string; name: string }
      | { slug: string; name: string }[]
      | null;
    client_feedback?: { revision_number: number | null }[] | null;
    // updated_at alongside position — sortVariants is generic, so a
    // narrower cast would erase the timestamp sortByLatest needs.
    variants?: { position?: number; updated_at?: string | null }[] | null;
    references?: { image_url: string; created_at: string }[] | null;
  };
  const normalised = (projects || []).map((p) => {
    const r = p as Joined & Record<string, unknown>;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
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
    const refs = Array.isArray(r.references) ? r.references : [];
    const firstRef = [...refs].sort((x, y) =>
      x.created_at < y.created_at ? -1 : 1
    )[0];
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      client_feedback: undefined,
      client_revision_count: clientRevisionCount,
      latest_client_revision:
        clientRevisionCount > 0 ? Math.max(...clientRevisions) : null,
      has_client_rejection: clientRevisionCount > 0,
      variants: sortVariants(r.variants),
      thumb_url: firstRef?.image_url ?? null,
      references: undefined,
    };
  });

  return (
    <ListClientJobsPage
      initialProjects={sortByLatest(normalised) as never}
      brand={brand ?? { id: user.clientId, slug: '', name: 'Unknown brand' }}
      currentUser={{ name: user.name, role: user.role as 'client' }}
    />
  );
}
