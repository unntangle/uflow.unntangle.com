import { requireUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import ArtistsPage from './ArtistsPage';

// ============================================================
// Artists section
// /admin/artists
//
// Replaces the old /admin/artists/new route. The page has two
// tabs: "All artists" (read-only list) and "Add artist" (the
// creation form, formerly its own route).
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Artists',
};

type ArtistRow = {
  id: string;
  email: string;
  name: string;
  created_at: string;
};

export default async function Page() {
  const user = await requireUser('admin');

  // List 3D artists, newest first. We do this server-side rather
  // than hitting /api/users so the initial paint already has data.
  const { data: artists } = await supabase()
    .from('uflow_users')
    .select('id, email, name, created_at')
    .eq('role', '3d_artist')
    .order('created_at', { ascending: false });

  return (
    <ArtistsPage
      initialArtists={(artists as ArtistRow[]) ?? []}
      currentUser={{ name: user.name, role: user.role as 'admin' }}
    />
  );
}
