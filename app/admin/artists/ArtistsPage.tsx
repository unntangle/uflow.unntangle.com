'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Sidebar from '../../components/Sidebar';
import { crmFetch, crmPath } from '../../lib/client-fetch';

// ============================================================
// Types
// ============================================================
type Artist = {
  id: string;
  email: string;
  name: string;
  created_at: string;
};

// ============================================================
// ArtistsPage
// Two tabs:
//   - "All artists": list of existing 3D artists
//   - "Add artist":  the creation form (lifted from the old
//                    /admin/artists/new route).
//
// We use ?tab=add to deep-link into the form (e.g. from an
// empty-state CTA) without needing a separate route.
// ============================================================
export default function ArtistsPage({
  initialArtists,
  currentUser,
}: {
  initialArtists: Artist[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [artists, setArtists] = useState<Artist[]>(initialArtists);

  type Tab = 'list' | 'add';
  const tabParam = searchParams?.get('tab');
  const initialTab: Tab = tabParam === 'add' ? 'add' : 'list';
  const [tab, setTab] = useState<Tab>(initialTab);

  // ---- Add-artist form state ----
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function resetForm() {
    setEmail('');
    setName('');
    setPassword('');
    setErr(null);
  }

  async function submit() {
    setErr(null);
    if (!email.trim() || !name.trim() || password.length < 8) {
      setErr('Fill in all fields. Password must be at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      const res = await crmFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, password, role: '3d_artist' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed.');
        return;
      }
      // Insert the new artist at the top of the list locally so the
      // user can see the result immediately, then swap to the list
      // tab. router.refresh() makes sure other pages (assignment
      // dropdowns, etc.) pick up the new artist on next render.
      if (data.user) {
        setArtists((prev) => [data.user, ...prev]);
      }
      resetForm();
      setTab('list');
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Artists</h1>
              <p className="crm-page-sub">
                Manage 3D artists who can be assigned to jobs.
              </p>
            </div>
          </header>

          {/* ============================== Tab bar ============================== */}
          <div className="crm-tabs" role="tablist" aria-label="Artists">
            <button
              role="tab"
              aria-selected={tab === 'list'}
              className={`crm-tab ${tab === 'list' ? 'is-active' : ''}`}
              onClick={() => setTab('list')}
            >
              All artists
              <span className="crm-tab-count">{artists.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'add'}
              className={`crm-tab ${tab === 'add' ? 'is-active' : ''}`}
              onClick={() => setTab('add')}
            >
              Add artist
            </button>
          </div>

          {/* ============================== All artists ============================== */}
          {tab === 'list' && (
            artists.length === 0 ? (
              <div className="crm-empty">
                <h3>No artists yet</h3>
                <p>Add a 3D artist to start assigning jobs.</p>
                <button
                  className="crm-btn"
                  style={{ marginTop: 12 }}
                  onClick={() => setTab('add')}
                >
                  Add artist
                </button>
              </div>
            ) : (
              <table className="crm-table">
                <thead>
                  <tr>
                    <th style={{ width: '30%' }}>Name</th>
                    <th>Email</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {artists.map((a) => (
                    <tr key={a.id}>
                      <td><strong>{a.name}</strong></td>
                      <td style={{ color: 'var(--text-dim)' }}>{a.email}</td>
                      <td style={{ color: 'var(--text-dim)' }}>
                        {new Date(a.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* ============================== Add artist ============================== */}
          {tab === 'add' && (
            <div className="crm-card" style={{ maxWidth: 560 }}>
              <div className="crm-form-group">
                <label className="crm-label">Name</label>
                <input
                  className="crm-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  disabled={busy}
                />
              </div>

              <div className="crm-form-group">
                <label className="crm-label">Email</label>
                <input
                  className="crm-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@studio.com"
                  disabled={busy}
                />
              </div>

              <div className="crm-form-group">
                <label className="crm-label">Temporary password</label>
                <input
                  className="crm-input"
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  disabled={busy}
                />
                <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '6px 0 0' }}>
                  Share this with the artist. They can sign in with it; password
                  change isn&apos;t built in yet — update via Supabase if needed.
                </p>
              </div>

              {err && <div className="crm-error">{err}</div>}

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                  marginTop: 16,
                }}
              >
                <button
                  className="crm-btn crm-btn-secondary"
                  onClick={() => {
                    resetForm();
                    setTab('list');
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  className="crm-btn"
                  onClick={submit}
                  disabled={busy || !email || !name || password.length < 8}
                >
                  {busy ? 'Creating…' : 'Create artist'}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
