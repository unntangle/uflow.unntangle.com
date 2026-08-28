'use client';

import { useState } from 'react';
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
import { toWebpAll } from '../../../lib/image-to-webp';

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

  // ---- Colourway variants: removed 2026-08-29 ----
  // A model derived from another one is now its own job with
  // model_type='child' and a parent_id, created from Create Job
  // and re-pointed from Jobs → Change Type. There is nothing
  // sub-row-shaped left for this form to edit.

  const [stage, setStage] = useState<
    'idle' | 'optimizing' | 'uploading-refs' | 'saving'
  >('idle');
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
        // Re-encoded before signing so the content_types below
        // describe the same bytes the PUT sends — R2 checks the
        // signed Content-Type against the request header.
        setStage('optimizing');
        const files = await toWebpAll(newRefs);

        setStage('uploading-refs');
        const signRes = await crmFetch('/api/references-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_slug: brandSlug,
            project_slug: project.slug,
            count: files.length,
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

        addUrls = await Promise.all(
          files.map(async (f, i) => {
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
    stage === 'optimizing'
      ? 'Optimising images…'
      : stage === 'uploading-refs'
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
