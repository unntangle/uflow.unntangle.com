'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Clipboard,
  ExternalLink,
  Download,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
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
  // Full status vocabulary. This page only renders when SOMETHING
  // here is awaiting the client's sign-off, but the product row's
  // own column can legitimately read anything since the variants
  // migration stopped writing it.
  status:
    | 'draft'
    | 'qa_pending'
    | 'iqa_rejected'
    | 'eqa_rejected'
    | 'wip'
    | 'iqa_wip'
    | 'eqa_wip'
    | 'client_review'
    | 'approved';
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

// A colourway awaiting sign-off. Each carries its own model and
// its own revision count, and is approved or rejected
// independently of its siblings.
type Variant = {
  id: string;
  name: string;
  slug: string;
  status: Project['status'];
  revision_count: number;
  glb_url: string | null;
  approved_glb_url: string | null;
  is_primary: boolean;
  position: number;
  updated_at: string;
};

// The only client-actionable state.
const REVIEWABLE: Project['status'][] = ['client_review'];

// Sentinel key for the legacy single-model path, where the review
// target is the product row itself rather than a colourway.
const PRODUCT_KEY = '__project';

// ------------------------------------------------------------
// One reviewable thing on this page. Normally a colourway; falls
// back to the product row for a pre-variants project.
// ------------------------------------------------------------
type Target = {
  key: string;
  variantId: string | null;
  name: string;
  revisionCount: number;
  glbUrl: string | null;
};

// What the client has staged against one target. Empty files
// means approve; any file means reject.
type Draft = {
  files: File[];
  note: string;
  // Held targets are left out of the submission entirely, so
  // their status doesn't move. Used for "decide later" and forced
  // on for a colourway with nothing uploaded (the API refuses the
  // whole submission if such a target is included).
  hold: boolean;
};

const EMPTY_DRAFT: Draft = { files: [], note: '', hold: false };

// Object URLs are expensive to churn: calling createObjectURL in
// render leaks one per paint and makes the <img> flash on every
// keystroke in the note field. Cache per File instead — the File
// is stable while it's in the draft, and the WeakMap lets it be
// collected once removed.
const previewCache = new WeakMap<File, string>();
function previewUrl(f: File): string {
  let u = previewCache.get(f);
  if (!u) {
    u = URL.createObjectURL(f);
    previewCache.set(f, u);
  }
  return u;
}

