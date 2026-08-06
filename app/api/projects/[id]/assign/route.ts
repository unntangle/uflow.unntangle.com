import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// PATCH /api/projects/:id/assign
// Body: { assigned_to: string }   // user id of a 3d_artist
// Admin-only. Reassigns the project to a different artist.
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: { assigned_to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { assigned_to } = body;
  if (!assigned_to) {
    return NextResponse.json(
      { error: 'assigned_to required.' },
      { status: 400 }
    );
  }

  // Verify target user is an artist.
  const { data: target, error: tErr } = await supabase()
    .from('uflow_users')
    .select('id, role')
    .eq('id', assigned_to)
    .maybeSingle();
  if (tErr || !target) {
    return NextResponse.json({ error: 'User not found.' }, { status: 400 });
  }
  if (target.role !== '3d_artist') {
    return NextResponse.json(
      { error: 'Can only reassign to a 3D artist.' },
      { status: 400 }
    );
  }

  // Read the current holder so we only reset the feedback marker
  // on an actual change of artist. Re-assigning to the same person
  // shouldn't wipe what they've already read.
  const { data: current } = await supabase()
    .from('uflow_projects')
    .select('assigned_to')
    .eq('id', id)
    .maybeSingle();

  const changingArtist = current?.assigned_to !== assigned_to;

  const { data, error } = await supabase()
    .from('uflow_projects')
    .update({
      assigned_to,
      updated_at: new Date().toISOString(),
      // feedback_seen_revision means "the assigned artist has
      // opened the feedback gallery for this rejection round".
      // It lives on the project, not per user, so handing the job
      // to someone else would otherwise leave the incoming artist
      // inheriting the previous one's read state — the job would
      // skip their Rejected tab and they'd never be prompted to
      // read feedback they haven't seen. Resetting to 0 puts any
      // outstanding round back in their inbox.
      ...(changingArtist ? { feedback_seen_revision: 0 } : {}),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('[projects.assign]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ project: data });
}
