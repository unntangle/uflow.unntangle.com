import { notFound } from 'next/navigation';
import { requireUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import FeedbackGallery from './FeedbackGallery';

// ============================================================
// Feedback gallery (one project per route)
// /projects/[id]/feedback?revision=N
//
// Role-aware standalone page that lists rejection feedback
// images for a project. Replaces the in-dashboard modal so
// users can open feedback in a new tab and keep the dashboard
// visible.
//
// Two data sources, picked by role:
//   - artist           → uflow_feedback_images (admin's screenshots
//                        sent to the artist during IQA review)
//   - client           → uflow_client_feedback_images (the client's
//                        own screenshots from EQA rejection)
//   - admin            → defaults to admin-side; pass ?source=client
//                        to see what the client uploaded instead
//
// Query params:
//   - revision (optional): filter to a single revision. Omit to
//     show all revisions on one page (grouped, newest first).
//   - source (optional, admin only): 'admin' | 'client'. Ignored
//     for non-admin callers — their role determines the source.
//
// Auth & scoping (server-side):
//   - artist: must be assigned to the project (404 otherwise)
//   - client: project must be in the caller's brand (404 otherwise)
//   - admin: full visibility
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Feedback images',
};

type SearchParams = Promise<{
  revision?: string;
  source?: string;
}>;

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;

  // Parse revision filter. Invalid values fall back to "all
  // revisions" rather than 404'ing — keeps shared/typo'd links
  // from being dead.
  const revisionFilter = (() => {
    if (!sp.revision) return null;
    const n = parseInt(sp.revision, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  // Determine the data source. Admins can override; everyone
  // else is locked to their role's natural source.
  let source: 'admin' | 'client';
  if (user.role === 'admin') {
    source = sp.source === 'client' ? 'client' : 'admin';
  } else if (user.role === 'client') {
    source = 'client';
  } else {
    // 3d_artist (or anything else falling back to artist role)
    source = 'admin';
  }

  // ----- Load the project + verify access -----
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, revision_count, assigned_to, client_id, client:uflow_clients(slug, name)'
    )
    .eq('id', id)
    .maybeSingle();

  if (!project) notFound();

  // Per-role scoping. Mirrors the references page so the two
  // pages behave consistently.
  if (user.role === '3d_artist') {
    if (project.assigned_to !== user.userId) notFound();
  } else if (user.role === 'client') {
    if (!user.clientId || project.client_id !== user.clientId) notFound();
  }
  // Admin: no extra check.

  // ----- Fetch the feedback rows -----
  // We normalise to a common shape { id, revision, image_url,
  // note?, created_at } so the gallery doesn't need to know
  // which table it came from. Admin-side rows have a `note`;
  // client-side rows don't.
  type GalleryItem = {
    id: string;
    revision: number;
    image_url: string;
    note: string | null;
    created_at: string;
  };

  let items: GalleryItem[] = [];

  if (source === 'admin') {
    const { data } = await supabase()
      .from('uflow_feedback_images')
      .select('id, revision, image_url, note, created_at')
      .eq('project_id', id)
      .order('revision', { ascending: false })
      .order('created_at', { ascending: true });
    items = (data ?? []) as GalleryItem[];
  } else {
    const { data } = await supabase()
      .from('uflow_client_feedback_images')
      .select('id, revision_number, image_url, created_at')
      .eq('project_id', id)
      .order('revision_number', { ascending: false })
      .order('created_at', { ascending: true });
    // Re-shape the client-side rows so they share the artist-side
    // shape. The field on disk is revision_number (with an
    // underscore) — we collapse that name difference here so the
    // gallery's grouping logic doesn't care which source we came
    // from.
    items = (data ?? []).map((r) => ({
      id: r.id as string,
      revision: r.revision_number as number,
      image_url: r.image_url as string,
      note: null,
      created_at: r.created_at as string,
    }));
  }

  // Apply the revision filter (server-side so the page payload
  // only carries the rows we'll actually display).
  if (revisionFilter !== null) {
    items = items.filter((i) => i.revision === revisionFilter);
  }

  // Compute the set of all available revisions for the source,
  // so the gallery can show the "Show all revisions (N)" escape
  // hatch when the current filter has no rows. We do this in a
  // second tiny query to keep the count accurate even when the
  // filtered fetch above returns nothing.
  let availableRevisions: number[] = [];
  if (revisionFilter !== null) {
    if (source === 'admin') {
      const { data } = await supabase()
        .from('uflow_feedback_images')
        .select('revision')
        .eq('project_id', id);
      availableRevisions = Array.from(
        new Set((data ?? []).map((r) => r.revision as number))
      ).sort((a, b) => b - a);
    } else {
      const { data } = await supabase()
        .from('uflow_client_feedback_images')
        .select('revision_number')
        .eq('project_id', id);
      availableRevisions = Array.from(
        new Set((data ?? []).map((r) => r.revision_number as number))
      ).sort((a, b) => b - a);
    }
  } else {
    availableRevisions = Array.from(
      new Set(items.map((i) => i.revision))
    ).sort((a, b) => b - a);
  }

  // Normalise the joined client relation.
  const c = Array.isArray(project.client) ? project.client[0] : project.client;

  return (
    <FeedbackGallery
      project={{
        id: project.id,
        slug: project.slug,
        name: project.name,
        client: c ?? { slug: '', name: '' },
      }}
      items={items}
      revisionFilter={revisionFilter}
      availableRevisions={availableRevisions}
      source={source}
    />
  );
}
