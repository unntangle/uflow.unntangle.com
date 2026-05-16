import { NextResponse } from 'next/server';
import { requireApiUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// GET /api/clients
//
// Lists all client brands (uflow_clients rows). Admin-only —
// used by the admin sidebar's "client selector" dropdown and by
// the "Create client user" form to pick which brand the new
// client user belongs to.
//
// Not exposed to artists or clients themselves: artists don't
// need to know the brand of jobs they're working on (they're
// already scoped via assigned_to), and clients are locked to
// their own brand via the session.
// ============================================================
export async function GET() {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await supabase()
    .from('uflow_clients')
    .select('id, slug, name')
    .order('name');

  if (error) {
    console.error('[clients.list]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ clients: data });
}
