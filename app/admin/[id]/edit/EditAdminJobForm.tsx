'use client';

import { useEffect, useState } from 'react';
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

// An existing reference row already saved on the server. The
// user can mark it for removal (toggling its id into
// removedRefIds) but can't change its URL.
type ExistingRef = { id: string; image_url: string };

// A colourway of this product, as returned by
// GET /api/projects/:id/variants. Each runs its own QA cycle, so
// it carries its own status and revision count.
type Variant = {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  revision_count: number;
  is_primary: boolean;
  position: number;
};

// ============================================================
// EditAdminJobForm
//
// Admin-facing edit form. Edits:
//   - name  : freely editable, required (non-empty).
//   - brief : freely editable, optional (clears to null).
//   - reference images : add new ones (signed + uploaded to R2)
//                        and/or remove existing ones. Admins own
//                        the job, so references are editable at
//                        ANY status (the PATCH enforces this).
//   - slug  : READ-ONLY. It's the R2 path prefix and the public
//             viewer URL segment; changing it would orphan every
//             uploaded asset and break the published model link.
//
// Reference upload mirrors the client edit form exactly: sign N
// PUT URLs via /api/references-sign (which accepts admin for any
// brand), PUT the files to R2, then PATCH /api/projects/[id]
// with the resulting public URLs + the ids being removed.
// ============================================================
export default function EditAdminJobForm({
  project,
  clientName,
  brandSlug,
  initialReferences,
  currentUser,
}: {
  project: ProjectLite;
  clientName: string;
  brandSlug: string;
  initialReferences: ExistingRef[];
  currentUser: { name: string; role: 'admin' };
}) {
  const router = useRouter();

  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState(project.brief ?? '');

  // Two-bucket reference state (same shape as the client form):
  //   existingRefs   : already-saved rows; X toggles removal.
  //   removedRefIds  : ids marked for removal this session.
  //   newRefs        : files picked this session, not yet uploaded.
  const [existingRefs] = useState<ExistingRef[]>(initialReferences);
  const [removedRefIds, setRemovedRefIds] = useState<Set<string>>(new Set());
  const [newRefs, setNewRefs] = useState<File[]>([]);

  const [busy, setBusy] = useState(false);

  // ---- Variants ----
  // Unlike everything else on this form, variants are managed
  // LIVE rather than on Save: the job already exists, so a new
  // colourway can be POSTed straight away. Deferring them would
  // mean an admin could add a variant, hit Cancel, and be unsure
  // whether it landed.
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const [variantDraft, setVariantDraft] = useState('');
  const [addingVariant, setAddingVariant] = useState(false);
  const [variantErr, setVariantErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    crmFetch(`/api/projects/${project.id}/variants`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setVariants(d.variants ?? []);
      })
      .catch(() => {
        // Most likely the variants migration hasn't been run yet.
        // An empty list degrades to "no variants" rather than
        // breaking the whole edit form.
        if (!cancelled) setVariants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  async function addVariant() {
    const variantName = variantDraft.trim();
    if (!variantName || addingVariant) return;
    setVariantErr(null);
    setAddingVariant(true);
    try {
      const res = await crmFetch(`/api/projects/${project.id}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: variantName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setVariantErr(data.error || 'Could not add the variant.');
        return;
      }
      setVariants((prev) => [...(prev ?? []), data.variant as Variant]);
      setVariantDraft('');
    } catch (e) {
      setVariantErr((e as Error).message || 'Network error.');
    } finally {
      setAddingVariant(false);
    }
  }

  const [stage, setStage] = useState<'idle' | 'uploading-refs' | 'saving'>(
    'idle'
  );
  const [err, setErr] = useState<string | null>(null);

  function addNewRefs(picked: FileList | File[]) {
    const arr = Array.from(picked).filter((f) => /^image\//.test(f.type));
    setNewRefs((prev) => [...prev, ...arr]);
  }
  function removeNewRefAt(i: number) {
    setNewRefs((prev) => prev.filter((_, idx) => idx !== i));
  }
  function toggleExistingRefRemoval(id: string) {
    setRemovedRefIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Dirty check so Save is disabled when nothing has changed —
  // covers name, brief (with the same empty -> null normalisation
  // the PATCH applies), and any reference add/remove.
  const briefChanged = (brief.trim() || null) !== (project.brief ?? null);
  const nameChanged = name.trim() !== project.name;
  const refsChanged = newRefs.length > 0 || removedRefIds.size > 0;
  const dirty = nameChanged || briefChanged || refsChanged;

  async function submit() {
    setErr(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr('Fill in the project name.');
      return;
    }

    setBusy(true);
    try {
      // ---- 1. Upload any newly added reference images ----
      // Signed + PUT to R2 under <brandSlug>/<projectSlug>/references/
      // using the project's existing slug. references-sign accepts
      // admin for any brand.
      let addUrls: string[] = [];
      if (newRefs.length > 0) {
        setStage('uploading-refs');
        const signRes = await crmFetch('/api/references-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_slug: brandSlug,
            project_slug: project.slug,
            count: newRefs.length,
            content_types: newRefs.map(
              (f) => f.type || 'application/octet-stream'
            ),
          }),
        });
        const signData = await signRes.json();
        if (!signRes.ok) {
          setErr(signData.error || 'Could not sign reference uploads.');
          return;
        }

        addUrls = await Promise.all(
          newRefs.map(async (f, i) => {
            const item = signData.signed[i];
            const r = await fetch(item.upload_url, {
              method: 'PUT',
              headers: { 'Content-Type': item.content_type },
              body: f,
            });
            if (!r.ok) {
              const text = await r.text().catch(() => '');
              throw new Error(
                `Upload failed for ${f.name} (${r.status})${
                  text ? `: ${text.slice(0, 200)}` : ''
                }`
              );
            }
            return item.public_url as string;
          })
        );
      }

      // ---- 2. PATCH the project ----
      setStage('saving');
      const body: Record<string, unknown> = {
        name: trimmedName,
        brief: brief.trim() || null,
      };
      if (addUrls.length > 0) body.add_reference_image_urls = addUrls;
      if (removedRefIds.size > 0) {
        body.remove_reference_ids = Array.from(removedRefIds);
      }

      const res = await crmFetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed to save changes.');
        return;
      }
      router.push(crmPath('/admin/jobs/list'));
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
      : stage === 'saving'
      ? 'Saving changes…'
      : 'Save changes';

  const visibleExistingCount = existingRefs.length - removedRefIds.size;
  const totalRefsAfter = visibleExistingCount + newRefs.length;

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page" style={{ maxWidth: 720 }}>
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Edit Job</h1>
              <p className="crm-page-sub">
                {clientName} · Update the job name, brief, or reference
                images. The slug is locked once a job is created.
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

            {/* Slug stays read-only — it's the R2 path prefix and
                the public viewer URL segment, so changing it would
                orphan uploaded assets and break the published link. */}
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
                The slug is locked once a job is created. It&apos;s used in
                the asset storage paths and the public model URL.
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

            {/* Reference images — add new (sign + PUT to R2) and/or
                mark existing ones for removal. */}
            <div className="crm-form-group">
              <label className="crm-label">Reference images</label>
              <div
                className="crm-dropzone"
                onClick={() => document.getElementById('ref-input')?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addNewRefs(e.dataTransfer.files);
                }}
              >
                <input
                  id="ref-input"
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    if (e.target.files) addNewRefs(e.target.files);
                    e.target.value = '';
                  }}
                />
                <strong>Click or drop reference photos</strong>
                <div className="crm-dropzone-hint">
                  PNG/JPG/WebP. Visible to the assigned artist.
                </div>
              </div>

              {(existingRefs.length > 0 || newRefs.length > 0) && (
                <>
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 12,
                      color: 'var(--text-dim)',
                    }}
                  >
                    {totalRefsAfter} reference{totalRefsAfter === 1 ? '' : 's'}{' '}
                    after save
                    {removedRefIds.size > 0 && (
                      <> · {removedRefIds.size} marked for removal</>
                    )}
                  </div>

                  <div className="crm-feedback-grid">
                    {existingRefs.map((r) => {
                      const marked = removedRefIds.has(r.id);
                      return (
                        <div
                          key={r.id}
                          className="crm-feedback-thumb"
                          style={{
                            opacity: marked ? 0.35 : 1,
                            outline: marked
                              ? '2px dashed var(--danger)'
                              : 'none',
                            outlineOffset: '-2px',
                            transition: 'opacity 0.15s',
                          }}
                          title={
                            marked
                              ? 'Marked for removal — click ↩ to undo'
                              : ''
                          }
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={r.image_url} alt="reference" />
                          <button
                            onClick={() => toggleExistingRefRemoval(r.id)}
                            aria-label={
                              marked ? 'Undo remove' : 'Mark for removal'
                            }
                            disabled={busy}
                            title={marked ? 'Undo' : 'Remove'}
                          >
                            {marked ? '↩' : '×'}
                          </button>
                        </div>
                      );
                    })}

                    {newRefs.map((f, i) => (
                      <div key={`new-${i}`} className="crm-feedback-thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={URL.createObjectURL(f)} alt={f.name} />
                        <button
                          onClick={() => removeNewRefAt(i)}
                          aria-label="Remove"
                          disabled={busy}
                          title="Remove (not yet uploaded)"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {err && <div className="crm-error">{err}</div>}

            {/* ---- Variants ----
                Saved immediately on Add, independently of the
                Save changes button below, because the product
                already exists and the API can take the write now. */}
            <div className="crm-form-group" style={{ marginTop: 24 }}>
              <label className="crm-label">Variants</label>
              <p
                style={{
                  color: 'var(--text-dim)',
                  fontSize: 12,
                  margin: '0 0 8px',
                }}
              >
                Colourways of this product. Each needs its own zip from the
                artist and is approved on its own, but they all stay under this
                one job and share the reference images above. Added variants
                save straight away — no need to press Save changes.
              </p>

              {variants === null ? (
                <p
                  style={{
                    color: 'var(--text-dim)',
                    fontSize: 13,
                    margin: 0,
                  }}
                >
                  Loading…
                </p>
              ) : (
                <>
                  {variants.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginBottom: 10,
                      }}
                    >
                      {variants.map((v) => (
                        <span
                          key={v.id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            border: '1px solid var(--border)',
                            borderRadius: 999,
                            padding: '4px 10px',
                            fontSize: 13,
                          }}
                          title={
                            v.is_primary
                              ? 'The original colourway'
                              : `Variant · ${v.slug}`
                          }
                        >
                          <strong style={{ fontWeight: 600 }}>{v.name}</strong>
                          <StatusBadge
                            status={v.status}
                            revisionCount={v.revision_count}
                            assigned
                          />
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="crm-input"
                      placeholder="e.g. Grey"
                      value={variantDraft}
                      disabled={addingVariant}
                      onChange={(e) => setVariantDraft(e.target.value)}
                      onKeyDown={(e) => {
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
                      disabled={addingVariant || !variantDraft.trim()}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {addingVariant ? 'Adding…' : 'Add variant'}
                    </button>
                  </div>

                  {variantErr && (
                    <div className="crm-error" style={{ marginTop: 10 }}>
                      {variantErr}
                    </div>
                  )}
                </>
              )}
            </div>

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
                {busy ? stageLabel : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
