'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
import { crmFetch, crmPath } from '../../../lib/client-fetch';
import { ProjectStatus } from '../../../lib/supabase';

// ============================================================
// Types
// ============================================================
type ProjectLite = {
  id: string;
  slug: string;
  name: string;
  brief: string | null;
  status: ProjectStatus;
};

// ============================================================
// EditAdminJobForm
//
// Admin-facing edit form for a job's display `name` and `brief`.
// Modelled on the client EditClientJobForm but trimmed to the
// fields an admin owns:
//
//   - name  : freely editable, required (non-empty).
//   - brief : freely editable, optional (clears to null).
//   - slug  : READ-ONLY. Shown so the admin can see the
//             identifier, but locked -- it's the R2 path prefix
//             and the public viewer URL segment, so changing it
//             would orphan uploaded assets and break links.
//
// Reference-image editing is intentionally left out of the admin
// edit flow: references are a client-authored artefact attached
// at job-creation time, and the admin's QA/reassign tools don't
// touch them. If that's ever needed it can be added here the
// same way the client form does it (sign -> PUT -> PATCH).
//
// On save we PATCH /api/projects/[id]. The endpoint is admin-only
// and accepts a rename at any status, so -- unlike the client
// form -- there's no draft-only guard here.
// ============================================================
export default function EditAdminJobForm({
  project,
  clientName,
  currentUser,
}: {
  project: ProjectLite;
  clientName: string;
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();

  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState(project.brief ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Dirty check so the Save button is disabled when nothing has
  // actually changed -- mirrors the per-row "dirty" guard on the
  // reassign page. Compared against the original values (with the
  // same empty-string -> null normalisation the PATCH applies to
  // brief) so reverting an edit back to the original disables the
  // button again.
  const briefChanged = (brief.trim() || null) !== (project.brief ?? null);
  const nameChanged = name.trim() !== project.name;
  const dirty = nameChanged || briefChanged;

  async function submit() {
    setErr(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr('Fill in the project name.');
      return;
    }

    setBusy(true);
    try {
      const res = await crmFetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          // Empty string -> null on the server, but we send it
          // explicitly so clearing a brief actually persists.
          brief: brief.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed to save changes.');
        return;
      }
      // Back to the List Jobs page so the renamed row shows
      // immediately. router.refresh() re-runs the server component
      // and repopulates the list with the patched row.
      router.push(crmPath('/admin/jobs/list'));
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
        <div className="crm-page" style={{ maxWidth: 720 }}>
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Edit Job</h1>
              <p className="crm-page-sub">
                {clientName} · Update the job name or brief. The slug
                is locked once a job is created.
              </p>
            </div>
            <button
              className="crm-btn crm-btn-secondary"
              onClick={() => router.push(crmPath('/admin/jobs/list'))}
              disabled={busy}
            >
              Cancel
            </button>
          </header>

          <div className="crm-card">
            {/* Current status, shown read-only so the admin has
                context for what they're editing (e.g. renaming an
                approved job vs a draft). Editing the name never
                changes status. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 16,
                fontSize: 13,
                color: 'var(--text-dim)',
              }}
            >
              <span>Current status:</span>
              <StatusBadge status={project.status} />
            </div>

            <div className="crm-form-group">
              <label className="crm-label">3D Model name</label>
              <input
                className="crm-input"
                placeholder="e.g. Jupiter Chair"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>

            {/* Slug is read-only on edit -- same reasoning as the
                client edit form. It's the R2 path prefix and the
                public viewer URL segment; changing it would orphan
                uploaded objects and break the published model link. */}
            <div className="crm-form-group">
              <label className="crm-label">Slug (read-only)</label>
              <input
                className="crm-input"
                value={project.slug}
                disabled
                readOnly
                style={{ cursor: 'not-allowed', opacity: 0.7 }}
              />
              <div
                style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: 'var(--text-faint)',
                }}
              >
                The slug is locked once a job is created. It&apos;s
                used in the asset storage paths and the public model
                URL.
              </div>
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Brief (optional)</label>
              <textarea
                className="crm-textarea"
                rows={3}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="What needs to be modelled? Dimensions, materials, constraints…"
                disabled={busy}
              />
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
                onClick={() => router.push(crmPath('/admin/jobs/list'))}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="crm-btn"
                onClick={submit}
                disabled={busy || !name.trim() || !dirty}
              >
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
