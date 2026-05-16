'use client';

import { useEffect, useState } from 'react';
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
//   - Clicking a thumb opens a fullscreen lightbox; arrows + Esc
//     for keyboard navigation.
//   - Top-right "Download all" zips the references via JSZip,
//     same code path as the BriefModal in ArtistDashboard.
//
// What it does NOT do:
//   - No sidebar / no CRM shell. This is a focused viewer that
//     trades CRM chrome for screen real estate.
//   - No review controls (approve/reject). The reviewer goes back
//     to the QA tab for that.
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

  // Download-all state.
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  // Keyboard nav for the lightbox: Esc closes, arrows step through.
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
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen, references.length]);

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
          // Wider thumbs than the inline QA refs grid since this
          // page is dedicated to references — let them breathe.
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
          className="crm-lightbox"
          onClick={() => setLightboxIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Reference image"
          style={{
            // Defensive inline styling — the CSS class targets
            // .crm-root .crm-lightbox, but if the cascade somehow
            // misses, these ensure the overlay still fills the
            // viewport and centers its content with padding.
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
            src={references[lightboxIndex].image_url}
            alt="Reference (enlarged)"
            onClick={(e) => e.stopPropagation()}
            style={{
              // Hard cap on dimensions so a tall portrait image
              // can't blow past the viewport. object-fit doesn't
              // do anything here (the <img> isn't a sized box),
              // so we use max-width / max-height directly.
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
