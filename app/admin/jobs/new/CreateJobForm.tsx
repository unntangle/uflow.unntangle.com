'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import { crmFetch, crmPath } from '../../../lib/client-fetch';

// ============================================================
// Types
// ============================================================
type Client = { slug: string; name: string };
type Artist = { id: string; name: string; email: string };

// ============================================================
// CreateJobForm — page version of the old CreateJobModal.
//
// Flow:
//   1. Admin fills name/slug/client/artist/brief
//   2. (optional) Selects reference images. We sign N uploads via
//      /api/references-sign, upload directly to Cloudinary, then
//      collect secure_urls.
//   3. POST /api/projects with reference_image_urls in the body.
//      The server inserts the project + reference rows in one shot.
//   4. Navigate back to /admin and refresh.
// ============================================================
export default function CreateJobForm({
  clients,
  artists,
  currentUser,
}: {
  clients: Client[];
  artists: Artist[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();

  const [clientSlug, setClientSlug] = useState(clients[0]?.slug || '');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [assignedTo, setAssignedTo] = useState(artists[0]?.id || '');
  const [brief, setBrief] = useState('');
  const [refs, setRefs] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'uploading-refs' | 'creating'>('idle');
  const [err, setErr] = useState<string | null>(null);

  function addRefs(picked: FileList | File[]) {
    const arr = Array.from(picked).filter((f) => /^image\//.test(f.type));
    setRefs((prev) => [...prev, ...arr]);
  }
  function removeRefAt(i: number) {
    setRefs((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    setErr(null);
    if (!name.trim() || !slug.trim() || !clientSlug || !assignedTo) {
      setErr('Fill in all required fields.');
      return;
    }
    if (artists.length === 0) {
      setErr('No 3D artists exist yet. Add one first.');
      return;
    }

    setBusy(true);
    try {
      // ---- 1. Upload reference images (if any) directly to R2 ----
      let referenceUrls: string[] = [];
      if (refs.length > 0) {
        setStage('uploading-refs');
        const signRes = await crmFetch('/api/references-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_slug: clientSlug,
            project_slug: slug,
            count: refs.length,
            // Tell the server each file's MIME so it can sign
            // matching Content-Types. The browser must then send
            // the same header on the PUT or R2 rejects the request.
            content_types: refs.map(
              (f) => f.type || 'application/octet-stream'
            ),
          }),
        });
        const signData = await signRes.json();
        if (!signRes.ok) {
          setErr(signData.error || 'Could not sign reference uploads.');
          return;
        }

        referenceUrls = await Promise.all(
          refs.map(async (f, i) => {
            const item = signData.signed[i];
            const r = await fetch(item.upload_url, {
              method: 'PUT',
              headers: { 'Content-Type': item.content_type },
              body: f,
            });
            if (!r.ok) {
              throw new Error(
                `R2 upload failed for ${f.name} (${r.status}).`
              );
            }
            return item.public_url as string;
          })
        );
      }

      // ---- 2. Create the project (server attaches reference rows) ----
      setStage('creating');
      const res = await crmFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_slug: clientSlug,
          slug,
          name,
          assigned_to: assignedTo,
          brief: brief.trim() || undefined,
          reference_image_urls: referenceUrls,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed to create job.');
        return;
      }
      // Success — go back to the admin dashboard and refresh.
      router.push(crmPath('/admin'));
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setStage('idle');
    }
  }

  const stageLabel =
    stage === 'uploading-refs' ? 'Uploading references…' :
    stage === 'creating' ? 'Creating job…' :
    'Create job';

  return (
    <div className="crm-shell">
      {/*
        We don't pass onCreateJob here — the sidebar link should
        navigate, not re-open. This page IS the create-job surface.
      */}
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page" style={{ maxWidth: 720 }}>
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Create Job</h1>
              <p className="crm-page-sub">
                Spin up a new 3D modelling job and assign it to an artist.
              </p>
            </div>
            <button
              className="crm-btn crm-btn-secondary"
              onClick={() => router.push(crmPath('/admin'))}
              disabled={busy}
            >
              Cancel
            </button>
          </header>

          <div className="crm-card">
            <div className="crm-form-group">
              <label className="crm-label">Client</label>
              <select
                className="crm-input"
                value={clientSlug}
                onChange={(e) => setClientSlug(e.target.value)}
              >
                {clients.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="crm-form-group">
              <label className="crm-label">3D Model name</label>
              <input
                className="crm-input"
                placeholder="e.g. Mars Desk"
                value={name}
                onChange={(e) => {
                  const v = e.target.value;
                  setName(v);
                  // Always derive the slug from the current name —
                  // the field is no longer user-editable, so there's
                  // nothing to preserve when name changes.
                  setSlug(
                    v
                      .toLowerCase()
                      .replace(/[^a-z0-9-]+/g, '-')
                      .replace(/^-+|-+$/g, '')
                  );
                }}
              />
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Assign to artist</label>
              {artists.length === 0 ? (
                <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '4px 0 0' }}>
                  No artists yet — add one from the sidebar first.
                </p>
              ) : (
                <select
                  className="crm-input"
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                >
                  {artists.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.email})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Brief (optional)</label>
              <textarea
                className="crm-textarea"
                rows={3}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="What needs to be modelled? Dimensions, materials, constraints…"
              />
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Reference images (optional)</label>
              <div
                className="crm-dropzone"
                onClick={() => document.getElementById('ref-input')?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addRefs(e.dataTransfer.files);
                }}
              >
                <input
                  id="ref-input"
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    if (e.target.files) addRefs(e.target.files);
                    e.target.value = '';
                  }}
                />
                <strong>Click or drop reference photos</strong>
                <div className="crm-dropzone-hint">
                  PNG/JPG/WebP. Visible to the assigned artist.
                </div>
              </div>

              {refs.length > 0 && (
                <div className="crm-feedback-grid">
                  {refs.map((f, i) => (
                    <div key={i} className="crm-feedback-thumb">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={URL.createObjectURL(f)} alt={f.name} />
                      <button onClick={() => removeRefAt(i)} aria-label="Remove">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {err && <div className="crm-error">{err}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                className="crm-btn crm-btn-secondary"
                onClick={() => router.push(crmPath('/admin'))}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="crm-btn"
                onClick={submit}
                disabled={busy || !name || !slug || !clientSlug || !assignedTo}
              >
                {busy ? stageLabel : 'Create job'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
