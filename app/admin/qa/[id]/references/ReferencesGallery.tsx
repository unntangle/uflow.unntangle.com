'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Download, X, ChevronLeft, ChevronRight } from 'lucide-react';
import JSZip from 'jszip';

// ============================================================
// ReferencesGallery — standalone page rendered at
//   /admin/qa/[id]/references
// Opened in a new tab from the QA review page so reviewers can
// keep the model viewer on one screen and the references on
// another.
//
// What it does:
//   - Shows every reference image in a responsive grid.
//   - Clicking a thumb opens a fullscreen lightbox.
//   - Lightbox supports: arrows + Esc (keyboard nav), mouse-wheel
//     zoom toward the cursor, drag-to-pan while zoomed, and
//     double-click to toggle/reset zoom.
//   - Top-right "Download all" zips the references via JSZip.
// ============================================================

type Project = {
  id: string;
  slug: string;
  name: string;
  client: { slug: string; name: string };
};

type Reference = {
  id: string;
  image_url: string;
  created_at: string;
};

// Zoom limits + how much one wheel notch changes the scale.
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const WHEEL_STEP = 1.15;

type View = { scale: number; x: number; y: number };
const RESET_VIEW: View = { scale: 1, x: 0, y: 0 };

export default function ReferencesGallery({
  project,
  references,
}: {
  project: Project;
  references: Reference[];
}) {
  // Lightbox: null = closed, otherwise an index into references[].
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxOpen = lightboxIndex !== null;

  // Zoom + pan state for the open image. `view` drives the CSS
  // transform; `dragging` toggles the transition off mid-drag so
  // panning stays 1:1 with the cursor.
  const [view, setView] = useState<View>(RESET_VIEW);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  // The (untransformed) overlay box. Its centre is the anchor we
  // zoom around, so we read it for cursor-relative zoom math.
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Download-all state.
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  // Reset zoom/pan whenever the visible image changes or the
  // lightbox closes, so each image opens at fit-to-screen.
  useEffect(() => {
    setView(RESET_VIEW);
    setDragging(false);
    draggingRef.current = false;
  }, [lightboxIndex]);

  // Keyboard nav for the lightbox: Esc closes, arrows step through,
  // +/- zoom, 0 resets.
  useEffect(() => {
    if (!lightboxOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxIndex(null);
      else if (e.key === 'ArrowLeft') {
        setLightboxIndex((i) =>
          i === null ? i : (i - 1 + references.length) % references.length
        );
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex((i) =>
          i === null ? i : (i + 1) % references.length
        );
      } else if (e.key === '+' || e.key === '=') {
        setView((v) => ({ ...v, scale: clamp(v.scale * WHEEL_STEP) }));
      } else if (e.key === '-' || e.key === '_') {
        setView((v) => {
          const scale = clamp(v.scale / WHEEL_STEP);
          return scale === 1 ? RESET_VIEW : { ...v, scale };
        });
      } else if (e.key === '0') {
        setView(RESET_VIEW);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen, references.length]);

  // Wheel-to-zoom. We attach a NON-passive native listener so we
  // can preventDefault (React's onWheel is passive, so the page
  // would scroll behind the overlay otherwise). Zoom is anchored
  // to the cursor: the point under the pointer stays put as the
  // image grows/shrinks.
  useEffect(() => {
    if (!lightboxOpen) return;
    const el = overlayRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      // Cursor offset from the overlay centre (== image centre,
      // since the image is centred in the overlay). This is the
      // anchor in the image's *untransformed* coordinate space.
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      setView((v) => {
        const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
        const scale = clamp(v.scale * factor);
        if (scale === v.scale) return v;
        if (scale === 1) return RESET_VIEW;
        // Keep the anchor fixed: new translation so the content
        // point under the cursor doesn't move.
        const ratio = scale / v.scale;
        return {
          scale,
          x: cx - (cx - v.x) * ratio,
          y: cy - (cy - v.y) * ratio,
        };
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [lightboxOpen]);

  // ---- Drag-to-pan (only meaningful while zoomed in). Pointer
  // capture keeps the drag alive even if the cursor leaves the
  // image.
  function onPointerDown(e: ReactPointerEvent) {
    if (view.scale <= 1) return;
    e.stopPropagation();
    draggingRef.current = true;
    setDragging(true);
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent) {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastPosRef.current.x;
    const dy = e.clientY - lastPosRef.current.y;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }
  function onPointerUp(e: ReactPointerEvent) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
  }

  async function downloadAll() {
    if (references.length === 0 || downloading) return;
    setDownloading(true);
    setDownloadErr(null);
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
            // Skip and keep going.
          }
        })
      );
      if (ok === 0) {
        setDownloadErr('Could not download any of the reference images.');
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
      setDownloadErr((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="crm-page">
      <header className="crm-page-header">
        <div>
          <h1 className="crm-page-title">Reference images</h1>
          <p className="crm-page-sub">
            {project.client.name} · {project.name} · {references.length} image
            {references.length === 1 ? '' : 's'}
          </p>
        </div>
        {references.length > 0 && (
          <button
            type="button"
            className="crm-btn crm-btn-secondary"
            onClick={downloadAll}
            disabled={downloading}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            {downloading ? 'Preparing…' : 'Download all (zip)'}
          </button>
        )}
      </header>

      {downloadErr && (
        <div className="crm-error" style={{ marginBottom: 16 }}>
          {downloadErr}
        </div>
      )}

      {references.length === 0 ? (
        <div className="crm-empty">
          <h3>No reference images</h3>
          <p>This project was created without attached references.</p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          {references.map((r, i) => (
            <button
              key={r.id}
              type="button"
              className="crm-qa-ref-thumb"
              onClick={() => setLightboxIndex(i)}
              aria-label="Enlarge reference image"
              title="Click to enlarge"
              style={{
                padding: 0,
                border: '1px solid var(--border)',
                cursor: 'zoom-in',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.image_url} alt="Reference" />
            </button>
          ))}
        </div>
      )}

      {/* Lightbox overlay */}
      {lightboxOpen && lightboxIndex !== null && (
        <div
          ref={overlayRef}
          className="crm-lightbox"
          onClick={() => setLightboxIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Reference image"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.92)',
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            cursor: view.scale > 1 ? 'grab' : 'zoom-out',
            overflow: 'hidden',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={references[lightboxIndex].image_url}
            alt="Reference (enlarged)"
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setView((v) =>
                v.scale > 1 ? RESET_VIEW : { scale: 2.5, x: 0, y: 0 }
              );
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: 'auto',
              objectFit: 'contain',
              display: 'block',
              boxShadow: '0 8px 40px rgba(0, 0, 0, 0.5)',
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transformOrigin: 'center center',
              transition: dragging ? 'none' : 'transform 0.1s ease-out',
              cursor:
                dragging
                  ? 'grabbing'
                  : view.scale > 1
                  ? 'grab'
                  : 'zoom-in',
              // Let pointer drags pan on touch devices instead of
              // scrolling the page.
              touchAction: 'none',
              userSelect: 'none',
              willChange: 'transform',
            }}
          />

          {references.length > 1 && (
            <>
              <button
                type="button"
                className="crm-lightbox-arrow is-prev"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex(
                    (i) =>
                      i === null
                        ? i
                        : (i - 1 + references.length) % references.length
                  );
                }}
                aria-label="Previous reference"
              >
                <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="crm-lightbox-arrow is-next"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) =>
                    i === null ? i : (i + 1) % references.length
                  );
                }}
                aria-label="Next reference"
              >
                <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </>
          )}

          <button
            type="button"
            className="crm-lightbox-close"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxIndex(null);
            }}
            aria-label="Close"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>

        </div>
      )}
    </div>
  );
}

// Clamp a scale into the allowed zoom range.
function clamp(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}
