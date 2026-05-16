import { redirect } from 'next/navigation';

// ============================================================
// Legacy redirect
// /admin/artists/new used to host the standalone "Add Artist"
// form. That UI now lives as a tab inside /admin/artists, so
// this route just bounces to the right tab. Kept around so any
// old bookmarks or external links keep working.
// ============================================================

export default function Page() {
  redirect('/admin/artists?tab=add');
}
