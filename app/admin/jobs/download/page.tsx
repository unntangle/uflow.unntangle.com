import { requireUser } from '../../../lib/auth';
import { supabase, ProjectStatus } from '../../../lib/supabase';
import DownloadJobsPage from './DownloadJobsPage';

// ============================================================
// Admin -> Download Jobs
// /admin/jobs/download
//
// A flat listing of every job and its files. Same query shape +
// columns as List Jobs, so the pages feel like siblings — but the
// action column is the hub for a job's assets:
//
//   - View GLB         → opens the full-screen model viewer
//   - Download GLB      → saves the latest .glb
//   - View References   → opens the reference-image gallery
//   - Download References → zips the reference images
//
// Whether a job has a downloadable GLB depends on its lifecycle:
// any job that's had at least one upload carries a `glb_url`.
// Reference images are attached at creation, so a job may have
// references but no GLB yet (or vice-versa). Rows missing either
// asset render a disabled state for just that asset rather than
// being hidden — so the list stays a complete index that mirrors
// List Jobs.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Download Jobs',
};

type ReferenceRow = { id: string; image_url: string };

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  glb_url: string | null;
  fbx_url: string | null;
  gltf_url: string | null;
  zip_url: string | null;
  spp_url: string | null;
  approved_glb_url: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string } | { slug: string; name: string }[] | null;
  assignee:
    | { id: string; name: string; email: string }
    | { id: string; name: string; email: string }[]
    | null;
  references: ReferenceRow[] | null;
  // IQA = admin rejection rounds (uflow_feedback_images.revision);
  // EQA = client rejection rounds (uflow_client_feedback_images.
  // revision_number). We count DISTINCT round numbers below so a
  // round with several feedback images still counts as one.
  iqa: { revision: number }[] | null;
  eqa: { revision_number: number }[] | null;
};

export default async function AdminDownloadJobsPage() {
  const user = await requireUser('admin');

  // Tiered select. The richest query needs (a) the spp_url column
  // (added by the 2026-06-24 migration) and (b) the feedback-image
  // embeds for the IQA/EQA counts. If either isn't available yet —
  // migration not run, or PostgREST can't resolve an embed — we
  // fall back so the page still lists every job instead of silently
  // showing nothing. Whatever failed is logged so the cause is
  // obvious in the server console.
  const COLS_BASE =
    'id, slug, name, status, revision_count, assigned_to, glb_url, fbx_url, gltf_url, zip_url, approved_glb_url, created_at, updated_at, client_id';
  const COLS_WITH_SPP = COLS_BASE.replace('zip_url,', 'zip_url, spp_url,');
  const EMBEDS_BASE =
    ', client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), references:uflow_project_references(id, image_url)';
  const EMBEDS_COUNTS =
    ', iqa:uflow_feedback_images(revision), eqa:uflow_client_feedback_images(revision_number)';

  const attempts: { label: string; select: string }[] = [
    { label: 'full (spp + counts)', select: COLS_WITH_SPP + EMBEDS_BASE + EMBEDS_COUNTS },
    { label: 'counts, no spp_url', select: COLS_BASE + EMBEDS_BASE + EMBEDS_COUNTS },
    { label: 'base (no spp, no counts)', select: COLS_BASE + EMBEDS_BASE },
  ];

  let rawProjects: unknown[] | null = null;
  for (const attempt of attempts) {
    const { data, error } = await supabase()
      .from('uflow_projects')
      .select(attempt.select)
      .order('updated_at', { ascending: false });
    if (!error) {
      rawProjects = data;
      break;
    }
    console.error(
      `[download page] query "${attempt.label}" failed: ${error.message}`
    );
  }

  const normalised = (rawProjects || []).map((p) => {
    const r = p as ProjectRow;
    const c = Array.isArray(r.client) ? r.client[0] : r.client;
    const a = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    // Distinct rejection rounds per QA stage.
    const iqaCount = new Set((r.iqa ?? []).map((x) => x.revision)).size;
    const eqaCount = new Set(
      (r.eqa ?? []).map((x) => x.revision_number)
    ).size;
    return {
      ...r,
      client: c ?? { slug: '', name: '' },
      assignee: a,
      references: r.references ?? [],
      // Explicit so the no-spp fallback tier yields null (a dash)
      // rather than leaving the field undefined.
      spp_url: r.spp_url ?? null,
      iqa_count: iqaCount,
      eqa_count: eqaCount,
    };
  });

  return (
    <DownloadJobsPage
      initialProjects={normalised as never}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
