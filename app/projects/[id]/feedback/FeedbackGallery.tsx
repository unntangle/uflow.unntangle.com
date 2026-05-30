'use client';

import { useEffect, useState } from 'react';
import { Download, X, ChevronLeft, ChevronRight } from 'lucide-react';
import JSZip from 'jszip';

// ============================================================
// FeedbackGallery — standalone page rendered at
//   /projects/[id]/feedback?revision=N
//
// Opened in a new tab from the artist / client / admin
// dashboards' Revision Round column. Replaces the inline modal
// that used to do the same job — page form gives:
//   - more screen real estate for full-resolution screenshots
//   - durable URL the user can bookmark or share
//   - keyboard navigation via the lightbox (Esc + arrows)
//
// Layout mirrors ReferencesGallery (same lightbox, same
// "Download all" zip button); the only differences are
// grouping by revision and an escape hatch when a single-
// revision filter has zero rows.
// ============================================================

type Project = {
  id: string;
  slug: string;
  name: string;
  client: { slug: string; name: string };
};

type Item = {
  id: string;
  revision: number;
  image_url: string;
  note: string | null;
  created_at: string;
};

export default function FeedbackGallery({
  project,
  items,
  revisionFilter,
  availableRevisions,
  source,
}: {
  project: Project;
  items: Item[];
  // null = showing all revisions; otherwise the single revision
  // the page is currently filtered to.
  revisionFilter: number | null;
  // Every revision that has at least one feedback row in the
  // selected source. Used to render the "Show all revisions (N)"
  // link when the filter has zero rows, and to populate the
  // dropdown when there are several.
  availableRevisions: number[];
  // Which feedback table we're reading from. Drives the page
  // title + the empty-state wording so a client viewing their
  // own feedback sees "You didn't reject revision N" rather
  // than the generic empty state.
  source: 'admin' | 'client';
}) {
  // Lightbox: null = closed, otherwise an index into items[].
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxOpen = lightboxIndex !== null;

  // Download-all state. Keyed per-revision so the modal-level
  // download can run concurrently with a per-revision one.
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  // Group items by revision (newest first). When the page is
  // filtered to a single revision, there's only one group, but
  // we still use the same structure to keep render uniform.
  const groups: Record<number, Item[]> = {};
  items.forEach((f) => {
    (groups[f.revision] ||= []).push(f);
  });
  const visibleRevisions = Object.keys(groups)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => b - a);

  // Source-aware copy. Keeps the page self-explanatory whether
  // it's an artist looking at admin's feedback or a client
  // looking at their own.
  const pageTitle =
    source === 'admin' ? 'QA Feedback' : 'Your Feedback';
  const emptyTitle =
    revisionFilter !== null
      ? source === 'client'
        ? `You didn't reject revision ${revisionFilter}.`
        : `No feedback for revision ${revisionFilter} yet.`
      : source === 'client'
      ? "You haven't rejected this project yet."
      : 'No feedback yet.';

  // ----- Keyboard nav for the lightbox -----
  useEffect(() => {
    if (!lightboxOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxIndex(null);
      else if (e.key === 'ArrowLeft') {
        setLightboxIndex((i) =>
          i === null ? i : (i - 1 + items.length) % items.length
        );
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex((i) => (i === null ? i : (i + 1) % items.length));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen, items.length]);

  // ----- Download helper -----
  // Pulled out as a reusable function so the modal-level
  // "Download all" and the per-revision buttons share the same
  // JSZip + temporary <a download> mechanic. Individual fetch
  // failures are skipped so one broken URL doesn't kill the zip.
  function extOf(url: string): string {
    const m = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
    return m ? m[1].toLowerCase() : 'jpg';
  }
  async function downloadImages(
    key: string,
    images: Item[],
    filename: string,
    pathFor: (img: Item, index: number) => string
  ) {
    if (images.length === 0 || downloading[key]) return;
    setDownloading((d) => ({ ...d, [key]: true }));
    setDownloadErr(null);
    try {
      const zip = new JSZip();
      let ok = 0;
      await Promise.all(
        images.map(async (img, i) => {
          try {
            const res = await fetch(img.image_url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            zip.file(pathFor(img, i), blob);
            ok++;
          } catch {
            // Skip; continue with the rest.
          }
        })
      );
      if (ok === 0) {
        setDownloadErr('Could not download any of the feedback images.');
        return;
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadErr((e as Error).message);
    } finally {
      setDownloading((d) => ({ ...d, [key]: false }));
    }
  }

  async function downloadAll() {
    await downloadImages(
      '__all',
      items,
      `${project.slug}-feedback.zip`,
      (img) => {
        // When the page covers multiple revisions, segment the
        // zip by revision so the recipient can see which round
        // each image belongs to. With a single revision filter,
        // we still keep the same path scheme for consistency.
        const inRev = groups[img.revision]
          ? groups[img.revision].indexOf(img)
          : 0;
        const num = String(inRev + 1).padStart(2, '0');
        return `revision-${img.revision}/feedback-${num}.${extOf(img.image_url)}`;
      }
    );
  }
  async function downloadRevision(rev: number) {
    await downloadImages(
      String(rev),
      groups[rev] || [],
      `${project.slug}-revision-${rev}-feedback.zip`,
      (img, i) => {
        const num = String(i + 1).padStart(2, '0');
        return `feedback-${num}.${extOf(img.image_url)}`;
      }
    );
  }

  // ----- Render -----

  // Helper: build a URL to the same gallery scoped to a specific
  // revision (or to "all" when rev=null). Preserves the source
  // param so admins viewing the client-side feedback don't get
  // bumped back to the admin side when switching revisions.
  function hrefForRevision(rev: number | null): string {
    const base = `/projects/${project.id}/feedback`;
    const params = new URLSearchParams();
    if (rev !== null) params.set('revision', String(rev));
    if (source === 'client') params.set('source', 'client');
    const q = params.toString();
    return q ? `${base}?${q}` : base;
  }

  // Controlled value for the revision <select>. It MUST always
  // correspond to a rendered <option>; otherwise React holds a
  // value that matches nothing, a controlled/uncontrolled
  // mismatch that triggers a hydration error and makes the page
  // flicker on load. The 'all' sentinel only has a matching
  // option when there are 2+ revisions, so with a single
  // revision we fall back to that revision's own value (the
  // "all" and single-revision views are identical anyway).
  const revisionSelectValue =
    revisionFilter !== null
      ? String(revisionFilter)
      : availableRevisions.length > 1
      ? 'all'
      : availableRevisions.length === 1
      ? String(availableRevisions[0])
      : 'all';

  return (
    <div className="crm-page">
      <header className="crm-page-header">
        <div>
          <h1 className="crm-page-title">{pageTitle}</h1>
          <p className="crm-page-sub">
            {project.client.name} · {project.name}
            {revisionFilter !== null
              ? ` · ${items.length} image${items.length === 1 ? '' : 's'}`
              : availableRevisions.length > 0
              ? ` · ${items.length} image${items.length === 1 ? '' : 's'} across ${availableRevisions.length} revision${availableRevisions.length === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Revision picker. Always rendered when there's at
              least one revision so the user can see which round
              they're viewing even when there's only one. Selecting
              a different revision navigates to a new URL so the
              back button still works and the URL stays shareable.
              Hidden only when there are zero revisions — a picker
              for nothing serves no purpose.

              Note on options: "All revisions" only appears when
              there are 2+, since with a single revision the
              "all" view and the single-revision view show the
              same content. */}
          {availableRevisions.length >= 1 && (
            <select
              className="crm-input"
              value={revisionSelectValue}
              onChange={(e) => {
                const v = e.target.value;
                const href =
                  v === 'all' ? hrefForRevision(null) : hrefForRevision(parseInt(v, 10));
                // Same-tab navigation: the user opened this page
                // from the dashboard and wants to switch within
                // it, not stack new tabs.
                window.location.href = href;
              }}
              style={{
                padding: '6px 10px',
                fontSize: 13,
                minWidth: 160,
              }}
              aria-label="Choose revision"
            >
              {availableRevisions.length > 1 && (
                <option value="all">
                  All revisions ({availableRevisions.length})
                </option>
              )}
              {availableRevisions.map((rev) => (
                <option key={rev} value={rev}>
                  Revision {rev}
                </option>
              ))}
            </select>
          )}

          {items.length > 0 && (
            <button
              type="button"
              className="crm-btn crm-btn-secondary"
              onClick={downloadAll}
              disabled={!!downloading['__all']}
              // whiteSpace:nowrap prevents the label breaking onto
              // two lines now that the header also holds the
              // revision picker; the row can get tight on narrower
              // viewports and the wrapped "all (zip)" looked off.
              style={{ whiteSpace: 'nowrap' }}
            >
              <Download size={14} strokeWidth={1.75} aria-hidden="true" />
              {downloading['__all'] ? 'Preparing…' : 'Download all'}
            </button>
          )}
        </div>
      </header>

      {downloadErr && (
        <div className="crm-error" style={{ marginBottom: 16 }}>
          {downloadErr}
        </div>
      )}

      {items.length === 0 ? (
        <div className="crm-empty">
          <h3>{emptyTitle}</h3>
          {/* Offer a one-click widening when a filter is active
              and there's at least one other revision with rows. */}
          {revisionFilter !== null && availableRevisions.length > 0 && (
            <p>
              <a className="crm-link" href={hrefForRevision(null)}>
                Show all revisions ({availableRevisions.length})
              </a>
            </p>
          )}
        </div>
      ) : (
        <>
          {/* Filter banner — only shown when the page is filtered
              AND there's more than one revision to widen to. With
              the picker dropdown now in the header, this is a
              secondary affordance; we keep it for one-click "see
              everything" without using the dropdown. */}
          {revisionFilter !== null && availableRevisions.length > 1 && (
            <p style={{ fontSize: 13, marginBottom: 16 }}>
              <a className="crm-link" href={hrefForRevision(null)}>
                ← Show all revisions ({availableRevisions.length})
              </a>
            </p>
          )}

          {visibleRevisions.map((rev) => (
            <section key={rev} style={{ marginBottom: 32 }}>
              {/* Per-revision section header. We hide the title row
                  when the page is already filtered to a single
                  revision (the page subtitle already says "Revision
                  N" — a second header would be redundant). The
                  download button still shows so a per-revision zip
                  is one click away in both modes. */}
              {revisionFilter === null ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 12,
                  }}
                >
                  <h2
                    style={{
                      fontSize: 14,
                      margin: 0,
                      color: 'var(--text-dim)',
                    }}
                  >
                    Revision {rev}
                    <span
                      style={{
                        color: 'var(--text-faint)',
                        fontWeight: 400,
                        marginLeft: 8,
                      }}
                    >
                      ({groups[rev].length})
                    </span>
                  </h2>
                  <button
                    type="button"
                    className="crm-btn crm-btn-secondary"
                    onClick={() => downloadRevision(rev)}
                    disabled={!!downloading[String(rev)]}
                    style={{ padding: '4px 12px', fontSize: 12 }}
                    title={`Download revision ${rev} feedback images`}
                  >
                    <Download
                      size={12}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    {downloading[String(rev)] ? 'Preparing…' : 'Download'}
                  </button>
                </div>
              ) : null}

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 12,
                }}
              >
                {groups[rev].map((f) => {
                  // Lightbox indexing uses the flat items[]
                  // array so prev/next walks across revisions
                  // — same UX as ReferencesGallery.
                  const flatIndex = items.findIndex(
                    (x) => x.id === f.id
                  );
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className="crm-qa-ref-thumb"
                      onClick={() => setLightboxIndex(flatIndex)}
                      aria-label="Enlarge feedback image"
                      title={f.note || 'Click to enlarge'}
                      style={{
                        padding: 0,
                        border: '1px solid var(--border)',
                        cursor: 'zoom-in',
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={f.image_url} alt={f.note || 'feedback'} />
                    </button>
                  );
                })}
              </div>

              {/* Surface the admin's note for the revision (if
                  any). All rows in one revision share the same
                  note in current uploads, so picking the first
                  is fine. */}
              {groups[rev][0]?.note && (
                <p
                  style={{
                    marginTop: 12,
                    fontSize: 13,
                    color: 'var(--text-dim)',
                  }}
                >
                  Note: {groups[rev][0].note}
                </p>
              )}
            </section>
          ))}
        </>
      )}

      {/* Lightbox overlay */}
      {lightboxOpen && lightboxIndex !== null && (
        <div
          className="crm-lightbox"
          onClick={() => setLightboxIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Feedback image"
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
            src={items[lightboxIndex].image_url}
            alt={items[lightboxIndex].note || 'Feedback (enlarged)'}
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
          {items.length > 1 && (
            <>
              <button
                type="button"
                className="crm-lightbox-arrow is-prev"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) =>
                    i === null
                      ? i
                      : (i - 1 + items.length) % items.length
                  );
                }}
                aria-label="Previous feedback image"
              >
                <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="crm-lightbox-arrow is-next"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) =>
                    i === null ? i : (i + 1) % items.length
                  );
                }}
                aria-label="Next feedback image"
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
