import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';

// ============================================================
// Self-service profile API
// ============================================================
// This route is intentionally distinct from /api/users (which is
// admin-only and lets an admin edit any account). Here a logged-
// in user — any role — can read or update *their own* account,
// gated by the session cookie alone. Nothing in the request body
// controls *which* user is updated; that always comes from the
// JWT.
//
// Endpoints:
//   GET   /api/auth/profile  → return the current user's profile
//   PATCH /api/auth/profile  → update name (the only field the
//                              self-service UI exposes)
//
// Password and email changes are intentionally NOT supported
// here. They're admin operations — done through /api/users —
// to keep credential rotation auditable and prevent a self-
// service path from bypassing admin's view of who can do what.
// The UI matches: the profile page has no password form, so
// extending this endpoint to accept a password would only add
// an unexposed attack surface.
// ============================================================

export const runtime = 'nodejs';

// ============================================================
// GET /api/auth/profile
// Returns the caller's own profile row (no password_hash).
// ============================================================
export async function GET() {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await supabase()
    .from('uflow_users')
    .select('id, email, name, role, client_id, created_at')
    .eq('id', auth.userId)
    .maybeSingle();

  if (error) {
    console.error('[profile.get]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!data) {
    // The session is signed but the user row is gone — treat as
    // unauthenticated. (Happens if an admin deletes a user whose
    // JWT hasn't expired yet.)
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  }
  return NextResponse.json({ user: data });
}

// ============================================================
// PATCH /api/auth/profile
// Body: { name }
// Updates the caller's own display name. No other fields are
// supported — see header comment.
// ============================================================
export async function PATCH(req: NextRequest) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.name !== 'string') {
    return NextResponse.json(
      { error: 'name is required.' },
      { status: 400 }
    );
  }

  const name = body.name.trim();
  if (name.length === 0) {
    return NextResponse.json(
      { error: 'Name cannot be empty.' },
      { status: 400 }
    );
  }
  if (name.length > 80) {
    return NextResponse.json(
      { error: 'Name is too long (max 80 chars).' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase()
    .from('uflow_users')
    .update({ name })
    .eq('id', auth.userId)
    .select('id, email, name, role, client_id, created_at')
    .single();

  if (error) {
    console.error('[profile.patch]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ user: data });
}
