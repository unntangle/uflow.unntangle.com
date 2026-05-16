import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import { isOurPublicUrl } from '../../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// /api/client/projects
//
// Endpoints used by the client dashboard. Every request is
// scoped to auth.clientId (set at login time from the JWT),
// so a client can NEVER see or write to another brand's data,
// regardless of what they POST.
// ============================================================

// ============================================================
// GET /api/client/projects
//
// Returns every job belonging to the caller's client brand,
// regardless of status. The client dashboard groups them by
// status on the front-end.
// ============================================================
export async function GET() {
  const auth = await requireApiUser('client');
  if (auth instanceof NextResponse) return auth;

  if (!auth.clientId) {
    // Defensive: a 'client' role user without clientId is a data
    // integrity bug, but we don't want to leak everyone else's
    // jobs if it ever happens.
    return NextResponse.json(
      { error: 'Your account is not linked to a client brand. Contact an admin.' },
      { status: 403 }
    );
  }

  const { data, error } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, glb_url, approved_glb_url, assigned_to, brief, created_at, updated_at, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email)'
    )
    .eq('client_id', auth.clientId)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[client.projects.list]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ projects: data });
}

// ============================================================
// POST /api/client/projects
// Body: { slug, name, brief?, reference_image_urls?: string[] }
//
// Creates a new project on behalf of the caller's client brand.
// We intentionally DO NOT accept:
//   - client_slug / client_id  → derived from auth.clientId
//   - assigned_to             → null on creation; admin allocates later
//   - status                  → forced to 'draft'
//
// Slug collisions are auto-suffixed with -2, -3, ... up to 50
// attempts, same logic as the admin POST /api/projects endpoint.
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireApiUser('client');
  if (auth instanceof NextResponse) return auth;

  if (!auth.clientId) {
    return NextResponse.json(
      { error: 'Your account is not linked to a client brand. Contact an admin.' },
      { status: 403 }
    );
  }

  let body: {
    slug?: string;
    name?: string;
    brief?: string;
    reference_image_urls?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { slug, name, brief } = body;
  if (!slug || !name) {
    return NextResponse.json(
      { error: 'slug and name required.' },
      { status: 400 }
    );
  }

  // Same slug normalisation as the admin endpoint.
  const cleanSlug = slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleanSlug) {
    return NextResponse.json({ error: 'Invalid slug.' }, { status: 400 });
  }

  // ----- Insert with auto-suffix on slug collision -----
  // Same loop as admin POST. We can't share the code without
  // pulling it into a helper, which I'm keeping out of this
  // change to avoid touching unrelated files.
  const MAX_SUFFIX_ATTEMPTS = 50;
  let attempt = 0;
  let data: { id: string } | null = null;
  let lastError: { code?: string; message?: string } | null = null;

  while (attempt < MAX_SUFFIX_ATTEMPTS) {
    const candidateSlug =
      attempt === 0 ? cleanSlug : `${cleanSlug}-${attempt + 1}`;
    const { data: row, error } = await supabase()
      .from('uflow_projects')
      .insert({
        client_id: auth.clientId,
        slug: candidateSlug,
        name,
        status: 'draft',
        // assigned_to deliberately null — admin allocates via the
        // Job Allocation tab in the admin dashboard.
        assigned_to: null,
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
      lastError = error;
      break;
    }
    attempt++;
  }

  if (!data) {
    if (lastError) {
      console.error('[client.projects.create]', lastError);
    } else {
      console.error(
        '[client.projects.create] exhausted slug attempts',
        { cleanSlug, attempts: attempt }
      );
    }
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  // Reference images: validate every URL is from our R2 bucket
  // so a malicious client can't pin arbitrary external images.
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
      console.error('[client.projects.create.refs]', rErr);
      return NextResponse.json({
        project: data,
        warning:
          'Project created, but some reference images failed to attach.',
      });
    }
  }

  return NextResponse.json({ project: data });
}
