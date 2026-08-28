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

  const [{ data: clients }, { data: artists }, { data: jobs, error: jobsErr }] =
    await Promise.all([
      supabase().from('uflow_clients').select('slug, name').order('name'),
      supabase()
        .from('uflow_users')
        .select('id, name, email')
        .eq('role', '3d_artist')
        .order('name'),
      // Candidate parents for the "Child" branch of the form:
      // EVERY existing job that is not itself a child.
      //
      // Deliberately not scoped to the client selected in the
      // form. A child records where a model was derived from, and
      // that lineage can legitimately cross brands — the same
      // chassis re-skinned for a different client is exactly the
      // case this feature is for.
      //
      // The model_type filter is what keeps the hierarchy one
      // level deep: a child can never appear here, so it can
      // never become a parent.
      supabase()
        .from('uflow_projects')
        .select('id, name, slug, client:uflow_clients(slug, name)')
        .eq('model_type', 'parent')
        .order('name'),
    ]);

  // A missing model_type column means the 2026-08-28 migration
  // hasn't been run. PostgREST fails the whole query in that
  // case, which would silently show an empty parent list and
  // leave the admin guessing.
  //
  // Flattened to one string before logging: a PostgREST error is
  // a plain object, not an Error, and the Next.js dev overlay
  // renders a passed object as `{}`. Unlike the Change Type page
  // this only warns — the rest of the form still works, and an
  // admin creating a plain parent job shouldn't be blocked by a
  // dropdown they aren't using.
  if (jobsErr) {
    const parts = [jobsErr.message, jobsErr.details, jobsErr.hint].filter(
      Boolean
    );
    const detail = parts.length ? parts.join(' — ') : JSON.stringify(jobsErr);
    console.error(
      `[create-job.parents] could not load parent models (${
        jobsErr.code || 'no-code'
      }): ${detail} — has migrations/2026-08-28_add_parent_child_models.sql been run?`
    );
  }

  // Flatten the embedded client. PostgREST returns an object for
  // a to-one embed but supabase-js types it as an array, and the
  // shape has bitten this codebase before — handle both rather
  // than trusting one.
  const parentOptions = (jobs || []).map((j) => {
    const raw = j.client as unknown;
    const client = (Array.isArray(raw) ? raw[0] : raw) as
      | { slug: string; name: string }
      | null
      | undefined;
    return {
      id: j.id as string,
      name: j.name as string,
      slug: j.slug as string,
      client_slug: client?.slug ?? '',
      client_name: client?.name ?? '',
    };
  });

  return (
    <CreateJobForm
      clients={clients || []}
      artists={artists || []}
      parentOptions={parentOptions}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
