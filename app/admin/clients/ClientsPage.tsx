'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Sidebar from '../../components/Sidebar';
import { crmFetch } from '../../lib/client-fetch';

// ============================================================
// Types
// ============================================================
type ClientUser = {
  id: string;
  email: string;
  name: string;
  client_id: string | null;
  created_at: string;
};

type Brand = {
  id: string;
  slug: string;
  name: string;
};

// ============================================================
// ClientsPage
//
// Same shape as ArtistsPage but with one extra wrinkle: every
// client user has to be linked to exactly one brand
// (uflow_clients row). The list shows the brand name inline
// (resolved via the brands array passed from the server); the
// create form requires picking a brand from a dropdown.
//
// If no brands exist yet we render an empty state on the form,
// because creating a client user without a brand is invalid.
// ============================================================
export default function ClientsPage({
  initialClients,
  brands,
  currentUser,
}: {
  initialClients: ClientUser[];
  brands: Brand[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [clients, setClients] = useState<ClientUser[]>(initialClients);

  type Tab = 'list' | 'add';
  const tabParam = searchParams?.get('tab');
  const initialTab: Tab = tabParam === 'add' ? 'add' : 'list';
  const [tab, setTab] = useState<Tab>(initialTab);

  // ---- Quick lookup: brand id → name. Used by the table row
  // renderer to show "OfficeMate" instead of a raw UUID.
  const brandById = useMemo(() => {
    const m = new Map<string, Brand>();
    for (const b of brands) m.set(b.id, b);
    return m;
  }, [brands]);

  // ---- Add-client form state ----
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  // Default to the first brand if any exist so the user doesn't
  // have to interact with the dropdown for a single-brand setup.
  const [brandId, setBrandId] = useState<string>(brands[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function resetForm() {
    setEmail('');
    setName('');
    setPassword('');
    setBrandId(brands[0]?.id ?? '');
    setErr(null);
  }

  async function submit() {
    setErr(null);
    if (!email.trim() || !name.trim() || password.length < 8) {
      setErr('Fill in all fields. Password must be at least 8 characters.');
      return;
    }
    if (!brandId) {
      setErr('Pick a client brand.');
      return;
    }

    setBusy(true);
    try {
      const res = await crmFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name,
          password,
          role: 'client',
          client_id: brandId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed.');
        return;
      }
      if (data.user) {
        setClients((prev) => [data.user, ...prev]);
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
              <h1 className="crm-page-title">Clients</h1>
              <p className="crm-page-sub">
                Manage client users who can log in to their own brand&apos;s
                dashboard and create jobs.
              </p>
            </div>
          </header>

          {/* ============================== Tab bar ============================== */}
          <div className="crm-tabs" role="tablist" aria-label="Clients">
            <button
              role="tab"
              aria-selected={tab === 'list'}
              className={`crm-tab ${tab === 'list' ? 'is-active' : ''}`}
              onClick={() => setTab('list')}
            >
              All clients
              <span className="crm-tab-count">{clients.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'add'}
              className={`crm-tab ${tab === 'add' ? 'is-active' : ''}`}
              onClick={() => setTab('add')}
            >
              Add client
            </button>
          </div>

          {/* ============================== All clients ============================== */}
          {tab === 'list' && (
            clients.length === 0 ? (
              <div className="crm-empty">
                <h3>No clients yet</h3>
                <p>Add a client user to give a brand its own login.</p>
                <button
                  className="crm-btn"
                  style={{ marginTop: 12 }}
                  onClick={() => setTab('add')}
                  disabled={brands.length === 0}
                  title={brands.length === 0
                    ? 'Create a client brand in the database first.'
                    : undefined}
                >
                  Add client
                </button>
              </div>
            ) : (
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Brand</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const b = c.client_id ? brandById.get(c.client_id) : null;
                    return (
                      <tr key={c.id}>
                        <td><strong>{c.name}</strong></td>
                        <td style={{ color: 'var(--text-dim)' }}>{c.email}</td>
                        <td>
                          {b ? (
                            b.name
                          ) : (
                            <em style={{ color: 'var(--text-faint)' }}>
                              no brand
                            </em>
                          )}
                        </td>
                        <td style={{ color: 'var(--text-dim)' }}>
                          {new Date(c.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}

          {/* ============================== Add client ============================== */}
          {tab === 'add' && (
            brands.length === 0 ? (
              <div className="crm-empty">
                <h3>No client brands yet</h3>
                <p>
                  You need to create a brand in the <code>uflow_clients</code>{' '}
                  table (via Supabase) before you can add a client user.
                </p>
              </div>
            ) : (
              <div className="crm-card" style={{ maxWidth: 560 }}>
                <div className="crm-form-group">
                  <label className="crm-label">Brand</label>
                  <select
                    className="crm-input"
                    value={brandId}
                    onChange={(e) => setBrandId(e.target.value)}
                    disabled={busy}
                  >
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '6px 0 0' }}>
                    The client will only see jobs belonging to this brand.
                  </p>
                </div>

                <div className="crm-form-group">
                  <label className="crm-label">Name</label>
                  <input
                    className="crm-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Alex Buyer"
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
                    placeholder="alex@officemate.com"
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
                    Share this with the client. They sign in at /login with
                    their email and this password.
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
                    disabled={
                      busy ||
                      !email ||
                      !name ||
                      password.length < 8 ||
                      !brandId
                    }
                  >
                    {busy ? 'Creating…' : 'Create client'}
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      </main>
    </div>
  );
}
