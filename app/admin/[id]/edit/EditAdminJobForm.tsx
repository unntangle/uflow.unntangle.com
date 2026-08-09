'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
import { crmFetch, crmPath } from '../../../lib/client-fetch';
import { ProjectStatus } from '../../../lib/supabase';
import {
  COMPLEXITY_OPTIONS,
  CATEGORY_OPTIONS,
  UNSET,
} from '../../../lib/job-options';

// ============================================================
// Types
// ============================================================
type ProjectLite = {
  id: string;
  slug: string;
  name: string;
  brief: string | null;
  status: ProjectStatus;
  // Both nullable: pre-migration rows are unclassified, and an
  // admin is allowed to clear either one back to that state.
  complexity: string | null;
  category: string | null;
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
//   - complexity / category : the two classification dropdowns,
//             both optional. Selecting the blank placeholder
//             clears the column back to NULL. Editable at any
//             status for the same reason `name` is — they're
//             labels, not pipeline state.
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
  // null (unclassified) maps to UNSET so the select lands on its
  // placeholder rather than silently showing the first option as
  // though it had been chosen.
  const [complexity, setComplexity] = useState<string>(
    project.complexity ?? UNSET
  );
  const [category, setCategory] = useState<string>(project.category ?? UNSET);

  // Two-bucket reference state (same shape as the client form):
  //   existingRefs   : already-saved rows; X toggles removal.
  //   removedRefIds  : ids marked for removal this session.
  //   newRefs        : files picked this session, not yet uploaded.
  const [existingRefs] = useState<ExistingRef[]>(initialReferences);
  const [removedRefIds, setRemovedRefIds] = useState<Set<string>>(new Set());
  const [newRefs, setNewRefs] = useState<File[]>([]);

  const [busy, setBusy] = useState(false);

  // ---- Variants ----
  // Staged like the reference images: Add queues a colourway
  // locally, Save changes commits it. Keeps one mental model for
  // the whole form — nothing on this page persists until Save,
  // and Cancel discards everything.
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const [variantDraft, setVariantDraft] = useState('');
  const [pendingVariants, setPendingVariants] = useState<string[]>([]);
  // Saved colourways marked for deletion this session. Staged
  // rather than deleted on click, like the reference images — so
  // an accidental click is undoable right up until Save, and
  // Cancel throws the whole thing away.
  const [removedVariantIds, setRemovedVariantIds] = useState<Set<string>>(
    new Set()
  );
  const [variantErr, setVariantErr] = useState<string | null>(null);

  function toggleVariantRemoval(id: string) {
    setVariantErr(null);
    setRemovedVariantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  // Slugified comparison, matching what the server derives, so a
  // clash is caught here rather than coming back as a 409 after
  // the user has already pressed Save.
  const variantKey = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  function stageVariant() {
    const variantName = variantDraft.trim();
    if (!variantName) return;
    const key = variantKey(variantName);
    if (!key) {
      setVariantErr('That name has no usable letters or numbers.');
      return;
    }
    const clashesSaved = (variants ?? []).some(
      // A colourway marked for deletion doesn't block the name:
      // removals are committed before creations on save, so
      // re-adding "Grey" in the same session works.
      (v) => v.slug === key && !removedVariantIds.has(v.id)
    );
    const clashesPending = pendingVariants.some(
      (p) => variantKey(p) === key
    );
    if (clashesSaved || clashesPending) {
      setVariantErr(`This product already has a "${key}" variant.`);
      return;
    }
    setVariantErr(null);
    setPendingVariants((prev) => [...prev, variantName]);
    setVariantDraft('');
  }

  function removePendingVariantAt(i: number) {
    setPendingVariants((prev) => prev.filter((_, idx) => idx !== i));
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
  const variantsChanged =
    pendingVariants.length > 0 || removedVariantIds.size > 0;
  // Compare through the same empty -> null normalisation the
  // PATCH applies, so re-picking the placeholder on an already-
  // unclassified job doesn't count as a change.
  const complexityChanged =
    (complexity || null) !== (project.complexity ?? null);
  const categoryChanged = (category || null) !== (project.category ?? null);
  const dirty =
    nameChanged ||
    briefChanged ||
    refsChanged ||
    variantsChanged ||
    complexityChanged ||
    categoryChanged;

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
        // Always sent. The PATCH uses present-key semantics, so
        // including them unconditionally means clearing a select
        // back to the placeholder actually nulls the column
        // instead of being a no-op.
        complexity: complexity || null,
        category: category || null,
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

      // ---- 3. Delete any colourways marked for removal ----
      // Before the creations below, so freeing up a slug and
      // re-adding the same name in one session works. Sequential
      // for the same reason the creates are: each one re-reads
      // the product's variant rows server-side.
      for (const removedId of removedVariantIds) {
        const label =
          (variants ?? []).find((v) => v.id === removedId)?.name ??
          'that variant';
        const dRes = await crmFetch(
          `/api/projects/${project.id}/variants/${removedId}`,
          { method: 'DELETE' }
        );
        if (!dRes.ok) {
          const dData = await dRes.json().catch(() => ({}));
          // The field edits above already saved, so report
          // precisely what didn't land rather than implying the
          // whole save failed.
          setErr(
            `Saved the job, but "${label}" could not be removed: ${
              dData.error || 'unknown error'
            }`
          );
          return;
        }
      }

      // ---- 4. Create any staged variants ----
      // Sequential rather than parallel: each POST reads the
      // product's existing variants to work out the next position
      // and inherit the artist, so firing them at once would race
      // and hand several variants the same position.
      for (const variantName of pendingVariants) {
        const vRes = await crmFetch(
          `/api/projects/${project.id}/variants`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: variantName }),
          }
        );
        if (!vRes.ok) {
          const vData = await vRes.json().catch(() => ({}));
          // The name/brief/reference edits are already saved at
          // this point, so don't pretend the whole save failed —
          // report exactly which variant didn't land and leave
          // the user on the page to retry.
          setErr(
            `Saved the job, but "${variantName}" could not be added: ${
              vData.error || 'unknown error'
            }`
          );
          return;
        }
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
                {clientName} · Update the job name, category, complexity, brief, or reference
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
                Editable at any status — these are labels, not pipeline
                state. Pick the blank option to clear one.
              </p>
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
                Staged locally on Add and committed by Save
                changes, so the whole form has one save model. */}
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
                one job and share the reference images above. New variants are
                created when you press Save changes. The original can&apos;t be
                removed on its own — it is the product, so deleting it means
                deleting the whole job from List Jobs.
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
                  {(variants.length > 0 || pendingVariants.length > 0) && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginBottom: 10,
                      }}
                    >
                      {variants.map((v) => {
                        const marked = removedVariantIds.has(v.id);
                        return (
                        <span
                          key={v.id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            border: marked
                              ? '2px dashed var(--danger)'
                              : '1px solid var(--border)',
                            borderRadius: 999,
                            padding: '4px 10px',
                            fontSize: 13,
                            opacity: marked ? 0.45 : 1,
                            transition: 'opacity 0.15s',
                          }}
                          title={
                            marked
                              ? 'Marked for removal — click ↩ to undo'
                              : v.is_primary
                              ? 'The original colourway'
                              : `Variant · ${v.slug}`
                          }
                        >
                          <strong style={{ fontWeight: 600 }}>
                            {v.is_primary ? project.name : v.name}
                          </strong>
                          <StatusBadge
                            status={v.status}
                            revisionCount={v.revision_count}
                            assigned
                          />
                          {/* The primary IS the product — removing
                              it would leave a job with no model at
                              all, so that's the job Delete button on
                              List Jobs, not this one. The API
                              rejects it independently. */}
                          {!v.is_primary && (
                            <button
                              type="button"
                              onClick={() => toggleVariantRemoval(v.id)}
                              disabled={busy}
                              aria-label={
                                marked
                                  ? `Undo removing ${v.name}`
                                  : `Remove ${v.name}`
                              }
                              title={
                                marked
                                  ? 'Undo'
                                  : 'Remove this colourway on save'
                              }
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
                              {marked ? '↩' : '×'}
                            </button>
                          )}
                        </span>
                        );
                      })}

                      {/* Staged, not yet created. Dashed outline
                          mirrors the reference images' "marked for
                          removal" treatment so pending state reads
                          consistently across the form. */}
                      {pendingVariants.map((p, i) => (
                        <span
                          key={`pending-${p}`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            border: '1px dashed var(--border)',
                            borderRadius: 999,
                            padding: '4px 10px',
                            fontSize: 13,
                            opacity: 0.8,
                          }}
                          title="Will be created when you press Save changes"
                        >
                          <strong style={{ fontWeight: 600 }}>{p}</strong>
                          <span
                            style={{
                              color: 'var(--text-faint)',
                              fontSize: 11,
                            }}
                          >
                            after save
                          </span>
                          <button
                            type="button"
                            onClick={() => removePendingVariantAt(i)}
                            disabled={busy}
                            aria-label={`Remove ${p}`}
                            title="Remove"
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
                        </span>
                      ))}
                    </div>
                  )}

                  {removedVariantIds.size > 0 && (
                    <p
                      style={{
                        color: 'var(--danger, #dc2626)',
                        fontSize: 12,
                        margin: '0 0 10px',
                        lineHeight: 1.5,
                      }}
                    >
                      {removedVariantIds.size} colourway
                      {removedVariantIds.size === 1 ? '' : 's'} will be deleted
                      when you press Save changes — permanently, along with any
                      uploaded model and feedback attached to it. Click ↩ on a
                      faded chip to undo, or Cancel to discard everything.
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="crm-input"
                      placeholder="e.g. Grey"
                      value={variantDraft}
                      disabled={busy}
                      onChange={(e) => setVariantDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          stageVariant();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="crm-btn crm-btn-secondary"
                      onClick={stageVariant}
                      disabled={busy || !variantDraft.trim()}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      Add variant
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
