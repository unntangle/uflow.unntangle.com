import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { isOurPublicUrl } from '../../lib/r2';
import {
  isJobComplexity,
  isJobCategory,
  type JobComplexity,
  type JobCategory,
} from '../../lib/job-options';

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
      // Include the creator's role via the FK constraint so the
      // admin dashboard can show Delete only on rows admin
      // created. The GET response shape must stay in sync with
      // app/admin/page.tsx's SSR select — otherwise a refresh-
      // -via-/api/projects would silently drop the field.
      //
      // parent_id is returned raw rather than embedded. A
      // self-referencing embed needs the FK constraint name as a
      // hint, and PostgREST fails the ENTIRE query if that hint
      // is wrong — which would take down every dashboard that
      // polls this endpoint. Callers resolve the parent's name
      // from the same result set instead.
      'id, slug, name, status, revision_count, feedback_seen_revision, zip_url, glb_url, fbx_url, gltf_url, approved_glb_url, assigned_to, brief, model_type, parent_id, created_at, updated_at, client_id, client:uflow_clients(slug, name), assignee:uflow_users!uflow_projects_assigned_to_fkey(id, name, email), creator:uflow_users!uflow_projects_created_by_fkey(role), references:uflow_project_references(image_url, created_at)'
    )
    .order('updated_at', { ascending: false });

  // Artists only see jobs assigned to them. Clients only see
  // their own brand's. Admins see everything.
  //
  // The client branch is not decoration: requireApiUser() with no
  // argument admits ANY authenticated user, so without it a
  // logged-in client calling this endpoint received every brand's
  // jobs. The SSR dashboard and /api/client/projects were both
  // scoped correctly; this one was the gap.
  if (auth.role === '3d_artist') {
    query = query.eq('assigned_to', auth.userId);
  } else if (auth.role === 'client') {
    if (!auth.clientId) {
      return NextResponse.json(
        {
          error:
            'Your account is not linked to a client brand. Contact an admin.',
        },
        { status: 403 }
      );
    }
    query = query.eq('client_id', auth.clientId);
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
    // Classification set on the Create Job form. Both optional and
    // nullable — a job may be created before anyone has decided
    // what it is or how hard it'll be.
    complexity?: unknown;
    category?: unknown;
    reference_image_urls?: unknown;
    // Hierarchy. 'parent' (the default) is a standalone model;
    // 'child' is derived from an existing job and must name it.
    model_type?: unknown;
    parent_id?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { client_slug, slug, name, assigned_to, brief } = body;

  // Validate the two classification fields against the shared
  // vocabulary in lib/job-options. We reject an unrecognised
  // value rather than coercing it to null: a bad value here means
  // the caller and the option list have drifted, and swallowing
  // it would lose data silently. null/undefined stay null — the
  // DB CHECK constraints allow NULL.
  const rawComplexity = body.complexity;
  const rawCategory = body.category;

  let complexity: JobComplexity | null = null;
  if (rawComplexity != null && rawComplexity !== '') {
    if (!isJobComplexity(rawComplexity)) {
      return NextResponse.json(
        { error: 'Invalid complexity value.' },
        { status: 400 }
      );
    }
    complexity = rawComplexity;
  }

  let category: JobCategory | null = null;
  if (rawCategory != null && rawCategory !== '') {
    if (!isJobCategory(rawCategory)) {
      return NextResponse.json(
        { error: 'Invalid category value.' },
        { status: 400 }
      );
    }
    category = rawCategory;
  }

  // ----- Hierarchy -----
  // Anything that isn't the literal string 'child' is treated as
  // a parent. That's the safe default: a malformed value produces
  // a standalone job rather than a dangling link.
  const modelType: 'parent' | 'child' =
    body.model_type === 'child' ? 'child' : 'parent';

  let parentId: string | null = null;
  if (modelType === 'child') {
    const raw =
      typeof body.parent_id === 'string' ? body.parent_id.trim() : '';
    if (!raw) {
      return NextResponse.json(
        { error: 'A child model must name its parent.' },
        { status: 400 }
      );
    }
    parentId = raw;
  }

  if (!client_slug || !slug || !name) {
    return NextResponse.json(
      { error: 'client_slug, slug, name required.' },
      { status: 400 }
    );
  }
  // assigned_to is OPTIONAL now. When omitted (or null), the
  // project lands in YTA — the admin (or a colleague) can
  // allocate it later via the Job Allocation tab. When present,
  // we still validate it points at a real 3D artist.

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

  // ----- Verify the parent -----
  // Two rules, each rejected with its own message so the admin
  // knows which one they hit:
  //   1. it has to exist
  //   2. it can't itself be a child. The hierarchy is one level
  //      deep; grandchildren would make "show me this model's
  //      family" a recursive query for no gain.
  //
  // There is deliberately NO same-client rule. A child records
  // where a model was derived from, and that lineage can cross
  // brands — the same chassis re-skinned for another client is
  // the case this feature exists for. The child's own client_id
  // (set from client_slug above) is what governs storage paths
  // and who can see it; parent_id is a reference, not ownership.
  if (parentId) {
    const { data: parent, error: parentErr } = await supabase()
      .from('uflow_projects')
      .select('id, name, model_type')
      .eq('id', parentId)
      .maybeSingle();
    if (parentErr || !parent) {
      return NextResponse.json(
        { error: 'Parent model not found.' },
        { status: 400 }
      );
    }
    if (parent.model_type === 'child') {
      return NextResponse.json(
        {
          error: `"${parent.name}" is itself a child model. Pick a parent instead.`,
        },
        { status: 400 }
      );
    }
  }

  // Verify the assignee exists and is a 3D artist — only when
  // one was provided. Null/undefined means "assign later" and
  // bypasses this check.
  if (assigned_to) {
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
        // Coerce undefined → null so the column is explicitly
        // unassigned when the admin picked "Assign later".
        assigned_to: assigned_to ?? null,
        brief: brief?.trim() || null,
        complexity,
        category,
        model_type: modelType,
        parent_id: parentId,
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

  // ----- No variant row -----
  // Jobs used to get a primary uflow_project_variants row here,
  // because since the 2026-08-06 migration that row — not this
  // one — held the authoritative status, revision count and
  // asset URLs.
  //
  // The 2026-08-29 migration reversed that: primary state was
  // copied back onto uflow_projects, extra colourways became
  // their own child jobs, and the variants table was emptied.
  // Every pipeline route and every roll-up helper falls back to
  // the project-level path when a job has no variant rows, so
  // creating one now would be the only variant row in the
  // database and would quietly take over as the state holder for
  // this job alone.
  //
  // A model derived from another one is created as its own job
  // with model_type='child', not as a sub-row.

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
