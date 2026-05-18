'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '../../../components/Sidebar';
import { crmFetch, crmPath } from '../../../lib/client-fetch';

// ============================================================
// Types
// ============================================================
type Brand = { id: string; slug: string; name: string };

type ProjectLite = {
  id: string;
  slug: string;
  name: string;
  brief: string | null;
};

// An existing reference row already saved on the server. The
// `image_url` points at our R2 public hostname; the form treats
// these as immutable on screen (the user can mark them for
// removal but can't change their URL).
type ExistingRef = { id: string; image_url: string };

// ============================================================
// EditClientJobForm
//
// Same shape as CreateClientJobForm, with three differences:
//   1. The project already exists — we PATCH rather than POST,
//      and we don't accept a slug change. The slug input is
//      shown read-only so the user understands it's locked.
//   2. References split into TWO buckets in local state:
//        - existingRefs[]   : already-saved rows the user can
//                             X-out (we track their ids in
//                             removedRefIds so the PATCH knows
//                             which DB rows to drop).
//        - newRefs[]        : files added in this session that
//                             need signing + uploading to R2
//                             before the PATCH runs.
//   3. Submission flow:
//        a. Sign + PUT any newRefs to R2 via /api/references-sign
//           (same endpoint the Create form uses — it scopes by
//           clientId server-side, so a client can only sign
//           uploads for their own brand).
//        b. PATCH /api/client/projects/[id] with the resulting
//           public URLs plus the list of ids being removed.
//
// The PATCH endpoint also independently enforces that the
// project is still in 'draft' — if an admin allocates it
// between the page render and the submit, the PATCH 409s and
// we surface that error.
// ============================================================
export default function EditClientJobForm({
  project,
  initialReferences,
  brand,
  currentUser,
}: {
  project: ProjectLite;
  initialReferences: ExistingRef[];
  brand: Brand;
  currentUser: { name: string; role: 'client' };
}) {
  const router = useRouter();

  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState(project.brief ?? '');

  // Two-bucket reference state.
  // - existingRefs : the user can X them off; we don't drop them
  //                  from this array (so the thumbnail can show
  //                  a "marked for removal" overlay if we ever
  //                  add one) — instead we toggle membership in
  //                  removedRefIds.
  const [existingRefs] = useState<ExistingRef[]>(initialReferences);
  const [removedRefIds, setRemovedRefIds] = useState<Set<string>>(new Set());
  // - newRefs      : files picked in this session, not yet
  //                  uploaded. Mirror of the Create form's
  //                  `refs` state.
  const [newRefs, setNewRefs] = useState<File[]>([]);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<
    'idle' | 'uploading-refs' | 'saving'
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
      // Mirrors the Create form's upload step exactly so the
      // R2 layout stays consistent: new files land under
      //   <clientSlug>/<projectSlug>/references/
      // using the existing project's slug (we don't change it
      // here — see the read-only slug field in the JSX below).
      let addUrls: string[] = [];
      if (newRefs.length > 0) {
        setStage('uploading-refs');
        const signRes = await crmFetch('/api/references-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_slug: brand.slug,
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
                `Upload failed for ${f.name} (${r.status})${text ? `: ${text.slice(0, 200)}` : ''}`
              );
            }
            return item.public_url as string;
          })
        );
      }

      // ---- 2. PATCH the project ----
      // We only send the fields that actually changed: name and
      // brief always go (the form treats them as the source of
      // truth), references go only if something was added or
      // removed. Keeps the request small and the server log clean.
      setStage('saving');
      const trimmedBrief = brief.trim();
      const body: Record<string, unknown> = {
        name: trimmedName,
        // Empty string → null on the server (mirrors POST).
        brief: trimmedBrief || null,
      };
      if (addUrls.length > 0) {
        body.add_reference_image_urls = addUrls;
      }
      if (removedRefIds.size > 0) {
        body.remove_reference_ids = Array.from(removedRefIds);
      }

      const res = await crmFetch(`/api/client/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Failed to save changes.');
        return;
      }
      // Back to the dashboard so the row reflects the new name /
      // brief / refs immediately. router.refresh() repopulates
      // initialProjects with the patched row.
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
      : stage === 'saving'
      ? 'Saving changes…'
      : 'Save changes';

  // Helper: a reference is "visible" (not yet marked for removal)
  // if its id isn't in removedRefIds. We still render removed
  // ones, but greyed out and behind a strike-through overlay, so
  // the user can undo within the same session.
  const visibleExistingCount =
    existingRefs.length - removedRefIds.size;
  const totalRefsAfter = visibleExistingCount + newRefs.length;

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
              <h1 className="crm-page-title">Edit Job</h1>
              <p className="crm-page-sub">
                {brand.name} · Update name, brief, or reference
                images. Editable while the job is still in draft.
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
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </div>

            {/* Slug is read-only on edit. It's used as the R2
                path prefix for any references already uploaded
                — changing it would orphan those objects and
                break any pre-signed upload URLs in flight. The
                input is shown so the user understands what the
                identifier looks like, but they can't change it. */}
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
                The slug is locked once a job is created.
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
                    {/* ----- Existing references -----
                        Each thumbnail's X toggles its id in
                        removedRefIds. When marked, we fade the
                        image so the user can see what they're
                        about to lose, with a click-again-to-undo
                        affordance via the same button. */}
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
                          title={marked ? 'Marked for removal — click ↩ to undo' : ''}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={r.image_url} alt="reference" />
                          <button
                            onClick={() => toggleExistingRefRemoval(r.id)}
                            aria-label={marked ? 'Undo remove' : 'Mark for removal'}
                            disabled={busy}
                            title={marked ? 'Undo' : 'Remove'}
                          >
                            {marked ? '↩' : '×'}
                          </button>
                        </div>
                      );
                    })}

                    {/* ----- New references (pending upload) -----
                        Same pattern as the Create form — local
                        File objects rendered from blob URLs. The
                        X removes from local state entirely (no
                        upload has happened yet). */}
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
                onClick={() => router.push(crmPath('/client'))}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="crm-btn"
                onClick={submit}
                disabled={busy || !name.trim()}
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
