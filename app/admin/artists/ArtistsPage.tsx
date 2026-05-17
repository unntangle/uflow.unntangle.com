'use client';

import { useState } from 'react';
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
type Artist = {
  id: string;
  email: string;
  name: string;
  created_at: string;
};

// ============================================================
// ArtistsPage
// Three tabs:
//   - "All artists": list of existing 3D artists with edit/delete
//   - "Add artist":  the creation form
//   - (inline): Edit artist (slides in on row click)
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

  const [showAddModal, setShowAddModal] = useState(false);

  // ---- Add-artist form state ----
  const [email, setEmail] = useState('');
  const [emailAuto, setEmailAuto] = useState(true);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ---- Edit modal state ----
  const [editTarget, setEditTarget] = useState<Artist | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  // ---- Delete confirm state ----
  const [deleteTarget, setDeleteTarget] = useState<Artist | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  function resetForm() {
    setEmail('');
    setEmailAuto(true);
    setName('');
    setPassword('');
    setErr(null);
  }

  function openEdit(a: Artist) {
    setEditTarget(a);
    setEditName(a.name);
    setEditEmail(a.email);
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
      setArtists((prev) =>
        prev.map((a) =>
          a.id === editTarget.id
            ? { ...a, name: data.user.name, email: data.user.email }
            : a
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
      setArtists((prev) => prev.filter((a) => a.id !== deleteTarget.id));
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
      if (data.user) {
        setArtists((prev) => [data.user, ...prev]);
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
              <h1 className="crm-page-title">Artists</h1>
              <p className="crm-page-sub">
                Manage 3D artists who can be assigned to jobs.
              </p>
            </div>
            <button
              className="crm-btn crm-btn-secondary crm-btn-icon"
              style={{ padding: '6px 12px', fontSize: 13 }}
              onClick={() => setShowAddModal(true)}
            >
              <Plus size={14} strokeWidth={2.5} />
              <span>Add artist</span>
            </button>
          </header>
          {artists.length === 0 ? (
            <div className="crm-empty">
              <h3>No artists yet</h3>
              <p>Add a 3D artist to start assigning jobs.</p>
              <button
                className="crm-btn"
                style={{ marginTop: 12 }}
                onClick={() => setShowAddModal(true)}
              >
                Add artist
              </button>
            </div>
          ) : (
            <table className="crm-table">
              <thead>
                <tr>
                  <th style={{ width: '80px' }}>S.no</th>
                  <th style={{ width: '28%' }}>Name</th>
                  <th>Email</th>
                  <th>Joined</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {artists.map((a, index) => (
                  <tr key={a.id}>
                    <td style={{ color: 'var(--text-dim)' }}>{index + 1}</td>
                    <td><strong>{a.name}</strong></td>
                    <td style={{ color: 'var(--text-dim)' }}>{a.email}</td>
                    <td style={{ color: 'var(--text-dim)' }}>
                      {new Date(a.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button
                          className="crm-btn crm-btn-ghost crm-btn-icon"
                          title="Edit artist"
                          onClick={() => openEdit(a)}
                        >
                          <Pencil size={14} strokeWidth={1.75} />
                          <span>Edit</span>
                        </button>
                        <button
                          className="crm-btn crm-btn-ghost-danger crm-btn-icon"
                          title="Delete artist"
                          onClick={() => {
                            setDeleteErr(null);
                            setDeleteTarget(a);
                          }}
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                          <span>Delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
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
              <h2 className="crm-modal-title">Add artist</h2>
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
                readOnly
                style={{ backgroundColor: 'var(--surface-2)', cursor: 'not-allowed' }}
                placeholder="janedoe@unntangle.com"
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
                Share this with the artist. They can sign in with it; you can
                update it later using the Edit button on their row.
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
                disabled={busy || !email || !name || password.length < 8}
              >
                {busy ? 'Creating…' : 'Create artist'}
              </button>
            </div>
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
                <h2 className="crm-modal-title">Edit artist</h2>
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
              <h2 className="crm-modal-title">Delete artist?</h2>
              <button className="crm-modal-close" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>×</button>
            </div>

            <p style={{ margin: '0 0 8px', fontSize: 14 }}>
              Are you sure you want to permanently delete{' '}
              <strong>{deleteTarget.name}</strong>?
            </p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)' }}>
              Their account will be removed. Any jobs currently assigned to them
              will become unassigned.
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
