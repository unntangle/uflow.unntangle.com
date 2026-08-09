'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import { crmFetch, crmPath } from '../../../lib/client-fetch';
import {
  COMPLEXITY_OPTIONS,
  CATEGORY_OPTIONS,
  UNSET,
} from '../../../lib/job-options';

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
  // "__unassigned__" is a UI sentinel for the "Assign later" choice
  // — a UUID can never look like this, so we can safely test for
  // it without false positives. On submit we translate it into
  // assigned_to: null in the API payload, which puts the new job
  // into YTA so it shows up under Job Allocation.
  // We default to the sentinel rather than the first artist so an
  // admin can spin up a placeholder without thinking about who
  // it'll end up with; they (or a colleague) can allocate it from
  // the Job Allocation tab later.
  const ASSIGN_LATER = '__unassigned__';
  const [assignedTo, setAssignedTo] = useState<string>(ASSIGN_LATER);
  const [brief, setBrief] = useState('');
  // Classification fields. Both start UNSET (empty string) rather
  // than pre-selecting the first option — defaulting to 'Easy' /
  // 'Sofa' would quietly attach a value the admin never chose,
  // and "unclassified" is more honest than "wrong". Empty is
  // translated to null in the payload; the column is nullable.
  const [complexity, setComplexity] = useState<string>(UNSET);
  const [category, setCategory] = useState<string>(UNSET);
  // Colourway names to create alongside the product, e.g.
  // ['Grey', 'Navy']. The product always gets an 'Original'
  // primary variant server-side, so this list is the EXTRAS only
  // — leaving it empty gives the same single-model job as before.
  // Each one becomes its own QA cycle needing its own zip, but
  // they all share this job's reference images.
  const [variants, setVariants] = useState<string[]>([]);
  const [variantDraft, setVariantDraft] = useState('');
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

  // Commit the typed variant name. Compares on the slugified form
  // so "Light Grey" and "light grey" are caught as the same thing
  // here rather than being silently dropped by the server's
  // de-dupe.
  function addVariant() {
    const name = variantDraft.trim();
    if (!name) return;
    const key = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (key(name) === 'original') {
      setVariantDraft('');
      return;
    }
    setVariants((prev) =>
      prev.some((v) => key(v) === key(name)) ? prev : [...prev, name]
    );
    setVariantDraft('');
  }
  function removeVariantAt(i: number) {
    setVariants((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    setErr(null);
    // assignedTo is allowed to be the ASSIGN_LATER sentinel —
    // unlike before, the admin doesn't have to pick an artist.
    // We only require the human-typed fields.
    if (!name.trim() || !slug.trim() || !clientSlug) {
      setErr('Fill in all required fields.');
      return;
    }
    // "No artists yet" is no longer a blocker now that an admin
    // can choose Assign Later — they can create the job and let a
    // newly-added artist pick it up. We leave the message hint
    // visible in the form but don't fail the submit.

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
          // Translate the sentinel into a real null so the server
          // sees an explicit "assign later" instead of "the admin
          // forgot the field". The server's POST handler accepts
          // null and stores it as-is, landing the row in YTA.
          assigned_to:
            assignedTo === ASSIGN_LATER ? null : assignedTo,
          brief: brief.trim() || undefined,
          // Send null (not undefined) when left unset so the
          // server records an explicit "not classified" instead
          // of treating the field as missing.
          complexity: complexity || null,
          category: category || null,
          // Extra colourways. The server always creates the
          // 'Original' primary variant, so this carries only the
          // additional ones.
          variants,
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
              <label className="crm-label">Category</label>
              <select
                className="crm-input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={busy}
              >
                <option value={UNSET}>Select a category…</option>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Complexity</label>
              <select
                className="crm-input"
                value={complexity}
                onChange={(e) => setComplexity(e.target.value)}
                disabled={busy}
              >
                <option value={UNSET}>Select a complexity…</option>
                {COMPLEXITY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '6px 0 0' }}>
                Rough modelling effort. Both fields can be changed later
                from Edit Job.
              </p>
            </div>

            <div className="crm-form-group">
              <label className="crm-label">Assign to artist</label>
              <select
                className="crm-input"
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
              >
                {/* Default option — sends the job to YTA so an admin
                    can allocate later from the Job Allocation tab.
                    Visually distinct (italic) so it doesn't look
                    like a real artist name. */}
                <option value={ASSIGN_LATER}>
                  Assign later — send to YTA
                </option>
                {artists.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.email})
                  </option>
                ))}
              </select>
              {artists.length === 0 && (
                <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '6px 0 0' }}>
                  No artists yet — the job will go to YTA. You can
                  add an artist and allocate from the Job Allocation
                  tab anytime.
                </p>
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
              <label className="crm-label">Variants (optional)</label>
              <p
                style={{
                  color: 'var(--text-dim)',
                  fontSize: 12,
                  margin: '0 0 8px',
                }}
              >
                Colourways of the same product — add &ldquo;Grey&rdquo; and the
                artist delivers a separate zip for it, reviewed and approved on
                its own. Everything stays under one row on the dashboard and
                shares the reference images below. Added colourways sit here as
                chips until you create the job — click the × on one to drop it.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="crm-input"
                  placeholder="e.g. Grey"
                  value={variantDraft}
                  onChange={(e) => setVariantDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter adds the chip rather than submitting the
                    // whole form, which would create the job early.
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addVariant();
                    }
                  }}
                />
                <button
                  type="button"
                  className="crm-btn crm-btn-secondary"
                  onClick={addVariant}
                  disabled={!variantDraft.trim()}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  Add variant
                </button>
              </div>

              {variants.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: 10,
                  }}
                >
                  {variants.map((v, i) => (
                    <span
                      key={v}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        border: '1px dashed var(--border)',
                        borderRadius: 999,
                        padding: '4px 10px',
                        fontSize: 13,
                      }}
                      title="Will be created when you press Create job"
                    >
                      <strong style={{ fontWeight: 600 }}>{v}</strong>
                      <button
                        type="button"
                        onClick={() => removeVariantAt(i)}
                        disabled={busy}
                        aria-label={`Remove ${v}`}
                        title="Remove"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: busy ? 'not-allowed' : 'pointer',
                          color: 'inherit',
                          font: 'inherit',
                          lineHeight: 1,
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
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
                disabled={busy || !name || !slug || !clientSlug}
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
