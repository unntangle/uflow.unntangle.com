// ============================================================
// crmFetch / crmPath — make URLs work both locally and on
// the crm.unntangle.com subdomain.
//
// Why this exists:
//   In production on the subdomain, the middleware rewrites
//     crm.unntangle.com/anything → /crm/anything
//   so the browser can use clean root-relative paths.
//
//   But locally we hit localhost:3000/crm/login directly (no
//   subdomain), so the middleware's host check doesn't fire.
//   A fetch to /api/auth/login is a 404 — the actual route is
//   /crm/api/auth/login. Same problem for client-side router
//   pushes to /artist (real path: /crm/artist).
//
// Resolution:
//   Detect from window.location.pathname whether we're under
//   /crm/* (local dev) and prefix paths accordingly. On the
//   real subdomain the pathname doesn't start with /crm, so
//   the call passes through untouched.
// ============================================================

export function crmPath(path: string): string {
  if (typeof window === 'undefined') return path;
  if (!path.startsWith('/')) return path;
  const onCrmPrefix = window.location.pathname.startsWith('/crm');
  if (onCrmPrefix && !path.startsWith('/crm')) {
    return `/crm${path}`;
  }
  return path;
}

export function crmFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(crmPath(input), init);
}
