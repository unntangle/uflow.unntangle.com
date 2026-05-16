'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import JSZip from 'jszip';
import StatusBadge from '../components/StatusBadge';
import Sidebar from '../components/Sidebar';
import { crmFetch, crmPath } from '../lib/client-fetch';

// ============================================================
// Types — mirror the server's joined select shape
// ============================================================
type Project = {
  id: string;
  slug: string;
  name: string;
  // The artist only ever sees the statuses they care about. EQA-
  // related states (client_review, eqa_rejected) and the
  // approval state are still possible values from the wire, but
  // their action cell renders nothing actionable for the artist.
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
  zip_url: string | null;
  glb_url: string | null;
  approved_glb_url: string | null;
  assigned_to: string | null;
  brief: string | null;
  updated_at: string;
  client: { slug: string; name: string };
};

type ReferenceImage = {
  id: string;
  image_url: string;
  created_at: string;
};

export default function ArtistDashboard({
  initialProjects,
  currentUser,
}: {
  initialProjects: Project[];
  currentUser: { name: string; role: '3d_artist' };
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [uploadFor, setUploadFor] = useState<Project | null>(null);
  const [viewBrief, setViewBrief] = useState<Project | null>(null);
  // Per-project Start button state. We track which row is in flight
  // so concurrent clicks on different rows don't interfere; keyed by
  // project id rather than a single shared flag.
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [startErr, setStartErr] = useState<string | null>(null);

  function refreshList() {
    crmFetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        if (d.projects) {
          const norm = d.projects.map(
            (p: Project & { client: Project['client'] | Project['client'][] }) => ({
              ...p,
              client: Array.isArray(p.client) ? p.client[0] : p.client,
            })
          );
          setProjects(norm);
        }
      });
  }

  async function startProject(p: Project) {
    if (starting[p.id]) return;
    setStarting((s) => ({ ...s, [p.id]: true }));
    setStartErr(null);
    try {
      const res = await crmFetch(`/api/projects/${p.id}/start`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setStartErr(data.error || 'Could not start project.');
        return;
      }
      // Optimistically flip this row locally so the action column
      // re-renders to show Re-upload without waiting for the list
      // refresh round-trip. The exact target depends on what
      // we're transitioning from — mirror the server's branching
      // so the optimistic state matches what the server actually
      // wrote.
      const optimisticStatus: Project['status'] =
        p.status === 'iqa_rejected' ? 'iqa_wip' :
        p.status === 'eqa_rejected' ? 'eqa_wip' :
        'wip';
      setProjects((prev) =>
        prev.map((row) =>
          row.id === p.id ? { ...row, status: optimisticStatus } : row
        )
      );
      // Then refresh from the server to pick up updated_at etc.
      refreshList();
      router.refresh();
    } catch (e) {
      setStartErr((e as Error).message);
    } finally {
      setStarting((s) => ({ ...s, [p.id]: false }));
    }
  }

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />
      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">My Jobs</h1>
              <p className="crm-page-sub">
                Projects assigned to you. Open a brief to see what&apos;s needed, then upload your zip.
              </p>
            </div>
          </header>

          {startErr && (
            <div className="crm-error" style={{ marginTop: 12 }}>
              {startErr}
            </div>
          )}

          {projects.length === 0 ? (
            <div className="crm-empty">
              <h3>No jobs assigned</h3>
              <p>You&apos;ll see new jobs here when an admin assigns one to you.</p>
            </div>
          ) : (
            <table className="crm-table">
              <thead>
                <tr>
                  {/* Client column intentionally omitted from the
                      artist view — artists shouldn't see which
                      client commissioned a job. The data still
                      flows through `project.client` (used in API
                      calls and folder paths) but is never
                      rendered to the artist. */}
                  <th style={{ width: '26%' }}>Project</th>
                  <th>Brief</th>
                  <th>Reference</th>
                  <th>Revision Round</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong style={{ display: 'block' }}>{p.name}</strong>
                      <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                        {p.slug}
                      </span>
                    </td>
                    <td>
                      <a
                        className="crm-link"
                        onClick={() => setViewBrief(p)}
                        style={{ cursor: 'pointer' }}
                      >
                        View
                      </a>
                    </td>
                    <td>
                      {/* References gallery opens in a new tab —
                          same destination admin/client use. The
                          server-side page applies role scoping
                          (artist only sees refs on jobs assigned
                          to them). */}
                      <a
                        href={crmPath(`/admin/qa/${p.id}/references`)}
                        target="_blank"
                        rel="noreferrer"
                        className="crm-link"
                      >
                        View
                      </a>
                    </td>
                    <td>
                      {/* Revision Round. Shows the latest rejection
                          round as a clickable number. The
                          standalone feedback gallery (opened in a
                          new tab) has its own revision picker, so
                          we don't need a dropdown here — the
                          gallery covers "see an earlier round".
                          - 0 rejections : em-dash placeholder
                          - N rejections : single "N" hyperlink to
                                           the gallery */}
                      {p.revision_count === 0 ? (
                        <span style={{ color: 'var(--text-faint)', fontSize: 13 }}>
                          —
                        </span>
                      ) : (
                        <a
                          className="crm-link"
                          href={crmPath(
                            `/projects/${p.id}/feedback?revision=${p.revision_count}`
                          )}
                          target="_blank"
                          rel="noreferrer"
                          title={`View feedback for revision ${p.revision_count}`}
                        >
                          {p.revision_count}
                        </a>
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        status={p.status}
                        revisionCount={p.revision_count}
                        // The artist is always the assigned user on
                        // rows they can see, so a draft row here is
                        // always YTS (never YTA — the YTA tab is
                        // admin-only).
                        assigned={p.assigned_to !== null}
                      />
                    </td>
                    <td style={{ color: 'var(--text-dim)' }}>
                      {new Date(p.updated_at).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {/*
                        Action cell is status-aware. Each project state
                        gets exactly one action affordance now that
                        revision history has moved to its own column:

                          draft         → Start  (acknowledge brief, move to WIP)
                          qa_pending    → "Awaiting QA review"
                          iqa_rejected  → Start  (acknowledge admin's feedback)
                          eqa_rejected  → Start  (acknowledge client's feedback)
                          wip           → Upload zip / Re-upload (no draft step)
                          approved      → View GLB
                          client_review → (admin/client handling — no artist action)

                        Draft, IQA Rejected, and EQA Rejected all
                        gate on Start so the artist explicitly
                        engages with the brief / feedback before
                        WIP opens up. From WIP, the artist can
                        upload (first time) or re-upload (subsequent
                        revisions) — same button label either way
                        since revision_count tracks the difference.
                      */}
                      {p.status === 'draft' && (
                        <button
                          className="crm-btn"
                          onClick={() => startProject(p)}
                          disabled={!!starting[p.id]}
                        >
                          {starting[p.id] ? 'Starting…' : 'Start'}
                        </button>
                      )}
                      {p.status === 'qa_pending' && (
                        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                          Awaiting QA review
                        </span>
                      )}
                      {(p.status === 'iqa_rejected' ||
                        p.status === 'eqa_rejected') && (
                        <button
                          className="crm-btn"
                          onClick={() => startProject(p)}
                          disabled={!!starting[p.id]}
                        >
                          {starting[p.id] ? 'Starting…' : 'Start'}
                        </button>
                      )}
                      {p.status === 'wip' ||
                      p.status === 'iqa_wip' ||
                      p.status === 'eqa_wip' ? (
                        <button className="crm-btn" onClick={() => setUploadFor(p)}>
                          {p.revision_count === 0 ? 'Upload zip' : 'Re-upload'}
                        </button>
                      ) : null}
                      {p.status === 'approved' && p.approved_glb_url && (
                        <a
                          className="crm-btn crm-btn-secondary"
                          href={p.approved_glb_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View GLB
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {uploadFor && (
        <UploadModal
          project={uploadFor}
          onClose={() => setUploadFor(null)}
          onDone={() => {
            setUploadFor(null);
            refreshList();
            router.refresh();
          }}
        />
      )}
      {viewBrief && (
        <BriefModal project={viewBrief} onClose={() => setViewBrief(null)} />
      )}
    </div>
  );
}

// ============================================================
// Brief modal — shows the admin's brief text + reference images
// ============================================================
function BriefModal({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [refs, setRefs] = useState<ReferenceImage[] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  if (refs === null) {
    crmFetch(`/api/projects/${project.id}/references`)
      .then((r) => r.json())
      .then((d) => setRefs(d.references || []));
  }

  // ----- Download all reference images as a single zip -----
  // We fetch each public R2 URL from the browser (the bucket is
  // public-read), stitch the bytes into one zip via JSZip, then
  // trigger a save via a temporary <a download>. Entirely
  // client-side — no server round-trip, no R2 writes.
  //
  // Individual fetch failures are tolerated: a failed image is
  // skipped and the zip is built from whatever did succeed. A
  // total failure (zero images downloaded) surfaces an error
  // instead of writing an empty zip.
  async function downloadAll() {
    if (!refs || refs.length === 0 || downloading) return;
    setDownloading(true);
    setDownloadErr(null);
    try {
      const zip = new JSZip();
      let ok = 0;
      // Fetch in parallel, but limit concurrency implicitly by
      // just kicking everything off — the browser caps simultaneous
      // connections to a single origin (typically 6), which is
      // plenty for ~12 images. For larger ref sets we'd want a
      // pool, but reference counts are bounded to 20 server-side.
      await Promise.all(
        refs.map(async (r, i) => {
          try {
            const res = await fetch(r.image_url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            // Filename: "reference-01.jpg" — zero-padded so the
            // zip lists them in upload order even on Windows.
            const ext = (() => {
              const m = r.image_url.match(/\.([a-z0-9]+)(?:\?|$)/i);
              return m ? m[1].toLowerCase() : 'jpg';
            })();
            const num = String(i + 1).padStart(2, '0');
            zip.file(`reference-${num}.${ext}`, blob);
            ok++;
          } catch {
            // Skip this image; the rest still go into the zip.
          }
        })
      );

      if (ok === 0) {
        setDownloadErr('Could not download any of the reference images.');
        return;
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      // Trigger a save without leaving the page or opening a tab.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.slug}-references.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Let the browser flush the download before revoking the blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadErr((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="crm-modal-backdrop" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crm-modal-header">
          <div>
            <h2 className="crm-modal-title">Job Brief</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>
              {project.name}
            </p>
          </div>
          <button className="crm-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="crm-form-group">
          <label className="crm-label">Brief</label>
          {project.brief ? (
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14 }}>
              {project.brief}
            </p>
          ) : (
            <p style={{ color: 'var(--text-dim)', margin: 0, fontSize: 13 }}>
              No written brief was attached.
            </p>
          )}
        </div>

        <div className="crm-form-group" style={{ marginTop: 20 }}>
          {/* Header row with the section label on the left and the
              download-all button on the right, only when refs exist. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <label className="crm-label" style={{ margin: 0 }}>
              Reference images
              {refs && refs.length > 0 && (
                <span
                  style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}
                >
                  ({refs.length})
                </span>
              )}
            </label>
            {refs && refs.length > 0 && (
              <button
                className="crm-btn crm-btn-secondary"
                onClick={downloadAll}
                disabled={downloading}
              >
                {downloading ? 'Preparing…' : 'Download all'}
              </button>
            )}
          </div>

          {refs === null ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>
              Loading…
            </p>
          ) : refs.length === 0 ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>
              No reference images.
            </p>
          ) : (
            <div className="crm-feedback-grid">
              {refs.map((r) => (
                <a
                  key={r.id}
                  href={r.image_url}
                  target="_blank"
                  rel="noreferrer"
                  className="crm-feedback-thumb"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.image_url} alt="reference" />
                </a>
              ))}
            </div>
          )}

          {downloadErr && (
            <div className="crm-error" style={{ marginTop: 10 }}>
              {downloadErr}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Upload zip modal
// ============================================================
function UploadModal({
  project,
  onClose,
  onDone,
}: {
  project: Project;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [stage, setStage] = useState<'idle' | 'signing' | 'uploading' | 'finalizing'>('idle');
  const [, startTransition] = useTransition();

  async function submit() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setProgress(0);

    try {
      setStage('signing');
      const signRes = await crmFetch(
        `/api/projects/${project.id}/upload-sign`,
        { method: 'POST' }
      );
      const signData = await signRes.json();
      if (!signRes.ok) {
        setErr(signData.error || 'Could not start upload.');
        return;
      }

      setStage('uploading');
      // R2 wants a raw PUT with the file body — no FormData, no
      // extra fields. The Content-Type must match what was signed.
      await uploadWithProgress(
        signData.upload_url,
        file,
        'application/zip',
        setProgress
      );
      // The public URL was already returned by the sign endpoint;
      // we don't need to parse anything out of the PUT response.
      const zipUrl = signData.public_url as string;

      setStage('finalizing');
      const finRes = await crmFetch(
        `/api/projects/${project.id}/finalize-upload`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            zip_url: zipUrl,
            revision: signData.revision,
          }),
        }
      );
      const finData = await finRes.json();
      if (!finRes.ok) {
        setErr(finData.error || 'Server could not process the zip.');
        return;
      }

      startTransition(() => onDone());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setStage('idle');
    }
  }

  const stageLabel =
    stage === 'signing'    ? 'Preparing…' :
    stage === 'uploading'  ? `Uploading… ${progress}%` :
    stage === 'finalizing' ? 'Extracting zip (may take a minute)…' :
    'Submit for QA';

  return (
    <div className="crm-modal-backdrop" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="crm-modal-header">
          <div>
            <h2 className="crm-modal-title">Upload zip</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>
              {project.name}
            </p>
          </div>
          <button className="crm-modal-close" onClick={onClose}>×</button>
        </div>

        <div
          className={`crm-dropzone ${drag ? 'is-drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f && f.name.toLowerCase().endsWith('.zip')) setFile(f);
          }}
          onClick={() => document.getElementById('zip-input')?.click()}
        >
          <input
            id="zip-input"
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
            }}
          />
          {file ? (
            <>
              <strong>{file.name}</strong>
              <div className="crm-dropzone-hint">
                {(file.size / 1024 / 1024).toFixed(1)} MB · click to replace
              </div>
            </>
          ) : (
            <>
              <strong>Click or drop your .zip file</strong>
              <div className="crm-dropzone-hint">
                Must contain folders: <code>fbx/</code> <code>glb/</code> <code>gltf/</code>
                <br />
                Max 90 MB.
              </div>
            </>
          )}
        </div>

        {busy && stage === 'uploading' && (
          <div
            style={{
              marginTop: 14,
              height: 6,
              background: 'var(--surface-2)',
              borderRadius: 999,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: 'var(--accent)',
                transition: 'width 0.2s',
              }}
            />
          </div>
        )}

        {err && <div className="crm-error" style={{ marginTop: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="crm-btn crm-btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="crm-btn" onClick={submit} disabled={!file || busy}>
            {busy ? stageLabel : 'Submit for QA'}
          </button>
        </div>
      </div>
    </div>
  );
}

function uploadWithProgress(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // The signed URL pins the Content-Type; the browser must send
    // it back exactly or R2 rejects the PUT with a signature error.
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // R2 PUT returns an empty body; success is just the 2xx.
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText || 'no body'}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}
