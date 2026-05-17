'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pencil, Trash2, Plus } from 'lucide-react';
import Sidebar from '../../components/Sidebar';
import { crmFetch } from '../../lib/client-fetch';

// ============================================================
// Types & Utilities
// ============================================================

const ADJECTIVES = ['Neon', 'Cosmic', 'Solar', 'Lunar', 'Velvet', 'Crimson', 'Azure', 'Golden', 'Silver', 'Crystal', 'Magic', 'Epic', 'Bold', 'Bright', 'Rapid', 'Silent', 'Mighty', 'Brave', 'Clever', 'Swift'];
const NOUNS = ['Tiger', 'Dragon', 'Phoenix', 'Eagle', 'Wolf', 'Bear', 'Lion', 'Hawk', 'Falcon', 'Panther', 'Rocket', 'Comet', 'Planet', 'Star', 'Galaxy', 'River', 'Mountain', 'Ocean', 'Forest', 'Storm'];

function generateReadablePassword() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(10 + Math.random() * 90); // 2 digits
  return `${adj}${noun}${num}!`;
}
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

  const [showAddModal, setShowAddModal] = useState(false);

  // ---- Quick lookup: brand id → name.
  const brandById = useMemo(() => {
    const m = new Map<string, Brand>();
    for (const b of brands) m.set(b.id, b);
    return m;
  }, [brands]);

  // ---- Add-client form state ----
  const [email, setEmail] = useState('');
  const [emailAuto, setEmailAuto] = useState(true);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [brandId, setBrandId] = useState<string>(brands[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ---- Edit modal state ----
  const [editTarget, setEditTarget] = useState<ClientUser | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  // ---- Delete confirm state ----
  const [deleteTarget, setDeleteTarget] = useState<ClientUser | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  function resetForm() {
    setEmail('');
    setEmailAuto(true);
    setName('');
    setPassword('');
    setBrandId(brands[0]?.id ?? '');
    setErr(null);
  }

  function openEdit(c: ClientUser) {
    setEditTarget(c);
    setEditName(c.name);
    setEditEmail(c.email);
    setEditPassword('');
    setEditErr(null);
  }

  function closeEdit() {
    setEditTarget(null);
    setEditErr(null);
  }

  async function submitEdit() {
    if (!editTarget) return;
    setEditErr(null);
    if (!editName.trim() || !editEmail.trim()) {
      setEditErr('Name and email are required.');
      return;
    }
    if (editPassword && editPassword.length < 8) {
      setEditErr('New password must be at least 8 characters.');
      return;
    }
    setEditBusy(true);
    try {
      const body: Record<string, string> = {
        id: editTarget.id,
        name: editName.trim(),
        email: editEmail.trim(),
      };
      if (editPassword) body.password = editPassword;

      const res = await crmFetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setEditErr(data.error || 'Failed to update.');
        return;
      }
      setClients((prev) =>
        prev.map((c) =>
          c.id === editTarget.id
            ? { ...c, name: data.user.name, email: data.user.email }
            : c
        )
      );
      closeEdit();
      router.refresh();
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteErr(null);
    setDeleteBusy(true);
    try {
      const res = await crmFetch('/api/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDeleteErr(data.error || 'Failed to delete.');
        return;
      }
      setClients((prev) => prev.filter((c) => c.id !== deleteTarget.id));
      setDeleteTarget(null);
      router.refresh();
    } catch (e) {
      setDeleteErr((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
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
      setShowAddModal(false);
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
          <header className="crm-page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 className="crm-page-title">Clients</h1>
              <p className="crm-page-sub">
                Manage client users who can log in to their own brand&apos;s
                dashboard and create jobs.
              </p>
            </div>
            <button
              className="crm-btn crm-btn-secondary crm-btn-icon"
              style={{ padding: '6px 12px', fontSize: 13 }}
              onClick={() => setShowAddModal(true)}
            >
              <Plus size={14} strokeWidth={2.5} />
              <span>Add client</span>
            </button>
          </header>

          {/* ============================== All clients ============================== */}
          {clients.length === 0 ? (
            <div className="crm-empty">
              <h3>No clients yet</h3>
              <p>Add a client user to give a brand its own login.</p>
              <button
                className="crm-btn"
                style={{ marginTop: 12 }}
                onClick={() => setShowAddModal(true)}
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
                  <th style={{ width: '80px' }}>S.no</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Brand</th>
                  <th>Joined</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                  {clients.map((c, index) => {
                    const b = c.client_id ? brandById.get(c.client_id) : null;
                    return (
                      <tr key={c.id}>
                        <td style={{ color: 'var(--text-dim)' }}>{index + 1}</td>
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
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="crm-btn crm-btn-ghost crm-btn-icon"
                              title="Edit client"
                              onClick={() => openEdit(c)}
                            >
                              <Pencil size={14} strokeWidth={1.75} />
                              <span>Edit</span>
                            </button>
                            <button
                              className="crm-btn crm-btn-ghost-danger crm-btn-icon"
                              title="Delete client"
                              onClick={() => {
                                setDeleteErr(null);
                                setDeleteTarget(c);
                              }}
                            >
                              <Trash2 size={14} strokeWidth={1.75} />
                              <span>Delete</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          )}

      {/* ============================== Add modal ============================== */}
      {showAddModal && (
        <div className="crm-modal-backdrop" onClick={() => {
          if (!busy) {
            resetForm();
            setShowAddModal(false);
          }
        }}>
          <div className="crm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="crm-modal-header">
              <h2 className="crm-modal-title">Add client user</h2>
              <button
                className="crm-modal-close"
                onClick={() => {
                  resetForm();
                  setShowAddModal(false);
                }}
                disabled={busy}
              >
                ×
              </button>
            </div>

            {brands.length === 0 ? (
              <div className="crm-empty" style={{ minHeight: 'auto', padding: 32 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>No client brands yet</h3>
                <p style={{ margin: '8px 0 0', color: 'var(--text-dim)', fontSize: 14 }}>
                  You need to create a brand in the <code>uflow_clients</code>{' '}
                  table (via Supabase) before you can add a client user.
                </p>
              </div>
            ) : (
              <>
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
                    onChange={(e) => {
                      const newName = e.target.value;
                      setName(newName);
                      if (emailAuto) {
                        const prefix = newName.toLowerCase().replace(/[^a-z0-9]/g, '');
                        setEmail(prefix ? `${prefix}@unntangle.com` : '');
                      }
                    }}
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
                    readOnly
                    style={{ backgroundColor: 'var(--surface-2)', cursor: 'not-allowed' }}
                    placeholder="alexbuyer@unntangle.com"
                    disabled={busy}
                  />
                </div>

                <div className="crm-form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label className="crm-label" style={{ margin: 0 }}>Temporary password</label>
                    <button
                      type="button"
                      onClick={() => {
                        setPassword(generateReadablePassword());
                      }}
                      className="crm-btn-ghost"
                      style={{ fontSize: 11, padding: '2px 6px', height: 'auto', minHeight: 'auto', color: 'var(--text-dim)' }}
                    >
                      Auto-generate
                    </button>
                  </div>
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
                    their email and this password. You can update it later using the Edit button.
                  </p>
                </div>

                {err && <div className="crm-error" style={{ marginTop: 8 }}>{err}</div>}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                  <button
                    className="crm-btn crm-btn-secondary"
                    onClick={() => {
                      resetForm();
                      setShowAddModal(false);
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    className="crm-btn"
                    onClick={submit}
                    disabled={busy || !email || !name || password.length < 8 || !brandId}
                  >
                    {busy ? 'Creating…' : 'Create client'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
        </div>
      </main>

      {/* ============================== Edit modal ============================== */}
      {editTarget && (
        <div className="crm-modal-backdrop" onClick={closeEdit}>
          <div className="crm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="crm-modal-header">
              <div>
                <h2 className="crm-modal-title">Edit client user</h2>
                <p style={{ margin: '4px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>
                  {editTarget.email}
                </p>
              </div>
              <button className="crm-modal-close" onClick={closeEdit}>×</button>
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Name</label>
              <input
                className="crm-input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                disabled={editBusy}
                placeholder="Full name"
              />
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Email</label>
              <input
                className="crm-input"
                type="email"
                value={editEmail}
                readOnly
                style={{ backgroundColor: 'var(--surface-2)', cursor: 'not-allowed' }}
                placeholder="email@example.com"
                disabled={editBusy}
              />
            </div>

            <div className="crm-form-group">
              <label className="crm-label">New password <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(leave blank to keep current)</span></label>
              <input
                className="crm-input"
                type="text"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                disabled={editBusy}
                placeholder="At least 8 characters"
              />
            </div>

            {editErr && <div className="crm-error" style={{ marginTop: 8 }}>{editErr}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="crm-btn crm-btn-secondary" onClick={closeEdit} disabled={editBusy}>
                Cancel
              </button>
              <button className="crm-btn" onClick={submitEdit} disabled={editBusy}>
                {editBusy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================== Delete confirm modal ============================== */}
      {deleteTarget && (
        <div className="crm-modal-backdrop" onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <div className="crm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="crm-modal-header">
              <h2 className="crm-modal-title">Delete client user?</h2>
              <button className="crm-modal-close" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>×</button>
            </div>

            <p style={{ margin: '0 0 8px', fontSize: 14 }}>
              Are you sure you want to permanently delete{' '}
              <strong>{deleteTarget.name}</strong>?
            </p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)' }}>
              Their login access will be immediately revoked. Note: This only deletes
              the user account, not the underlying client brand.
            </p>

            {deleteErr && <div className="crm-error" style={{ marginTop: 12 }}>{deleteErr}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                className="crm-btn crm-btn-secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteBusy}
              >
                Cancel
              </button>
              <button
                className="crm-btn crm-btn-danger"
                onClick={confirmDelete}
                disabled={deleteBusy}
              >
                {deleteBusy ? 'Deleting…' : 'Yes, delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
