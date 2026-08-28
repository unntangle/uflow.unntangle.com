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
import { toWebpAll } from '../../../lib/image-to-webp';

// ============================================================
// Types
// ============================================================
type Client = { slug: string; name: string };
type Artist = { id: string; name: string; email: string };
// An existing job that a new CHILD can be hung off. Only jobs
// that are themselves parents are eligible — the hierarchy is
// one level deep.
type ParentOption = {
  id: string;
  name: string;
  slug: string;
  client_slug: string;
  client_name: string;
};

type ModelType = 'parent' | 'child';

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
  parentOptions,
  currentUser,
}: {
  clients: Client[];
  artists: Artist[];
  parentOptions: ParentOption[];
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
  // Where this job sits in the hierarchy.
  //
  // 'parent' is a standalone model — the default, and what every
  // job created before this feature is.
  // 'child' is a model derived from an existing one; it names its
  // parent below. A child is still a FULL job: its own slug, its
  // own artist, its own zip, its own QA cycle. parent_id is a
  // grouping link, not a shared pipeline.
  const [modelType, setModelType] = useState<ModelType>('parent');
  const [parentId, setParentId] = useState<string>('');
  const [refs, setRefs] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<
    'idle' | 'optimizing' | 'uploading-refs' | 'creating'
  >('idle');
  const [err, setErr] = useState<string | null>(null);
  // Last successfully created job. Kept on screen so the admin
  // gets confirmation without leaving the form — creating jobs is
  // usually a batch activity, and bouncing to the Overview after
  // each one meant navigating back every time.
  const [created, setCreated] = useState<{
    id: string;
    name: string;
    slug: string;
    warning?: string;
  } | null>(null);

  function addRefs(picked: FileList | File[]) {
    const arr = Array.from(picked).filter((f) => /^image\//.test(f.type));
    setRefs((prev) => [...prev, ...arr]);
  }
  function removeRefAt(i: number) {
    setRefs((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Every job that isn't itself a child is a candidate, whatever
  // client it belongs to — the page query already filtered out
  // children, so there's nothing left to narrow here. Switching
  // the Client dropdown deliberately does NOT change this list or
  // clear a selection: lineage can cross brands.
  function changeClient(next: string) {
    setClientSlug(next);
  }

  // Flipping back to Parent drops any selection, so a job can
  // never be submitted as a parent while still carrying a
  // parent_id (the DB has a CHECK constraint for exactly that).
  function changeModelType(next: ModelType) {
    setModelType(next);
    if (next === 'parent') setParentId('');
  }

  async function submit() {
    setErr(null);
    setCreated(null);
    // assignedTo is allowed to be the ASSIGN_LATER sentinel —
    // unlike before, the admin doesn't have to pick an artist.
    // We only require the human-typed fields.
    if (!name.trim() || !slug.trim() || !clientSlug) {
      setErr('Fill in all required fields.');
      return;
    }
    // A child with no parent is meaningless, and the DB would
    // reject it anyway — catch it here so the admin gets a
    // sentence instead of a 400.
    if (modelType === 'child' && !parentId) {
      setErr('Pick the parent model this child belongs to.');
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
        // Re-encode to WebP first. `files` is used for BOTH the
        // content_types sent to the sign endpoint and the PUT
        // bodies below — those two must describe the same bytes,
        // or R2 rejects the upload on a signature mismatch.
        setStage('optimizing');
        const files = await toWebpAll(refs);

        setStage('uploading-refs');
        const signRes = await crmFetch('/api/references-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_slug: clientSlug,
            project_slug: slug,
            count: files.length,
            // Tell the server each file's MIME so it can sign
            // matching Content-Types. The browser must then send
            // the same header on the PUT or R2 rejects the request.
            content_types: files.map(
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
          files.map(async (f, i) => {
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
          // Hierarchy. parent_id is only ever sent for a child;
          // a parent sends null explicitly so the server can't
          // read a stale value from anywhere.
          model_type: modelType,
          parent_id: modelType === 'child' ? parentId : null,
          reference_image_urls: referenceUrls,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed to create job.');
        return;
      }

      // Stay put. Reset only the per-job fields — name, brief and
      // references — and deliberately KEEP client, model type,
      // parent, category, complexity and artist. Those are the
      // fields that repeat when adding several related models in
      // a row (e.g. four children under one parent), so clearing
      // them would mean re-picking the same six values each time.
      setCreated({
        id: data.project?.id,
        name: data.project?.name ?? name,
        slug: data.project?.slug ?? slug,
        warning: data.warning,
      });
      setName('');
      setSlug('');
      setBrief('');
      setRefs([]);

      // Re-runs the server component so the Parent model dropdown
      // picks up the job just created — without this, a new
      // parent wouldn't be selectable until a manual reload.
      router.refresh();

      // Put the cursor back where the next job starts.
      document.getElementById('job-name-input')?.focus();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setStage('idle');
    }
  }

  const stageLabel =
    stage === 'optimizing' ? 'Optimising images…' :
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
            {/* Confirmation for the job just created. Sits at the
                top of the card so it's visible without scrolling
                back up, and clears the moment another submit
                starts so it can never describe a stale result. */}
            {created && (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid var(--success, #16a34a)',
                  borderRadius: 8,
                  padding: '10px 14px',
                  marginBottom: 16,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  Created <strong>{created.name}</strong>{' '}
                  <span style={{ color: 'var(--text-faint)' }}>
                    ({created.slug})
                  </span>
                  . Ready for the next one.
                </span>
                <span style={{ flex: 1 }} />
                <a
                  className="crm-link"
                  onClick={() => router.push(crmPath('/admin'))}
                  style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  Go to Overview
                </a>
                <button
                  type="button"
                  onClick={() => setCreated(null)}
                  aria-label="Dismiss"
                  title="Dismiss"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'inherit',
                    font: 'inherit',
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </div>
            )}
            {created?.warning && (
              <div className="crm-error" style={{ marginBottom: 16 }}>
                {created.warning}
              </div>
            )}

            <div className="crm-form-group">
              <label className="crm-label">Client</label>
              <select
                className="crm-input"
                value={clientSlug}
                onChange={(e) => changeClient(e.target.value)}
                disabled={busy}
              >
                {clients.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.name}</option>
                ))}
              </select>
            </div>

            {/*
              Name comes before Model type: you decide WHAT the
              model is before deciding where it sits in the
              hierarchy, and the Parent dropdown that follows only
              makes sense once the thing being parented has a name.
            */}
            <div className="crm-form-group">
              <label className="crm-label">3D Model name</label>
              <input
                id="job-name-input"
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
              <label className="crm-label">Model type</label>
              <select
                className="crm-input"
                value={modelType}
                onChange={(e) =>
                  changeModelType(e.target.value as ModelType)
                }
                disabled={busy}
              >
                <option value="parent">Parent — a standalone model</option>
                <option value="child">
                  Child — derived from an existing model
                </option>
              </select>
              <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '6px 0 0' }}>
                A child is a full job in its own right — its own
                brief, artist, upload and QA cycle. Choosing a parent
                only records where it came from.
              </p>
            </div>

            {/*
              Only rendered on the Child branch. Keeping it out of
              the DOM (rather than disabling it) means a parent job
              can't leave a stale selection behind in the payload.
            */}
            {modelType === 'child' && (
              <div className="crm-form-group">
                <label className="crm-label">Parent model</label>
                <select
                  className="crm-input"
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                  disabled={busy || parentOptions.length === 0}
                >
                  <option value="">Select a parent model…</option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {/* The client is only worth naming when it
                          isn't the one already selected above —
                          otherwise every row carries the same
                          redundant suffix. */}
                      {p.client_name && p.client_slug !== clientSlug
                        ? `${p.name} — ${p.client_name}`
                        : p.name}
                    </option>
                  ))}
                </select>
                {parentOptions.length === 0 && (
                  <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '6px 0 0' }}>
                    No parent models found. Either there are no jobs
                    yet, or the 2026-08-28 parent/child migration
                    hasn&rsquo;t been run against the database.
                  </p>
                )}
              </div>
            )}

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
                disabled={
                  busy ||
                  !name ||
                  !slug ||
                  !clientSlug ||
                  (modelType === 'child' && !parentId)
                }
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
