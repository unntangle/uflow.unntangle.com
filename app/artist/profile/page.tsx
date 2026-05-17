import { requireUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import ProfilePage from './ProfilePage';

// ============================================================
// Artist profile page
// /artist/profile
//
// Self-service account screen for the 3D artist. Renders the
// caller's name / email / role / member-since plus a form to
// change name and password. Email is read-only here — changing
// it belongs to admin (it's the login identity).
//
// Auth: '3d_artist' role only. Admins land on their own
// dashboard automatically via requireUser; admins editing a
// specific artist account use the existing User Management UI.
// ============================================================

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'My Profile',
};

export default async function ArtistProfilePage() {
  const user = await requireUser('3d_artist');

  // Fetch the full row so we can show 'member since' alongside
  // what's already in the JWT. Done server-side so the initial
  // paint already has the data — no spinner on first load.
  const { data } = await supabase()
    .from('uflow_users')
    .select('id, email, name, role, created_at')
    .eq('id', user.userId)
    .maybeSingle();

  return (
    <ProfilePage
      currentUser={{
        id: user.userId,
        email: user.email,
        name: user.name,
        role: '3d_artist',
        created_at: data?.created_at ?? null,
      }}
    />
  );
}
