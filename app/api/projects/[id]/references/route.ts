import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// GET /api/projects/:id/references
// Returns reference images attached at job-creation time.
// Artists can only see references on jobs assigned to them.
// ============================================================
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // Role-based ownership checks: artists can only see refs on
  // jobs assigned to them; clients can only see refs on jobs in
  // their own brand. Admins bypass.
  if (auth.role === '3d_artist') {
    const { data: p } = await supabase()
      .from('uflow_projects')
      .select('assigned_to')
      .eq('id', id)
      .maybeSingle();
    if (!p || p.assigned_to !== auth.userId) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
  } else if (auth.role === 'client') {
    if (!auth.clientId) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    const { data: p } = await supabase()
      .from('uflow_projects')
      .select('client_id')
      .eq('id', id)
      .maybeSingle();
    if (!p || p.client_id !== auth.clientId) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
  }

  const { data, error } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[references.list]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ references: data });
}
