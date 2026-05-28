'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Clipboard, ExternalLink, Download, ChevronLeft, ChevronRight, X } from 'lucide-react';
import JSZip from 'jszip';
import Sidebar from '../../../components/Sidebar';
import { crmFetch, crmPath } from '../../../lib/client-fetch';

// ============================================================
// Types
// ============================================================
type Project = {
  id: string;
  slug: string;
  name: string;
  status: 'client_review';
  revision_count: number;
  glb_url: string | null;
  brief: string | null;
  updated_at: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
};

type Reference = {
  id: string;
  image_url: string;
  created_at: string;
};

// ============================================================
// ClientReviewPage
//
// Mirrors admin's QaReviewPage but with the client semantics:
//   - Approve = final, model becomes public
//   - Reject  = sends to admin's QA queue with feedback images
//
// Differences from admin version:
//   - Submits to /api/projects/[id]/client-review
//   - Signs feedback uploads via /api/projects/[id]/client-feedback-sign
//   - Returns to /client (not /admin) after submission
//   - "Forward to client" wording becomes "Approve" wording
//   - Status check passes 'client_review' (admin checks 'qa_pending')
//
// Layout is identical so the reviewer experience matches what
// the admin saw, minimising surprises during sign-off.
// ============================================================
export default function ClientReviewPage({
  project,
  references,
  currentUser,
}: {
  project: Project;
  references: Reference[];
  currentUser: { name: string; role: 'client' };
}) {
  const router = useRouter();
  const dropRef = useRef<HTMLDivElement>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pasteFlash, setPasteFlash] = useState(false);
  // Visual feedback state for the dropzone:
  //   isFocused      — user clicked or tabbed in; show focus ring
  //                    so it reads like an active input field
  //   isDraggingOver — file dragged over the zone; brighten it
  //                    so the user knows the drop will land here
  const [isFocused, setIsFocused] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Lightbox state for feedback thumbnails. null = closed; a
  // number is the index into files[] to display fullscreen. Object
  // URLs are created on-demand below (we don't cache them across
  // renders because the files array can shrink via removeAt).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxOpen = lightboxIndex !== null;

  // Lightbox keyboard nav: Esc closes, arrows walk between images.
  // Bound to window because the lightbox itself doesn't take focus
  // (would conflict with the dropzone's focus state we just added).
  useEffect(() => {
    if (!lightboxOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxIndex(null);
      else if (e.key === 'ArrowLeft') {
        setLightboxIndex((i) =>
          i === null ? i : (i - 1 + files.length) % files.length
        );
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex((i) =>
          i === null ? i : (i + 1) % files.length
        );
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen, files.length]);

  // Auto-close the lightbox if the user removes the file that's
  // currently displayed (or all files). Keeps the index inside
  // the valid range; otherwise we'd render an undefined file.
  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= files.length) {
      setLightboxIndex(files.length > 0 ? files.length - 1 : null);
    }
  }, [files.length, lightboxIndex]);

  const [downloadingRefs, setDownloadingRefs] = useState(false);
  const [downloadRefsErr, setDownloadRefsErr] = useState<string | null>(null);

  function addFiles(picked: FileList | File[]) {
    const arr = Array.from(picked).filter((f) => /^image\//.test(f.type));
    if (arr.length === 0) return;
    setFiles((prev) => [...prev, ...arr]);
    setConfirm(false);
  }
  function removeAt(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
    setConfirm(false);
  }

  // ----- Paste handler (Ctrl+V) -----
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (busy) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      const picked: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) picked.push(f);
        }
      }
      if (picked.length === 0) return;

      e.preventDefault();
      addFiles(picked);
      setPasteFlash(true);
      window.setTimeout(() => setPasteFlash(false), 700);
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [busy]);

  // ----- Download all references as a zip (same as admin page) -----
  async function downloadAllRefs() {
    if (references.length === 0 || downloadingRefs) return;
    setDownloadingRefs(true);
    setDownloadRefsErr(null);
    try {
      const zip = new JSZip();
      let ok = 0;
      await Promise.all(
        references.map(async (r, i) => {
          try {
            const res = await fetch(r.image_url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const ext = (() => {
              const m = r.image_url.match(/\.([a-z0-9]+)(?:\?|$)/i);
              return m ? m[1].toLowerCase() : 'jpg';
            })();
            const num = String(i + 1).padStart(2, '0');
            zip.file(`reference-${num}.${ext}`, blob);
            ok++;
          } catch {
            // Skip individual failures; keep the rest of the zip.
          }
        })
      );

      if (ok === 0) {
        setDownloadRefsErr('Could not download any of the reference images.');
        return;
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.slug}-references.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadRefsErr((e as Error).message);
    } finally {
      setDownloadingRefs(false);
    }
  }

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      let imageUrls: string[] = [];

      // Sign + upload rejection feedback images (if any)
      if (files.length > 0) {
        const signRes = await crmFetch(
          `/api/projects/${project.id}/client-feedback-sign`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              count: files.length,
              content_types: files.map(
                (f) => f.type || 'application/octet-stream'
              ),
            }),
          }
        );
        const signData = await signRes.json();
        if (!signRes.ok) {
          setErr(signData.error || 'Could not sign feedback uploads.');
          return;
        }

        imageUrls = await Promise.all(
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

      // Finalise the review (approve or reject)
      const res = await crmFetch(
        `/api/projects/${project.id}/client-review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_urls: imageUrls,
            note: note.trim() || undefined,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'Submission failed.');
        return;
      }
      // Back to the client dashboard.
      router.push(crmPath('/client'));
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const willApprove = files.length === 0;

  return (
    <div className="crm-shell">
      <Sidebar
        name={currentUser.name}
        role={currentUser.role}
        brandName={project.client.name}
        defaultCollapsed
      />

      <main className="crm-main">
        <div className="crm-page">
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 20,
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={() => router.push(crmPath('/client'))}
              className="crm-btn crm-btn-secondary"
              aria-label="Back to My Projects"
              title="Back to My Projects"
              style={{
                padding: '6px 8px',
                flexShrink: 0,
              }}
            >
              <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>

            <div style={{ minWidth: 0, flex: 1 }}>
              <h1
                className="crm-page-title"
                style={{
                  fontSize: 18,
                  margin: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {project.name}
              </h1>
              <p
                className="crm-page-sub"
                style={{
                  fontSize: 12,
                  margin: '2px 0 0',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {project.client.name} · Revision {project.revision_count}
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0,
              }}
            >
              {project.glb_url && (
                <a
                  className="crm-btn"
                  href={crmPath(`/admin/qa/${project.id}/model`)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the 3D model full-screen in a new tab"
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  <ExternalLink
                    size={13}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  View model
                </a>
              )}
              {references.length > 0 && (
                <>
                  <a
                    className="crm-btn crm-btn-secondary"
                    href={crmPath(`/admin/qa/${project.id}/references`)}
                    target="_blank"
                    rel="noreferrer"
                    title="Open the reference gallery in a new tab"
                    style={{ padding: '6px 12px', fontSize: 12 }}
                  >
                    <ExternalLink
                      size={13}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    Open references ({references.length})
                  </a>
                  <button
                    type="button"
                    className="crm-btn crm-btn-secondary"
                    onClick={downloadAllRefs}
                    disabled={downloadingRefs}
                    title="Download all references as a zip"
                    style={{ padding: '6px 12px', fontSize: 12 }}
                  >
                    <Download size={13} strokeWidth={1.75} aria-hidden="true" />
                    {downloadingRefs ? 'Preparing…' : 'Download all'}
                  </button>
                </>
              )}
            </div>
          </header>

          {downloadRefsErr && (
            <div className="crm-error" style={{ marginBottom: 16 }}>
              {downloadRefsErr}
            </div>
          )}

          {project.brief && (
            <section className="crm-card" style={{ marginTop: 24 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h2 className="crm-qa-section-title" style={{ margin: 0 }}>
                  Brief
                </h2>
                <p
                  style={{
                    color: 'var(--text-dim)',
                    fontSize: 13,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {project.brief}
                </p>
              </div>
            </section>
          )}

          {/* ============================== Feedback section ============================== */}
          <section className="crm-card" style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <h2
                  className="crm-qa-section-title"
                  style={{ margin: '0 0 6px' }}
                >
                  Feedback
                </h2>
                <p
                  style={{
                    color: 'var(--text-dim)',
                    fontSize: 13,
                    margin: 0,
                  }}
                >
                  Attach annotated screenshots if changes are needed.
                  Submitting with <strong>no images</strong> will give final
                  approval and publish the model.
                </p>
              </div>

              <div
                ref={dropRef}
                className={`crm-dropzone ${
                  pasteFlash || isDraggingOver ? 'is-drag' : ''
                }`}
                onClick={() => {
                  // Focus the dropzone so paste lands here AND the
                  // ring is visible, THEN open the file picker.
                  // Without the focus call, clicking the zone only
                  // opens the picker and the ring never appears.
                  dropRef.current?.focus();
                  document.getElementById('client-qa-fb-input')?.click();
                }}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setIsDraggingOver(true);
                }}
                onDragOver={(e) => {
                  // preventDefault is required for onDrop to fire.
                  e.preventDefault();
                  // Keep the drag highlight on while moving inside.
                  if (!isDraggingOver) setIsDraggingOver(true);
                }}
                onDragLeave={(e) => {
                  // Only clear when the cursor truly leaves the
                  // zone, not when it moves between children. The
                  // related target check filters out child enters.
                  if (
                    !dropRef.current?.contains(e.relatedTarget as Node | null)
                  ) {
                    setIsDraggingOver(false);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingOver(false);
                  addFiles(e.dataTransfer.files);
                  // Keep focus so a follow-up paste lands here too.
                  dropRef.current?.focus();
                }}
                tabIndex={0}
                role="button"
                aria-label="Click, drop, or paste feedback screenshots"
                style={{
                  cursor: 'text',
                  // Inline focus / drag ring — doesn't depend on
                  // the .crm-dropzone CSS being updated. The ring
                  // colour matches the rest of the app's focus
                  // treatment by leaning on the accent token.
                  outline:
                    isFocused || isDraggingOver
                      ? '2px solid var(--accent)'
                      : 'none',
                  outlineOffset: 2,
                  transition: 'outline-color 0.12s ease',
                }}
              >
                <input
                  id="client-qa-fb-input"
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <strong>Click, drop, or paste screenshots</strong>
                <div
                  className="crm-dropzone-hint"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    justifyContent: 'center',
                    marginTop: 6,
                  }}
                >
                  <Clipboard size={12} strokeWidth={1.75} aria-hidden="true" />
                  <span>
                    Ctrl+V to paste from clipboard · PNG/JPG/WebP · &le; 15 MB each
                  </span>
                </div>
              </div>

              {files.length > 0 && (
                <div className="crm-feedback-grid">
                  {files.map((f, i) => (
                    <div key={i} className="crm-feedback-thumb">
                      {/* The thumb itself is clickable (opens the
                          lightbox). The remove button sits on top
                          and stops event propagation so a stray X
                          click doesn't also open the lightbox. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={URL.createObjectURL(f)}
                        alt={f.name}
                        onClick={() => setLightboxIndex(i)}
                        style={{ cursor: 'zoom-in' }}
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeAt(i);
                        }}
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="crm-form-group" style={{ margin: 0 }}>
                <label className="crm-label">Note (optional)</label>
                <textarea
                  className="crm-textarea"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional summary — visible to the admin and artist."
                />
              </div>

              {err && <div className="crm-error">{err}</div>}

              {/* Intent indicator removed — the confirmation
                  modal already explains what will happen, and the
                  primary button colour (green/red) signals intent
                  unambiguously. The duplicate line under the
                  feedback grid was visual clutter. */}

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
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
                  onClick={() => setConfirm(true)}
                  disabled={busy}
                >
                  Submit
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* ============================== Lightbox ============================== */}
      {/* Fullscreen viewer for a feedback thumbnail. Click outside
          the image to close, or use the close button / Esc.
          Arrows walk forward/back through the queued files. */}
      {lightboxOpen && lightboxIndex !== null && files[lightboxIndex] && (
        <div
          onClick={() => setLightboxIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Feedback image preview"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.92)',
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            cursor: 'zoom-out',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={URL.createObjectURL(files[lightboxIndex])}
            alt={files[lightboxIndex].name}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: 'auto',
              objectFit: 'contain',
              display: 'block',
              boxShadow: '0 8px 40px rgba(0, 0, 0, 0.5)',
              cursor: 'default',
            }}
          />
          {files.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) =>
                    i === null
                      ? i
                      : (i - 1 + files.length) % files.length
                  );
                }}
                aria-label="Previous image"
                style={lightboxArrowStyle('left')}
              >
                <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) =>
                    i === null ? i : (i + 1) % files.length
                  );
                }}
                aria-label="Next image"
                style={lightboxArrowStyle('right')}
              >
                <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxIndex(null);
            }}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* ============================== Confirmation modal ============================== */}
      {confirm && (
        <div
          className="crm-modal-backdrop"
          onClick={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <div
            className="crm-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 480 }}
          >
            <div className="crm-modal-header">
              <div>
                <h2
                  className="crm-modal-title"
                  style={{
                    color: willApprove
                      ? 'var(--success, #16a34a)'
                      : 'var(--danger)',
                  }}
                >
                  {willApprove
                    ? 'Final approval — publish this model?'
                    : `Reject this model with ${files.length} feedback image${
                        files.length === 1 ? '' : 's'
                      }?`}
                </h2>
                <p
                  style={{
                    margin: '4px 0 0',
                    color: 'var(--text-dim)',
                    fontSize: 13,
                  }}
                >
                  {project.client.name} · {project.name} · Revision{' '}
                  {project.revision_count}
                </p>
              </div>
              <button
                className="crm-modal-close"
                onClick={() => setConfirm(false)}
                disabled={busy}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div
              style={{
                padding: 16,
                background: willApprove
                  ? 'color-mix(in srgb, var(--success, #16a34a) 6%, transparent)'
                  : 'color-mix(in srgb, var(--danger) 6%, transparent)',
                borderRadius: 10,
                fontSize: 13,
              }}
            >
              {willApprove ? (
                <>
                  <strong>This will publish the model.</strong>
                  <p style={{ margin: '4px 0 0', color: 'var(--text-dim)' }}>
                    The current GLB will be copied to the public folder
                    and the project status will change to{' '}
                    <strong>Approved</strong>. This is the final
                    sign-off — cannot be undone from the dashboard.
                  </p>
                </>
              ) : (
                <>
                  <strong>
                    Admin will receive {files.length} feedback image
                    {files.length === 1 ? '' : 's'}.
                  </strong>
                  <p style={{ margin: '4px 0 0', color: 'var(--text-dim)' }}>
                    Status will change to <strong>EQA Rejected</strong>{' '}
                    for admin&apos;s review. They&apos;ll decide whether
                    to forward your feedback to the artist or push back.
                  </p>
                </>
              )}
            </div>

            {err && (
              <div className="crm-error" style={{ marginTop: 12 }}>
                {err}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                marginTop: 20,
              }}
            >
              <button
                className="crm-btn crm-btn-secondary"
                onClick={() => setConfirm(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="crm-btn"
                onClick={submit}
                disabled={busy}
                style={{
                  background: willApprove
                    ? 'var(--success, #16a34a)'
                    : 'var(--danger)',
                  color: '#fff',
                }}
              >
                {busy
                  ? 'Submitting…'
                  : willApprove
                    ? 'Yes, approve and publish'
                    : 'Yes, reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Centered side arrow positioning for the lightbox. Pulled out so
// the JSX stays readable and both arrows share the same baseline
// styling — only the side property differs.
function lightboxArrowStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 16,
    transform: 'translateY(-50%)',
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}