// ============================================================
// ClientReviewPage
//
// The client's final sign-off. Mirrors admin's QaReviewPage in
// layout and interaction so the reviewer experience matches what
// admin saw, but with client semantics:
//   - Approve = FINAL. The model is published.
//   - Reject  = back to admin's queue with feedback screenshots.
//
// ONE FEEDBACK BLOCK PER COLOURWAY. Each has its own dropzone,
// thumbnails and note, and produces its own outcome — Grey can
// be signed off while Black goes back in the same submission.
// This is required, not cosmetic: since the 2026-08-06 variants
// migration each colourway holds its own status, so a single
// flat verdict had nothing valid to write to.
//
// Ctrl+V pastes into the block last touched; that block is
// highlighted so it's never ambiguous where a paste will land.
//
// Decision rule, evaluated INDEPENDENTLY per colourway (matches
// the API's `decisions` payload):
//   feedback images empty   → APPROVE (publish)
//   feedback images present → REJECT  (back to admin)
// ============================================================
export default function ClientReviewPage({
  project,
  references,
  variants,
  currentUser,
}: {
  project: Project;
  references: Reference[];
  variants: Variant[];
  currentUser: { name: string; role: 'client' };
}) {
  const router = useRouter();

  // ---- Review targets ----
  // Only colourways awaiting THIS client's sign-off. Anything
  // still with the artist or already approved isn't theirs to
  // decide on. With none selectable we fall back to the product
  // row, which is the legacy single-model path.
  const targets: Target[] = useMemo(() => {
    const reviewable = variants.filter((v) => REVIEWABLE.includes(v.status));
    if (reviewable.length > 0) {
      return reviewable.map((v) => ({
        key: v.id,
        variantId: v.id,
        // The primary colourway's stored name is a backfill
        // artefact — the migration inserted every pre-existing
        // project as a variant literally called 'Original', which
        // tells the client nothing. The primary IS the product,
        // so show the product's own name.
        name: v.is_primary ? project.name : v.name,
        revisionCount: v.revision_count,
        glbUrl: v.glb_url,
      }));
    }
    return [
      {
        key: PRODUCT_KEY,
        variantId: null,
        name: project.name,
        revisionCount: project.revision_count,
        glbUrl: project.glb_url,
      },
    ];
  }, [variants, project]);

  // ---- Staged decisions, keyed by target ----
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const init: Record<string, Draft> = {};
    for (const t of targets) {
      init[t.key] = { ...EMPTY_DRAFT, hold: !t.glbUrl };
    }
    return init;
  });
  const draftOf = (key: string): Draft => drafts[key] ?? EMPTY_DRAFT;

  // Which block a Ctrl+V lands in.
  const [activeKey, setActiveKey] = useState<string>(targets[0]?.key ?? '');
  // Mirror readable from the mount-once paste handler without
  // making it re-subscribe on every change.
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pasteFlashKey, setPasteFlashKey] = useState<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  // Dropzone nodes, so a click can focus the right one before
  // opening the file picker (focus is what makes a follow-up
  // paste land in the same block).
  const dropRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Lightbox identifies both the block and the index within it,
  // since files are no longer one flat list.
  const [lightbox, setLightbox] = useState<{
    key: string;
    index: number;
  } | null>(null);
  const lightboxFiles = lightbox ? draftOf(lightbox.key).files : [];
  const lightboxFile = lightbox ? lightboxFiles[lightbox.index] : undefined;

  // ---------------- Draft mutation helpers ----------------
  function updateDraft(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? EMPTY_DRAFT), ...patch },
    }));
    // Any change flips at least one outcome, so the confirmation
    // the client already read is no longer the one they'd get.
    setConfirm(false);
  }

  function addFiles(key: string, picked: FileList | File[]) {
    const arr = Array.from(picked).filter((f) => /^image\//.test(f.type));
    if (arr.length === 0) return;

    // A target with no uploaded model is auto-held and renders no
    // dropzone — but the window-level paste handler doesn't know
    // that, so Ctrl+V still routed files here. Clearing `hold`
    // below then made Submit available for something the server
    // will always refuse, and by the time it did the files had
    // already been PUT to R2. Refuse the attach instead, and say
    // why, rather than accepting files into a dead end.
    const target = targets.find((t) => t.key === key);
    if (target && !target.glbUrl) {
      setErr(
        `${target.name} has no uploaded model yet, so there's nothing to mark up. Those images weren't attached.`
      );
      return;
    }

    setDrafts((prev) => {
      const cur = prev[key] ?? EMPTY_DRAFT;
      return {
        ...prev,
        // Attaching feedback is an explicit act of deciding on
        // this colourway, so it can't stay held. Safe now that a
        // target with no model can never reach this line.
        [key]: { ...cur, files: [...cur.files, ...arr], hold: false },
      };
    });
    setErr(null);
    setConfirm(false);
  }

  function removeAt(key: string, i: number) {
    setDrafts((prev) => {
      const cur = prev[key] ?? EMPTY_DRAFT;
      return {
        ...prev,
        [key]: { ...cur, files: cur.files.filter((_, idx) => idx !== i) },
      };
    });
    setConfirm(false);
  }

  // ---------------- Lightbox keyboard nav ----------------
  useEffect(() => {
    if (!lightbox) return;
    const count = lightboxFiles.length;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightbox(null);
      else if (e.key === 'ArrowLeft') {
        setLightbox((l) =>
          l ? { ...l, index: (l.index - 1 + count) % count } : l
        );
      } else if (e.key === 'ArrowRight') {
        setLightbox((l) => (l ? { ...l, index: (l.index + 1) % count } : l));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, lightboxFiles.length]);

  // Auto-close / clamp when the displayed file is removed,
  // otherwise we'd render an undefined file.
  useEffect(() => {
    if (!lightbox) return;
    const count = draftOf(lightbox.key).files.length;
    if (count === 0) setLightbox(null);
    else if (lightbox.index >= count) {
      setLightbox({ key: lightbox.key, index: count - 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, lightbox]);

  // ---------------- Paste anywhere ----------------
  // The textarea also receives paste events; we don't want an
  // image pasted into a note field to be lost, so we attach to
  // window and check for image items. Plain text pastes pass
  // through to whatever element has focus.
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

      const key = activeKeyRef.current;
      if (!key) return;

      // We have images — eat the event so the browser doesn't also
      // paste an <img> blob into a focused textarea.
      e.preventDefault();
      addFiles(key, picked);
      setPasteFlashKey(key);
      window.setTimeout(() => setPasteFlashKey(null), 700);
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // ---------------- Reference zip download ----------------
  const [downloadingRefs, setDownloadingRefs] = useState(false);
  const [downloadRefsErr, setDownloadRefsErr] = useState<string | null>(null);

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

  // ---------------- Derived outcome summary ----------------
  const included = targets.filter((t) => !draftOf(t.key).hold);
  const toReject = included.filter((t) => draftOf(t.key).files.length > 0);
  const toApprove = included.filter((t) => draftOf(t.key).files.length === 0);
  const held = targets.filter((t) => draftOf(t.key).hold);
  const totalFiles = included.reduce(
    (n, t) => n + draftOf(t.key).files.length,
    0
  );
  // Held only because there's nothing to look at — worth calling
  // out separately from a deliberate "decide later".
  const heldNoModel = held.filter((t) => !t.glbUrl);

  // ---------------- Submit ----------------
  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      if (included.length === 0) {
        setErr('Nothing to submit — every model is on hold.');
        return;
      }

      // Flatten every staged file, remembering which block it came
      // from. The sign endpoint files each image under its OWN
      // colourway's next revision, so the variant id has to travel
      // with it rather than being applied product-wide.
      const flat = included.flatMap((t) =>
        draftOf(t.key).files.map((file) => ({
          key: t.key,
          variantId: t.variantId,
          file,
        }))
      );

      const urlsByKey: Record<string, string[]> = {};
      for (const t of included) urlsByKey[t.key] = [];

      if (flat.length > 0) {
        const signRes = await crmFetch(
          `/api/projects/${project.id}/client-feedback-sign`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              count: flat.length,
              content_types: flat.map(
                (x) => x.file.type || 'application/octet-stream'
              ),
              // Parallel array — which colourway each file belongs
              // to, so the R2 key follows that colourway's own
              // revision counter.
              variant_ids: flat.map((x) => x.variantId),
            }),
          }
        );
        const signData = await signRes.json();
        if (!signRes.ok) {
          setErr(signData.error || 'Could not sign feedback uploads.');
          return;
        }

        await Promise.all(
          flat.map(async (x, i) => {
            const item = signData.signed[i];
            const r = await fetch(item.upload_url, {
              method: 'PUT',
              headers: { 'Content-Type': item.content_type },
              body: x.file,
            });
            if (!r.ok) {
              throw new Error(
                `R2 upload failed for ${x.file.name} (${r.status}).`
              );
            }
            // R2 returns an empty 200; the public URL is what the
            // sign endpoint already told us.
            urlsByKey[x.key].push(item.public_url as string);
          })
        );
      }

      const res = await crmFetch(
        `/api/projects/${project.id}/client-review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Per-colourway decisions. Each is evaluated on its
            // own: images → reject, no images → approve. A mixed
            // submission is normal and expected.
            decisions: included.map((t) => ({
              variant_id: t.variantId,
              image_urls: urlsByKey[t.key],
              note: draftOf(t.key).note.trim() || undefined,
            })),
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

  // Header summary. With colourways in play the revision shown is
  // the highest — each still advances its own counter server-side.
  const headerRevision = Math.max(...targets.map((t) => t.revisionCount));
  const multi = targets.length > 1;

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
              style={{ padding: '6px 8px', flexShrink: 0 }}
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
                {project.client.name} · Revision {headerRevision}
                {multi ? ` · ${targets.length} colourways` : ''}
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
              {targets.some((t) => t.glbUrl) && (
                <a
                  className="crm-btn"
                  href={crmPath(
                    `/admin/qa/${project.id}/model${
                      targets[0].variantId
                        ? `?variant=${targets[0].variantId}`
                        : ''
                    }`
                  )}
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

          {heldNoModel.length > 0 && (
            <div className="crm-error" style={{ marginBottom: 16 }}>
              {heldNoModel.map((t) => t.name).join(', ')} ha
              {heldNoModel.length === 1 ? 's' : 've'} no uploaded model yet, so
              {heldNoModel.length === 1 ? ' it is' : ' they are'} on hold and
              won&apos;t be part of this submission. The rest can still be
              decided on.
            </div>
          )}

          {project.brief && (
            <section className="crm-card" style={{ marginTop: 24 }}>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
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

          {/* ================= Per-colourway feedback ================= */}
          <section className="crm-card" style={{ marginTop: 24 }}>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
            >
              <div>
                <h2
                  className="crm-qa-section-title"
                  style={{ margin: '0 0 6px' }}
                >
                  Feedback
                </h2>
                <p
                  style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}
                >
                  {multi ? (
                    <>
                      Each colourway is decided <strong>separately</strong>.
                      Attach screenshots to the ones that need changes; leave a
                      colourway <strong>empty</strong> to give it final
                      approval. One colourway can be published while another
                      goes back for revision.
                    </>
                  ) : (
                    <>
                      Attach annotated screenshots if changes are needed.
                      Submitting with <strong>no images</strong> will give
                      final approval and publish the model.
                    </>
                  )}
                </p>
              </div>

              {targets.map((t) => {
                const d = draftOf(t.key);
                const isActive = activeKey === t.key;
                const isDragging = draggingKey === t.key;
                const flashing = pasteFlashKey === t.key;
                const willReject = d.files.length > 0;
                const inputId = `client-qa-fb-input-${t.key}`;

                return (
                  <div
                    key={t.key}
                    onMouseDown={() => setActiveKey(t.key)}
                    style={{
                      border: '1px solid var(--border, #e5e5e5)',
                      borderRadius: 12,
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 14,
                      opacity: d.hold ? 0.55 : 1,
                      // The active block is where a Ctrl+V lands.
                      // Multi-colourway only — with one block there
                      // is nothing to disambiguate.
                      boxShadow:
                        multi && isActive && !d.hold
                          ? '0 0 0 2px var(--accent)'
                          : 'none',
                      transition: 'box-shadow 0.12s ease, opacity 0.12s ease',
                    }}
                  >
                    {/* ---- Colourway header ---- */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <strong style={{ fontSize: 14 }}>{t.name}</strong>
                      <span className="crm-badge crm-badge-client-review">
                        EQA
                      </span>
                      <span
                        style={{ fontSize: 12, color: 'var(--text-dim)' }}
                      >
                        Revision {t.revisionCount}
                      </span>

                      <span style={{ flex: 1 }} />

                      {/* Outcome preview — the one thing a reviewer
                          most wants to confirm before submitting. */}
                      {!d.hold && (
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: willReject
                              ? 'var(--danger)'
                              : 'var(--success, #16a34a)',
                          }}
                        >
                          {willReject
                            ? `Reject · ${d.files.length} image${
                                d.files.length === 1 ? '' : 's'
                              }`
                            : 'Approve → publish'}
                        </span>
                      )}

                      {t.glbUrl && (
                        <a
                          className="crm-btn crm-btn-secondary"
                          href={crmPath(
                            `/admin/qa/${project.id}/model${
                              t.variantId ? `?variant=${t.variantId}` : ''
                            }`
                          )}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open ${t.name} full-screen in a new tab`}
                          style={{ padding: '4px 10px', fontSize: 12 }}
                        >
                          <ExternalLink
                            size={12}
                            strokeWidth={1.75}
                            aria-hidden="true"
                          />
                          View
                        </a>
                      )}

                      {/* Hold is only meaningful when there's more
                          than one thing to decide on. */}
                      {multi && (
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 12,
                            color: 'var(--text-dim)',
                            cursor: t.glbUrl ? 'pointer' : 'not-allowed',
                          }}
                          title={
                            t.glbUrl
                              ? 'Leave this colourway untouched by this submission'
                              : 'No model uploaded yet — this colourway cannot be decided on'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={d.hold}
                            disabled={!t.glbUrl || busy}
                            onChange={(e) =>
                              updateDraft(t.key, { hold: e.target.checked })
                            }
                          />
                          Decide later
                        </label>
                      )}
                    </div>

                    {d.hold ? (
                      <p
                        style={{
                          margin: 0,
                          fontSize: 12,
                          color: 'var(--text-dim)',
                        }}
                      >
                        {t.glbUrl
                          ? 'On hold — this colourway keeps its current status and stays in your queue.'
                          : 'No model uploaded yet, so this colourway cannot be reviewed.'}
                      </p>
                    ) : (
                      <>
                        {/* ---- Dropzone ---- */}
                        <div
                          ref={(el) => {
                            dropRefs.current[t.key] = el;
                          }}
                          className={`crm-dropzone ${
                            flashing || isDragging ? 'is-drag' : ''
                          }`}
                          onClick={() => {
                            setActiveKey(t.key);
                            dropRefs.current[t.key]?.focus();
                            document.getElementById(inputId)?.click();
                          }}
                          onFocus={() => setActiveKey(t.key)}
                          onDragEnter={(e) => {
                            e.preventDefault();
                            setDraggingKey(t.key);
                          }}
                          onDragOver={(e) => {
                            // Required for onDrop to fire.
                            e.preventDefault();
                            if (draggingKey !== t.key) setDraggingKey(t.key);
                          }}
                          onDragLeave={(e) => {
                            // Only clear when the cursor truly leaves
                            // the zone, not when it moves between
                            // children.
                            if (
                              !dropRefs.current[t.key]?.contains(
                                e.relatedTarget as Node | null
                              )
                            ) {
                              setDraggingKey(null);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDraggingKey(null);
                            setActiveKey(t.key);
                            addFiles(t.key, e.dataTransfer.files);
                            // Keep focus so a follow-up paste lands
                            // in the same block.
                            dropRefs.current[t.key]?.focus();
                          }}
                          tabIndex={0}
                          role="button"
                          aria-label={`Click, drop, or paste feedback screenshots for ${t.name}`}
                          style={{
                            cursor: 'text',
                            outline:
                              isActive || isDragging
                                ? '2px solid var(--accent)'
                                : 'none',
                            outlineOffset: 2,
                            transition: 'outline-color 0.12s ease',
                          }}
                        >
                          <input
                            id={inputId}
                            type="file"
                            accept="image/*"
                            multiple
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              if (e.target.files)
                                addFiles(t.key, e.target.files);
                              e.target.value = '';
                            }}
                          />
                          <strong>
                            Click, drop, or paste screenshots
                            {multi ? ` for ${t.name}` : ''}
                          </strong>
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
                            <Clipboard
                              size={12}
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            <span>
                              {multi && isActive
                                ? 'Ctrl+V pastes here'
                                : 'Ctrl+V to paste from clipboard'}{' '}
                              · PNG/JPG/WebP · &le; 15 MB each
                            </span>
                          </div>
                        </div>

                        {d.files.length > 0 && (
                          <div className="crm-feedback-grid">
                            {d.files.map((f, i) => (
                              <div key={i} className="crm-feedback-thumb">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={previewUrl(f)}
                                  alt={f.name}
                                  onClick={() =>
                                    setLightbox({ key: t.key, index: i })
                                  }
                                  style={{ cursor: 'zoom-in' }}
                                />
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeAt(t.key, i);
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
                          <label className="crm-label">
                            Note (optional)
                            {multi ? ` — ${t.name}` : ''}
                          </label>
                          <textarea
                            className="crm-textarea"
                            rows={2}
                            value={d.note}
                            onFocus={() => setActiveKey(t.key)}
                            onChange={(e) =>
                              updateDraft(t.key, { note: e.target.value })
                            }
                            placeholder="Optional summary — visible to the admin and artist."
                          />
                        </div>
                      </>
                    )}
                  </div>
                );
              })}

              {err && <div className="crm-error">{err}</div>}

              <div
                style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}
              >
                <button
                  className="crm-btn crm-btn-secondary"
                  onClick={() => router.push(crmPath('/client'))}
                  disabled={busy}
                >
                  Cancel
                </button>
                {/* Neutral "Submit" regardless of the mix. The
                    confirmation modal spells out what happens to
                    each colourway — with a mixed submission no
                    single button colour could tell the truth. */}
                <button
                  className="crm-btn"
                  onClick={() => setConfirm(true)}
                  disabled={busy || included.length === 0}
                  title={
                    included.length === 0
                      ? 'Every colourway is on hold'
                      : undefined
                  }
                >
                  Submit
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* ============================== Lightbox ============================== */}
      {lightbox && lightboxFile && (
        <div
          onClick={() => setLightbox(null)}
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
            src={previewUrl(lightboxFile)}
            alt={lightboxFile.name}
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
          {lightboxFiles.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((l) =>
                    l
                      ? {
                          ...l,
                          index:
                            (l.index - 1 + lightboxFiles.length) %
                            lightboxFiles.length,
                        }
                      : l
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
                  setLightbox((l) =>
                    l
                      ? { ...l, index: (l.index + 1) % lightboxFiles.length }
                      : l
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
              setLightbox(null);
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

      {/* ========================= Confirmation modal ========================= */}
      {/* One modal for a submission that may split both ways, so it
          itemises the outcome per colourway rather than claiming a
          single verdict. */}
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
            style={{ maxWidth: 520 }}
          >
            <div className="crm-modal-header">
              <div>
                <h2 className="crm-modal-title">
                  {toReject.length && toApprove.length
                    ? 'Submit this review?'
                    : toReject.length
                      ? `Reject with ${totalFiles} feedback image${
                          totalFiles === 1 ? '' : 's'
                        }?`
                      : 'Final approval — publish?'}
                </h2>
                <p
                  style={{
                    margin: '4px 0 0',
                    color: 'var(--text-dim)',
                    fontSize: 13,
                  }}
                >
                  {project.client.name} · {project.name}
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

            <div style={{ display: 'grid', gap: 12 }}>
              {toApprove.length > 0 && (
                <div
                  style={{
                    padding: 14,
                    background:
                      'color-mix(in srgb, var(--success, #16a34a) 6%, transparent)',
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                >
                  <strong style={{ color: 'var(--success, #16a34a)' }}>
                    Approved and published
                  </strong>
                  <ul
                    style={{
                      margin: '6px 0 0',
                      paddingLeft: 18,
                      color: 'var(--text-dim)',
                    }}
                  >
                    {toApprove.map((t) => (
                      <li key={t.key}>
                        {t.name} → <strong>Approved</strong>
                      </li>
                    ))}
                  </ul>
                  <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
                    This is the final sign-off — the model goes live and
                    can&apos;t be undone from the dashboard.
                  </p>
                </div>
              )}

              {toReject.length > 0 && (
                <div
                  style={{
                    padding: 14,
                    background:
                      'color-mix(in srgb, var(--danger) 6%, transparent)',
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                >
                  <strong style={{ color: 'var(--danger)' }}>
                    Back to the admin
                  </strong>
                  <ul
                    style={{
                      margin: '6px 0 0',
                      paddingLeft: 18,
                      color: 'var(--text-dim)',
                    }}
                  >
                    {toReject.map((t) => {
                      const n = draftOf(t.key).files.length;
                      return (
                        <li key={t.key}>
                          {t.name} → <strong>EQA Rejected</strong> · {n} image
                          {n === 1 ? '' : 's'} · revision{' '}
                          {t.revisionCount + 1} requested
                        </li>
                      );
                    })}
                  </ul>
                  <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
                    Admin decides whether to forward your feedback to the
                    artist or push back.
                  </p>
                </div>
              )}

              {held.length > 0 && (
                <div
                  style={{
                    padding: 14,
                    background: 'var(--surface-2, rgba(0,0,0,0.03))',
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                >
                  <strong>Unchanged</strong>
                  <ul
                    style={{
                      margin: '6px 0 0',
                      paddingLeft: 18,
                      color: 'var(--text-dim)',
                    }}
                  >
                    {held.map((t) => (
                      <li key={t.key}>
                        {t.name} — stays in your queue
                        {t.glbUrl ? '' : ' (no model uploaded)'}
                      </li>
                    ))}
                  </ul>
                </div>
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
                  // Green when nothing is being sent back, red when
                  // nothing is being approved, neutral for a mix —
                  // a single colour would misrepresent a split.
                  background: toReject.length
                    ? toApprove.length
                      ? 'var(--text, #0a0a0a)'
                      : 'var(--danger)'
                    : 'var(--success, #16a34a)',
                  color: '#fff',
                }}
              >
                {busy ? 'Submitting…' : 'Yes, submit'}
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
