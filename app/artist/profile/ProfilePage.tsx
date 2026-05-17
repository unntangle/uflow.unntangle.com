'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../components/Sidebar';
import { crmFetch } from '../../lib/client-fetch';

// ============================================================
// ProfilePage
//
// Single-section account screen. The artist can see their core
// account info (email, role, member-since) and edit their
// display name. Password change deliberately isn't here —
// admin-issued passwords are the source of truth; an artist who
// forgets their password contacts an admin to reset it.
//
// Email is intentionally not editable here either; that's an
// admin operation since email is the login identity.
// ============================================================

type ArtistProfile = {
  id: string;
  email: string;
  name: string;
  role: '3d_artist';
  // Optional: the DB might be unreachable when the server page
  // renders, in which case we just hide the "member since" row
  // instead of crashing.
  created_at: string | null;
};

export default function ProfilePage({
  currentUser,
}: {
  currentUser: ArtistProfile;
}) {
  const router = useRouter();

  // ----- Name edit state -----
  const [name, setName] = useState(currentUser.name);
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [nameOk, setNameOk] = useState<string | null>(null);

  // Snapshot the name at edit-start so Cancel restores it.
  // We deliberately don't reset to the server value — the user
  // might have submitted earlier in the session, in which case
  // the current state IS the server value.
  const [nameBeforeEdit, setNameBeforeEdit] = useState(currentUser.name);

  async function saveName() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameErr('Name cannot be empty.');
      return;
    }
    if (trimmed === nameBeforeEdit) {
      // No-op save — exit edit mode without a server round-trip.
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setNameErr(null);
    setNameOk(null);
    try {
      const res = await crmFetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNameErr(data.error || 'Could not update name.');
        return;
      }
      setName(trimmed);
      setNameBeforeEdit(trimmed);
      setEditingName(false);
      setNameOk('Name updated.');
      // Refresh the server tree so the sidebar (which reads
      // `currentUser.name` from the server component) picks up
      // the new value on the next render.
      router.refresh();
    } catch (e) {
      setNameErr((e as Error).message);
    } finally {
      setSavingName(false);
    }
  }

  function cancelEditName() {
    setName(nameBeforeEdit);
    setEditingName(false);
    setNameErr(null);
  }

  // ----- Render -----
  const memberSince = currentUser.created_at
    ? new Date(currentUser.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  return (
    <div className="crm-shell">
      <Sidebar name={name} role={currentUser.role} />
      <main className="crm-main">
        <div className="crm-page" style={{ maxWidth: 720 }}>
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">My Profile</h1>
              <p className="crm-page-sub">
                Your account details. You can update your display name here.
                If you need to change your email or password, contact your admin.
              </p>
            </div>
          </header>

          {/* ============ Account info card ============ */}
          <section
            style={{
              marginTop: 16,
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '20px 24px',
              background: 'var(--surface)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16 }}>Account</h2>

            <ReadOnlyRow label="Email" value={currentUser.email} />
            <ReadOnlyRow label="Role" value="3D Artist" />
            {memberSince && (
              <ReadOnlyRow label="Member since" value={memberSince} />
            )}

            {/* ---- Name (editable) ---- */}
            <div style={{ marginTop: 16 }}>
              <label className="crm-label">Display name</label>

              {editingName ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    className="crm-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={savingName}
                    maxLength={80}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="crm-btn"
                    onClick={saveName}
                    disabled={savingName}
                  >
                    {savingName ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    className="crm-btn crm-btn-secondary"
                    onClick={cancelEditName}
                    disabled={savingName}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span style={{ fontSize: 14 }}>{name}</span>
                  <button
                    className="crm-btn crm-btn-secondary"
                    onClick={() => {
                      setNameBeforeEdit(name);
                      setEditingName(true);
                      setNameOk(null);
                    }}
                  >
                    Edit
                  </button>
                </div>
              )}

              {nameErr && (
                <div className="crm-error" style={{ marginTop: 8 }}>
                  {nameErr}
                </div>
              )}
              {nameOk && !editingName && (
                <div
                  style={{
                    marginTop: 8,
                    color: 'var(--success, #16a34a)',
                    fontSize: 13,
                  }}
                >
                  {nameOk}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// Read-only row — label on the left, value on the right.
//
// Used for the three info fields (email, role, member-since)
// that the artist can see but not change. Kept tight (8px
// vertical gap) so the card feels like one cohesive block
// rather than a list of widgets.
// ============================================================
function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--border-faint, transparent)',
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ fontSize: 14 }}>{value}</span>
    </div>
  );
}
