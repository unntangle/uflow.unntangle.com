// ============================================================
// Session — signed JWT cookie
// ============================================================
// We don't want a full auth library (NextAuth, Lucia, etc) for
// this small internal CRM. Instead we issue a signed JWT,
// store it in an httpOnly cookie, and verify it on every
// protected route.
//
// Cookie name: 'crm_session'
// Lifetime: 7 days
// Signing: HS256 with CRM_SESSION_SECRET (any 32+ char string)
// ============================================================

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'crm_session';
const ONE_WEEK_SECONDS = 60 * 60 * 24 * 7;

export type SessionPayload = {
  userId: string;
  email: string;
  name: string;
  role: '3d_artist' | 'admin' | 'client';
  // Only present on 'client' role sessions — the client brand this
  // user is scoped to. Used by every /api/client/* route to filter
  // queries to the user's own brand without trusting client input.
  clientId?: string;
};

function getSecret(): Uint8Array {
  const secret = process.env.CRM_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'CRM_SESSION_SECRET env var missing or too short (min 16 chars). ' +
      'See app/crm/SETUP.md.'
    );
  }
  return new TextEncoder().encode(secret);
}

// ============================================================
// Sign a new session and set the cookie.
// ============================================================
export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getSecret());

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_WEEK_SECONDS,
  });
}

// ============================================================
// Read the current session, or null if not logged in / invalid.
// Safe to call from any server component or route handler.
// ============================================================
export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecret());
    // jose returns payload as an unknown JWTPayload shape — we trust
    // it because we signed it ourselves with our secret.
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as SessionPayload['role'],
      clientId: payload.clientId as string | undefined,
    };
  } catch {
    // Signature mismatch, expired, malformed — treat as logged out.
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}
