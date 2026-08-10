import { requireUser } from '../../../lib/auth';
import { supabase, ProjectStatus } from '../../../lib/supabase';
import { VARIANT_SELECT, sortVariants } from '../../../lib/variant-status';
import ChangeStatusPage from './ChangeStatusPage';

// ============================================================
// Change Status page
// ============================================================
// A manual override surface: one row per job, a dropdown per
// row, and a Save that writes nothing but the status field.
//
// Every OTHER status transition in this app is a side effect of
// doing the work — an artist clicks Start, an upload lands, a
// reviewer approves or rejects. That's the right default, but it
// leaves no way to fix a job that ended up in the wrong state
// (an accidental rejection, a job that stalled after a failed
// upload, a status left behind by a data migration). Until now
// the only fix was scripts/set-project-status.ts over SSH, which
// isn't something the people who notice the problem can run.
//
// Loads ALL statuses, unlike Reassign Jobs which excludes the
// finished ones. Correcting an approved job that shouldn't be
// approved is one of the main reasons to open this page, so
// filtering it out would remove the point.
//
// Colourways are included because since the 2026-08-06 variants
// migration the variant rows hold the authoritative status —
// changing only uflow_projects.status on a job that has them
// would appear to do nothing on every dashboard. The client
// component renders them as expandable child rows, each with
// its own dropdown.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Change Status',
};

type Variant = {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  revision_count: number;
  is_primary: boolean;
  position: number;
  updated_at: string;
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  updated_at: string;
  client_id: string;
  client:
    | { slug: string; name: string }
    | { slug: string; name: string }[]
    | null;
  assignee:
    | { id: string; name: string }
    | { id: string; name: string }[]
    | null;
  variants?: Variant[] | null;
};

export default async function Page() {
  const user = await requireUser('admin');

  const { data: rawProjects } = await supabase()
    .from('uflow_projects')
    .select(
      `id, slug, name, status, revision_count, assigned_to, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name), ${VARIANT_SELECT}`
    )
    .order('updated_at', { ascending: false });

  // PostgREST returns embedded relations as either an object or a
  // one-element array depending on the cardinality it infers, so
  // both are normalised here rather than in the client component.
  const projects = (rawProjects || []).map((p) => {
    const r = p as unknown as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      revision_count: r.revision_count,
      assigned_to: r.assigned_to,
      updated_at: r.updated_at,
      client_id: r.client_id,
      client: c ?? { slug: '', name: '' },
      assignee: a ?? null,
      // Embedded resources can't be ordered by PostgREST
      // independently of their parent, so ordering happens here.
      variants: sortVariants(r.variants),
    };
  });

  return (
    <ChangeStatusPage
      initialProjects={projects}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
