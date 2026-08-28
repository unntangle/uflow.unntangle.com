import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// GET  /api/projects/:id/variants  → list variants (legacy)
// POST /api/projects/:id/variants  → RETIRED (410)
// ============================================================
//
// Colour variants used to be sub-rows of a product: one job row
// on every dashboard, with each colourway running the pipeline
// independently underneath it.
//
// That's gone as of migrations/2026-08-29_promote_variants_to_
// child_jobs.sql. Every extra colourway was promoted to a real
// job in uflow_projects with model_type='child' and a parent_id
// pointing at the model it came from, and the variants table
// was emptied.
//
// The GET is kept because it's harmless and returns [] against
// the emptied table — any caller still asking gets an honest
// "no variants" rather than a 404 it has to special-case.
//
// The POST is a live 410 rather than a deleted file. Every
// pipeline route and every roll-up helper in lib/variant-status
// falls through to its project-level path only while a job has
// NO variant rows; a single new row would silently take over as
// that job's state holder and desync it from every dashboard.
// So this endpoint has to actively refuse, not merely go unused.
// ============================================================

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
    if (project.assigned_to !== auth.userId) {
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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params;
  return NextResponse.json(
    {
      error:
        'Colour variants have been replaced by parent/child jobs. Create the model as its own job, then set its parent from Jobs → Change Type.',
    },
    { status: 410 }
  );
}
