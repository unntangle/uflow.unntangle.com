import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '../../../lib/supabase';

// ============================================================
// GET /api/public/model?client=officemate&slug=jupiter
// Returns the latest APPROVED glb URL for a given client/project.
//
// Public (no auth). Used by officemate.unntangle.com to render
// the latest approved version of each model.
// ============================================================

export const runtime = 'nodejs';
export const revalidate = 60; // cache for 60s at the edge

export async function GET(req: NextRequest) {
  const client = req.nextUrl.searchParams.get('client');
  const slug = req.nextUrl.searchParams.get('slug');
  if (!client || !slug) {
    return NextResponse.json(
      { error: 'client and slug query params required.' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase()
    .from('uflow_projects')
    .select(
      'name, status, approved_glb_url, updated_at, client:uflow_clients!inner(slug)'
    )
    .eq('slug', slug)
    .eq('status', 'approved')
    .eq('uflow_clients.slug', client)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!data || !data.approved_glb_url) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(
    {
      name: data.name,
      glb_url: data.approved_glb_url,
      updated_at: data.updated_at,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    }
  );
}
