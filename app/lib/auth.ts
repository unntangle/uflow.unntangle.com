// ============================================================
// Auth guards — used by pages and API routes
// ============================================================

import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { getSession, SessionPayload } from './session';

// Treat legacy 'qa' role (from JWTs signed before the rename) as
// 'admin' at runtime. Keeps existing sessions valid until expiry.
function normaliseRole(role: string): SessionPayload['role'] {
  if (role === 'qa') return 'admin';
  if (role === 'admin' || role === '3d_artist' || role === 'client') {
    return role;
  }
  // Unknown role — fall back to artist (the least-privileged surface).
  return '3d_artist';
}

// ============================================================
// For SERVER COMPONENTS / PAGES
// Redirects to /login if not authenticated. Optionally enforce
// a role and redirect to the correct dashboard if mismatched.
// ============================================================
export async function requireUser(
  expectedRole?: SessionPayload['role']
): Promise<SessionPayload> {
  const raw = await getSession();
  if (!raw) {
    redirect('/login');
  }
  const session: SessionPayload = { ...raw, role: normaliseRole(raw.role) };
  if (expectedRole && session.role !== expectedRole && session.role !== 'admin') {
    // User is logged in but for the wrong dashboard — bounce them
    // to their own dashboard rather than showing "forbidden".
    redirect(dashboardPathFor(session.role));
  }
  return session;
}

// ============================================================
// For API ROUTE HANDLERS
// Returns either a session or a NextResponse to short-circuit
// the handler with 401/403. Pattern:
//
//   const auth = await requireApiUser('admin');
//   if (auth instanceof NextResponse) return auth;
//   // auth is SessionPayload from here on
// ============================================================
export async function requireApiUser(
  expectedRole?: SessionPayload['role']
): Promise<SessionPayload | NextResponse> {
  const raw = await getSession();
  if (!raw) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const session: SessionPayload = { ...raw, role: normaliseRole(raw.role) };
  if (expectedRole && session.role !== expectedRole && session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return session;
}

// ============================================================
// Role → landing page
//
// Accepts a string (not just SessionPayload['role']) because
// existing JWT cookies signed before the 'qa' → 'admin' rename
// will still carry role: 'qa' until they expire / users re-login.
// We map that legacy value to /admin so old cookies don't trigger
// a redirect loop. Anything else falls back to /artist.
// ============================================================
export function dashboardPathFor(role: string): string {
  if (role === 'admin' || role === 'qa') return '/admin';
  if (role === '3d_artist') return '/artist';
  if (role === 'client') return '/client';
  return '/artist';
}
