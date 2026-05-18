import { notFound } from 'next/navigation';
import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import EditClientJobForm from './EditClientJobForm';
import Sidebar from '../../../components/Sidebar';
import { crmPath } from '../../../lib/client-fetch';

// ============================================================
// Client → Edit Job
// /client/[id]/edit
//
// Edits the name, brief, and reference images of a job the
// client created earlier. The page is gated TWICE:
//   1. Ownership      — project.client_id must equal the
//                       session's clientId. Otherwise → 404.
//   2. Mutability     — only `status === 'draft'` projects are
//                       editable; once an admin has allocated
//                       the job we render a "locked" empty state
//                       so the user can't even try (and stale
//                       links don't 500).
//
// The actual PATCH endpoint enforces both rules independently —
// this is the UX layer, the server-side guard is in
// /api/client/projects/[id]/route.ts.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Edit Job',
};

type EditPageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditClientJobPage({ params }: EditPageProps) {
  const user = await requireUser('client');

  if (!user.clientId) {
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

  const { id } = await params;

  // Fetch project (scoped to the caller's brand), references,
  // and the brand record in parallel. The brand is needed so the
  // form can request presigned R2 uploads under the right slug
  // — same as the Create form.
  const [{ data: project }, { data: refs }, { data: brand }] = await Promise.all([
    supabase()
      .from('uflow_projects')
      .select('id, slug, name, status, brief')
      .eq('id', id)
      .eq('client_id', user.clientId)
      .maybeSingle(),
    supabase()
      .from('uflow_project_references')
      .select('id, image_url, created_at')
      .eq('project_id', id)
      .order('created_at', { ascending: true }),
    supabase()
      .from('uflow_clients')
      .select('id, slug, name')
      .eq('id', user.clientId)
      .maybeSingle(),
  ]);

  // 404 via next/navigation — same response a malicious id probe
  // would get, so we don't leak whether the project exists for
  // another brand. We could also redirect to /client; 404 reads
  // more correctly for direct URL hits.
  if (!project) {
    notFound();
  }

  // ----- Locked state: not a draft -----
  // Render a friendly explainer with a "back" CTA rather than
  // 404'ing here. The user clicked an Edit button that should
  // never have rendered (the dashboard hides it for non-draft
  // rows), but if their tab is stale they get a meaningful
  // message instead of a generic error.
  if (project.status !== 'draft') {
    return (
      <div className="crm-shell">
        <Sidebar
          name={user.name}
          role={user.role as 'client'}
          brandName={brand?.name ?? 'Unknown brand'}
        />
        <main className="crm-main">
          <div className="crm-page" style={{ maxWidth: 720 }}>
            <header className="crm-page-header">
              <div>
                <h1 className="crm-page-title">Edit Job</h1>
                <p className="crm-page-sub">
                  {brand?.name ?? 'Your brand'} ·{' '}
                  <strong>{project.name}</strong>
                </p>
              </div>
            </header>
            <div className="crm-card">
              <h3 style={{ marginTop: 0 }}>This job can no longer be edited</h3>
              <p style={{ color: 'var(--text-dim)' }}>
                It&apos;s already been allocated to an artist and is
                in the production pipeline. If you need changes
                made, please contact your admin and they can route
                feedback through the right channel.
              </p>
              <div style={{ marginTop: 16 }}>
                <a className="crm-btn crm-btn-secondary" href={crmPath('/client')}>
                  Back to dashboard
                </a>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <EditClientJobForm
      project={{
        id: project.id,
        slug: project.slug,
        name: project.name,
        brief: project.brief,
      }}
      initialReferences={(refs ?? []).map((r) => ({
        id: r.id,
        image_url: r.image_url,
      }))}
      brand={brand ?? { id: user.clientId, slug: '', name: 'Unknown brand' }}
      currentUser={{ name: user.name, role: user.role as 'client' }}
    />
  );
}
