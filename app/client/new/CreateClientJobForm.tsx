'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../components/Sidebar';
import { crmFetch, crmPath } from '../../lib/client-fetch';

// ============================================================
// Types
// ============================================================
type Brand = { id: string; slug: string; name: string };

// ============================================================
// CreateClientJobForm
//
// Mirrors the admin's CreateJobForm but stripped down to what
// a client should be able to do:
//   - Set name (slug is derived)
//   - Write a brief
//   - Upload reference images
//
// Removed:
//   - Client picker (locked to user.clientId server-side; brand
//     prop is passed in only so we can show its name + use its
//     slug for R2 reference upload paths)
//   - Artist picker (admin allocates later via Job Allocation tab)
//
// Submission flow:
//   1. (optional) Sign + PUT reference images to R2 via
//      /api/references-sign, scoped to the client's own brand
//   2. POST /api/client/projects with the resulting URLs
//   3. Navigate back to /client and refresh
// ============================================================
export default function CreateClientJobForm({
  brand,
  currentUser,
}: {
  brand: Brand;
  currentUser: { name: string; role: 'client' };
}) {
  const router = useRouter();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [brief, setBrief] = useState('');
  const [refs, setRefs] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'uploading-refs' | 'creating'>(
    'idle'
  );
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
    if (!name.trim() || !slug.trim()) {
      setErr('Fill in the project name.');
      return;
    }
    if (!brand.slug) {
      setErr('Brand information is missing. Contact your admin.');
      return;
    }

    setBusy(true);
    try {
      // ---- 1. Upload reference images (if any) ----
      let referenceUrls: string[] = [];
      if (refs.length > 0) {
        setStage('uploading-refs');
        const signRes = await crmFetch('/api/references-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Use the brand's slug \u2014 the server verifies this matches
            // the JWT's clientId, so a client can only sign uploads
            // for their own brand.
            client_slug: brand.slug,
            project_slug: slug,
            count: refs.length,
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
                `Upload failed for ${f.name} (${r.status}).`
              );
            }
            return item.public_url as string;
          })
        );
      }

      // ---- 2. Create the project ----
      // Note: we do NOT send client_slug / assigned_to \u2014 the server
      // derives client_id from auth.clientId and sets assigned_to=null.
      setStage('creating');
      const res = await crmFetch('/api/client/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          name,
          brief: brief.trim() || undefined,
          reference_image_urls: referenceUrls,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed to create job.');
        return;
      }
      router.push(crmPath('/client'));
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setStage('idle');
    }
  }

  const stageLabel =
    stage === 'uploading-refs'
      ? 'Uploading references…'
      : stage === 'creating'
      ? 'Creating job…'
      : 'Create job';

  return (
    <div className="crm-shell">
      <Sidebar
        name={currentUser.name}
        role={currentUser.role}
        brandName={brand.name}
      />

      <main className="crm-main">
        <div className="crm-page" style={{ maxWidth: 720 }}>
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Create Job</h1>
              <p className="crm-page-sub">
                {brand.name} · Request a new 3D modelling job. Our team will
                allocate it to an artist.
              </p>
            </div>
            <button
              className="crm-btn crm-btn-secondary"
              onClick={() => router.push(crmPath('/client'))}
              disabled={busy}
            >
              Cancel
            </button>
          </header>

          <div className="crm-card">
            <div className="crm-form-group">
              <label className="crm-label">3D Model name</label>
              <input
                className="crm-input"
                placeholder="e.g. Mars Desk"
                value={name}
                onChange={(e) => {
                  const v = e.target.value;
                  setName(v);
                  setSlug(
                    v
                      .toLowerCase()
                      .replace(/[^a-z0-9-]+/g, '-')
                      .replace(/^-+|-+$/g, '')
                  );
                }}
                disabled={busy}
              />
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
                      <button onClick={() => removeRefAt(i)} aria-label="Remove">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
                onClick={() => router.push(crmPath('/client'))}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="crm-btn"
                onClick={submit}
                disabled={busy || !name || !slug}
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
