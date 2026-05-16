import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { requireApiUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';

export const runtime = 'nodejs'; // bcrypt needs Node

// ============================================================
// GET /api/users?role=3d_artist&role=client
// Lists users for assignment + management dropdowns. Admin-only.
// `role` query param is optional; can be repeated for multiple
// roles (e.g. ?role=3d_artist&role=client).
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  // getAll because the UI sometimes wants two roles at once
  // (e.g. an admin browsing the Users page filters by both).
  const roles = req.nextUrl.searchParams.getAll('role');

  let q = supabase()
    .from('uflow_users')
    .select('id, email, name, role, client_id, created_at')
    .order('created_at', { ascending: false });

  if (roles.length === 1) {
    q = q.eq('role', roles[0]);
  } else if (roles.length > 1) {
    q = q.in('role', roles);
  }

  const { data, error } = await q;
  if (error) {
    console.error('[users.list]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ users: data });
}

// ============================================================
// POST /api/users
// Body: { email, name, password, role? = '3d_artist', client_id? }
// Admin-only. Creates a new user of any role:
//   '3d_artist' — default; not scoped to any client
//   'admin'     — no client scoping
//   'client'    — client_id is required (links user to one brand)
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  let body: {
    email?: string;
    name?: string;
    password?: string;
    role?: string;
    client_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const email = body.email?.toLowerCase().trim();
  const name = body.name?.trim();
  const password = body.password;
  const role = body.role || '3d_artist';
  const clientId = body.client_id?.trim() || null;

  if (!email || !name || !password) {
    return NextResponse.json(
      { error: 'email, name, password required.' },
      { status: 400 }
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: 'Invalid email format.' },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters.' },
      { status: 400 }
    );
  }
  if (role !== '3d_artist' && role !== 'admin' && role !== 'client') {
    return NextResponse.json(
      { error: "role must be '3d_artist', 'admin', or 'client'." },
      { status: 400 }
    );
  }

  // Client role MUST have a client_id; non-client roles MUST NOT.
  // The DB column is nullable so an admin can't accidentally pin
  // a non-client user to a brand, but we enforce the matching
  // contract here so the API surface is explicit.
  if (role === 'client' && !clientId) {
    return NextResponse.json(
      { error: "role 'client' requires client_id." },
      { status: 400 }
    );
  }
  if (role !== 'client' && clientId) {
    return NextResponse.json(
      { error: 'client_id is only valid when role is "client".' },
      { status: 400 }
    );
  }

  // If we have a client_id, verify it exists — a dangling FK would
  // be ON DELETE SET NULL'd by the DB, but we'd rather catch this
  // up-front so the admin sees a clear error.
  if (clientId) {
    const { data: client } = await supabase()
      .from('uflow_clients')
      .select('id')
      .eq('id', clientId)
      .maybeSingle();
    if (!client) {
      return NextResponse.json(
        { error: 'Unknown client_id.' },
        { status: 400 }
      );
    }
  }

  const password_hash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase()
    .from('uflow_users')
    .insert({ email, name, password_hash, role, client_id: clientId })
    .select('id, email, name, role, client_id, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A user with email "${email}" already exists.` },
        { status: 409 }
      );
    }
    console.error('[users.create]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ user: data });
}
