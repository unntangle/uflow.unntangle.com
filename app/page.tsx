import { redirect } from 'next/navigation';
import { getSession } from './lib/session';
import { dashboardPathFor } from './lib/auth';

// ============================================================
// Root CRM route. Decides where to send the visitor:
//  - logged out → /login
//  - 3d_artist → /artist
//  - admin     → /admin
// ============================================================

export default async function CrmRootPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  redirect(dashboardPathFor(session.role));
}
