import { requireUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import ClientsPage from './ClientsPage';

// ============================================================
// Clients section
// /admin/clients
//
// Manage client USERS (people with role='client' who log in to
// the client dashboard at /client). NOT the same as client
// BRANDS (uflow_clients table) — those represent companies like
// OfficeMate. Every client user is linked to exactly one brand.
//
// The page has two tabs:
//   - "All clients" — read-only list of existing client users
//   - "Add client"   — creation form (requires picking a brand)
//
// Brands are loaded server-side too so the form's brand <select>
// has the options on first paint.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Clients',
};

type ClientUserRow = {
  id: string;
  email: string;
  name: string;
  client_id: string | null;
  created_at: string;
};

type BrandRow = {
  id: string;
  slug: string;
  name: string;
};

export default async function Page() {
  const user = await requireUser('admin');

  // Fetch in parallel: existing client users (joined with their
  // brand name) + the full brand list for the create-form dropdown.
  const [{ data: clientUsers }, { data: brands }] = await Promise.all([
    supabase()
      .from('uflow_users')
      .select('id, email, name, client_id, created_at')
      .eq('role', 'client')
      .order('created_at', { ascending: false }),
    supabase()
      .from('uflow_clients')
      .select('id, slug, name')
      .order('name'),
  ]);

  return (
    <ClientsPage
      initialClients={(clientUsers as ClientUserRow[]) ?? []}
      brands={(brands as BrandRow[]) ?? []}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
