import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { isOurPublicUrl } from '../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// GET /api/projects        → list all projects (joined with client)
// POST /api/projects       → create a new project (artist-only)
//   body: { client_slug: 'officemate', slug: 'mars-desk', name: 'Mars Desk' }
// ============================================================

export async function GET() {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  let query = supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, zip_url, glb_url, fbx_url, gltf_url, approved_glb_url, assigned_to, brief, created_at, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email)'
    )
    .order('updated_at', { ascending: false });

  // Artists only see jobs assigned to them. Admins see everything.
  if (auth.role === '3d_artist') {
    query = query.eq('assigned_to', auth.userId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[projects.list]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ projects: data });
}

export async function POST(req: NextRequest) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  let body: {
    client_slug?: string;
    slug?: string;
    name?: string;
    assigned_to?: string;
    brief?: string;
    reference_image_urls?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { client_slug, slug, name, assigned_to, brief } = body;
  if (!client_slug || !slug || !name) {
    return NextResponse.json(
      { error: 'client_slug, slug, name required.' },
      { status: 400 }
    );
  }
  if (!assigned_to) {
    return NextResponse.json(
      { error: 'assigned_to (artist user id) required.' },
      { status: 400 }
    );
  }

  // Normalise slug — lowercase, alphanumeric + dash only.
  const cleanSlug = slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleanSlug) {
    return NextResponse.json({ error: 'Invalid slug.' }, { status: 400 });
  }

  // Resolve client.
  const { data: client, error: cErr } = await supabase()
    .from('uflow_clients')
    .select('id')
    .eq('slug', client_slug)
    .maybeSingle();
  if (cErr || !client) {
    return NextResponse.json(
      { error: `Unknown client: ${client_slug}` },
      { status: 400 }
    );
  }

  // Verify the assignee exists and is a 3D artist.
  const { data: assignee, error: aErr } = await supabase()
    .from('uflow_users')
    .select('id, role')
    .eq('id', assigned_to)
    .maybeSingle();
  if (aErr || !assignee) {
    return NextResponse.json(
      { error: 'Assigned artist not found.' },
      { status: 400 }
    );
  }
  if (assignee.role !== '3d_artist') {
    return NextResponse.json(
      { error: 'assigned_to must reference a 3D artist user.' },
      { status: 400 }
    );
  }

  // ----- Insert with auto-suffix on slug collision -----
  // The (client_id, slug) unique constraint means two projects with
  // the same name for the same client would collide. Rather than
  // erroring out to the admin, we retry with -2, -3, ... appended
  // until an insert succeeds. We catch the Postgres unique-violation
  // code (23505) per attempt so concurrent creators can't both pick
  // the same suffix (a pre-check would race).
  //
  // We cap retries at MAX_SUFFIX_ATTEMPTS so a misconfigured DB or
  // a non-slug constraint violation can't loop forever.
  const MAX_SUFFIX_ATTEMPTS = 50;
  let attempt = 0;
  let data: { id: string } | null = null;
  let lastError: { code?: string; message?: string } | null = null;

  while (attempt < MAX_SUFFIX_ATTEMPTS) {
    const candidateSlug = attempt === 0 ? cleanSlug : `${cleanSlug}-${attempt + 1}`;
    const { data: row, error } = await supabase()
      .from('uflow_projects')
      .insert({
        client_id: client.id,
        slug: candidateSlug,
        name,
        status: 'draft',
        assigned_to,
        brief: brief?.trim() || null,
        created_by: auth.userId,
      })
      .select()
      .single();

    if (!error) {
      data = row;
      break;
    }
    if (error.code !== '23505') {
      // Not a unique-key conflict — some other DB problem. Bail out.
      lastError = error;
      break;
    }
    // Slug collision — try the next suffix.
    attempt++;
  }

  if (!data) {
    if (lastError) {
      console.error('[projects.create]', lastError);
    } else {
      console.error(
        '[projects.create] exhausted slug attempts',
        { cleanSlug, attempts: attempt }
      );
    }
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  // The returned row carries the actual stored slug (possibly
  // suffixed), so the client sees what it got without needing to
  // know we did anything special server-side.

  // Persist any reference image URLs the client uploaded before
  // calling this endpoint. We validate that each URL is from our
  // R2 bucket to prevent an admin client from pinning arbitrary
  // external images.
  const rawRefs = Array.isArray(body.reference_image_urls)
    ? body.reference_image_urls
    : [];
  const refUrls = rawRefs
    .filter((u): u is string => typeof u === 'string')
    .filter((u) => isOurPublicUrl(u));

  if (refUrls.length > 0) {
    const refRows = refUrls.map((url) => ({
      project_id: data.id,
      image_url: url,
      uploaded_by: auth.userId,
    }));
    const { error: rErr } = await supabase()
      .from('uflow_project_references')
      .insert(refRows);
    if (rErr) {
      console.error('[projects.create.refs]', rErr);
      // Don't fail the whole request — the project exists; surface
      // a partial-success warning so the UI can retry references.
      return NextResponse.json({
        project: data,
        warning: 'Project created, but some reference images failed to attach.',
      });
    }
  }

  return NextResponse.json({ project: data });
}
