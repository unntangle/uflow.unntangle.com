import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// GET  /api/projects/:id/variants  → list variants for a product
// POST /api/projects/:id/variants  → add a colour variant
//   body: { name: 'Grey', slug?: 'grey' }
//
// A variant is a colourway of one product. Dashboards show a
// single row per product; each variant runs the nine-state
// machine independently, so Grey can be approved while Black is
// still in IQA.
//
// Reference images are NOT per-variant — they hang off the
// product (uflow_project_references) and are uploaded in one shot
// at creation time. Nothing here touches them.
// ============================================================

// Slugify a display name: lowercase, non-alphanumerics collapsed
// to single hyphens, trimmed. "Light Grey / 2" → "light-grey-2".
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // Scope check mirrors the references route: artists only see
  // products they're on, clients only their own brand.
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select('id, assigned_to, client_id')
    .eq('id', id)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (auth.role === '3d_artist') {
    // An artist may hold only SOME variants of a product, so we
    // can't gate on the project's assigned_to alone — check for
    // any variant assigned to them too.
    const { data: mine } = await supabase()
      .from('uflow_project_variants')
      .select('id')
      .eq('project_id', id)
      .eq('assigned_to', auth.userId)
      .limit(1);
    if (project.assigned_to !== auth.userId && !(mine && mine.length)) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
  } else if (auth.role === 'client') {
    if (!auth.clientId || project.client_id !== auth.clientId) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
  }

  const { data, error } = await supabase()
    .from('uflow_project_variants')
    .select(
      'id, name, slug, status, revision_count, feedback_seen_revision, zip_url, glb_url, approved_glb_url, assigned_to, is_primary, position, created_at, updated_at'
    )
    .eq('project_id', id)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[variants.list]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ variants: data ?? [] });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: { name?: string; slug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  if (!name) {
    return NextResponse.json(
      { error: 'A variant name is required.' },
      { status: 400 }
    );
  }
  const slug = slugify(body.slug?.trim() || name);
  if (!slug) {
    return NextResponse.json(
      { error: 'That name has no usable letters or numbers for a slug.' },
      { status: 400 }
    );
  }

  // ----- Parent must exist -----
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select('id, slug, name, status, assigned_to')
    .eq('id', id)
    .maybeSingle();
  if (pErr || !project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }

  // ----- Inherit the artist -----
  // Default is the artist already on this product. We read it off
  // the PRIMARY variant first (post-migration that's the
  // authoritative holder of per-model state) and fall back to the
  // project's own column for safety. Null is fine — the variant
  // then lands unassigned and can be allocated later.
  const { data: siblings, error: sErr } = await supabase()
    .from('uflow_project_variants')
    .select('slug, position, assigned_to, is_primary, status')
    .eq('project_id', id);
  if (sErr) {
    console.error('[variants.create.siblings]', sErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  const existing = siblings ?? [];
  if (existing.some((v) => v.slug === slug)) {
    return NextResponse.json(
      { error: `This product already has a "${slug}" variant.` },
      { status: 409 }
    );
  }

  const primary = existing.find((v) => v.is_primary);
  const inheritedArtist =
    primary?.assigned_to ?? project.assigned_to ?? null;

  // ----- Inherit the stage -----
  // A new colourway on a product that's already underway is more
  // work in progress, not a fresh draft. Starting it at 'draft'
  // pulled the whole product back into YTS, which misrepresented
  // a job the artist is actively building.
  //
  // It can't inherit verbatim, though: qa_pending, client_review
  // and approved all mean "a GLB exists and is under review", and
  // this variant has no model yet. Those clamp to 'wip' — the
  // artist has something to build, and the upload path takes it
  // to qa_pending from there.
  //
  // Rejected states clamp to their matching WIP flavour for the
  // same reason: there's no feedback attached to a variant that
  // has never been submitted.
  //
  // 'draft' is preserved so a colourway added to a job nobody has
  // started still needs its Start click, same as the original.
  const primaryStatus = primary?.status ?? project.status ?? 'draft';
  const inheritedStatus =
    primaryStatus === 'draft'
      ? 'draft'
      : primaryStatus === 'wip' ||
        primaryStatus === 'iqa_wip' ||
        primaryStatus === 'eqa_wip'
      ? primaryStatus
      : 'wip';

  // Append to the end of the QA switcher order.
  const nextPosition = existing.reduce(
    (max, v) => Math.max(max, v.position ?? 0),
    0
  ) + 1;

  // ----- Insert -----
  // Status inherited from the primary (clamped above) so adding a
  // colourway doesn't drag the product backwards in the pipeline.
  // Asset URLs stay null: the artist uploads a separate zip per
  // variant regardless of which stage it starts at.
  const { data: created, error: cErr } = await supabase()
    .from('uflow_project_variants')
    .insert({
      project_id: id,
      name,
      slug,
      status: inheritedStatus,
      revision_count: 0,
      feedback_seen_revision: 0,
      assigned_to: inheritedArtist,
      is_primary: false,
      position: nextPosition,
      created_by: auth.userId,
    })
    .select(
      'id, name, slug, status, assigned_to, is_primary, position, created_at'
    )
    .single();

  if (cErr || !created) {
    // 23505 = unique_violation, i.e. a concurrent request took
    // this slug between our check above and the insert.
    if ((cErr as { code?: string } | null)?.code === '23505') {
      return NextResponse.json(
        { error: `This product already has a "${slug}" variant.` },
        { status: 409 }
      );
    }
    console.error('[variants.create]', cErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, variant: created }, { status: 201 });
}
