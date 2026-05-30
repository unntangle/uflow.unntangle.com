import { notFound } from 'next/navigation';
import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import EditAdminJobForm from './EditAdminJobForm';

// ============================================================
// Admin -> Edit Job
// /admin/[id]/edit
//
// Lets an admin edit a job's display `name` and `brief`. Mirrors
// the client edit page (/client/[id]/edit) but with two key
// differences that match the PATCH endpoint's rules:
//
//   1. No ownership gate. Admins manage every job regardless of
//      who created it, so we don't scope the lookup by client_id.
//   2. No mutability gate. The client edit page locks anything
//      past 'draft'; the admin may rename a job at ANY status,
//      because a label fix is harmless on an in-flight/approved
//      job and admins are the ones who catch typos late.
//
// `slug` is loaded for display only and shown read-only in the
// form -- it's immutable (R2 path prefix + public URL + unique
// key). The PATCH endpoint enforces all of this independently;
// this page is just the UX layer.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Edit Job',
};

type EditPageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditAdminJobPage({ params }: EditPageProps) {
  const user = await requireUser('admin');

  const { id } = await params;

  // Load the project plus its client name (for the header
  // subtitle). No client_id scoping -- admins see all brands.
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select('id, slug, name, status, brief, client:uflow_clients(slug, name)')
    .eq('id', id)
    .maybeSingle();

  if (!project) {
    notFound();
  }

  // Supabase returns the joined client as an object or a
  // single-element array depending on the cardinality hint it
  // infers; normalise to a plain object.
  const clientRel = project.client as
    | { slug: string; name: string }
    | { slug: string; name: string }[]
    | null;
  const client = Array.isArray(clientRel) ? clientRel[0] : clientRel;

  // Existing reference images, so the form can show them with a
  // remove affordance (same pattern as the client edit page).
  const { data: refs } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  return (
    <EditAdminJobForm
      project={{
        id: project.id,
        slug: project.slug,
        name: project.name,
        brief: project.brief,
        status: project.status,
      }}
      clientName={client?.name ?? 'Unknown brand'}
      brandSlug={client?.slug ?? ''}
      initialReferences={(refs ?? []).map((r) => ({
        id: r.id as string,
        image_url: r.image_url as string,
      }))}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
