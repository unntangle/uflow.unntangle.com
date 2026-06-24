'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Eye, Download } from 'lucide-react';
import JSZip from 'jszip';
import Sidebar from '../../../components/Sidebar';
import StatusBadge from '../../../components/StatusBadge';
import {
  CLIENT_FILTER_EVENT,
  getStoredClientId,
} from '../../../components/ClientSwitcher';
import { crmPath, crmFetch } from '../../../lib/client-fetch';
import { ProjectStatus } from '../../../lib/supabase';
import {
  useTableSort,
  SortableTh,
  statusRank,
} from '../../../lib/use-table-sort';

// ============================================================
// Types
// ============================================================
type Reference = { id: string; image_url: string };

type Project = {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  revision_count: number;
  assigned_to: string | null;
  glb_url: string | null;
  fbx_url: string | null;
  gltf_url: string | null;
  zip_url: string | null;
  spp_url: string | null;
  approved_glb_url: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  references: Reference[];
  // Distinct rejection rounds, computed server-side.
  iqa_count: number; // admin / internal QA rejections
  eqa_count: number; // client / external QA rejections
};

// ============================================================
// DownloadJobsPage
//
// The per-job asset hub. Same flat all-status index as List Jobs
// (brand filter + search + sort), with two compact asset columns:
//
//   GLB        → view (3D model viewer) + download (.glb)
//   Reference  → view (image gallery)   + download (.zip)
//
// Each is a pair of icon buttons to keep the row tight. The two
// "view" actions reuse the existing standalone viewer + gallery
// pages (opened in a new tab, same as the QA screens). The GLB
// download proxies through our own endpoint so the browser saves
// a real <slug>.glb (latest revision resolved server-side); the
// reference download zips the images client-side like the
// gallery's "Download all".
//
// GLB and references are independent — a job may have one, both,
// or neither — so each column shows a muted dash when its asset
// is absent.
// ============================================================
export default function DownloadJobsPage({
  initialProjects,
  currentUser,
}: {
  initialProjects: Project[];
  currentUser: { name: string; role: 'admin' };
}) {
  const [projects] = useState<Project[]>(initialProjects);
  const [query, setQuery] = useState('');

  // Independent per-row pending/error state for the two download
  // actions, so zipping references doesn't disable the GLB button
  // (or vice-versa) and an error sticks to the action that raised it.
  // Generic per-asset download state, keyed by `${projectId}:${type}`
  // so each of the GLB / FBX / SPP / Source buttons tracks its own
  // pending + error independently (zipping references is separate).
  const [assetBusy, setAssetBusy] = useState<string | null>(null);
  const [assetErr, setAssetErr] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [refBusyId, setRefBusyId] = useState<string | null>(null);
  const [refErr, setRefErr] = useState<{ id: string; message: string } | null>(
    null
  );

  // ---- View actions: open the existing standalone viewers in a
  // new tab, exactly as the QA review screens do.
  function viewGlb(p: Project) {
    window.open(
      crmPath(`/admin/qa/${p.id}/model`),
      '_blank',
      'noopener,noreferrer'
    );
  }
  function viewReferences(p: Project) {
    window.open(
      crmPath(`/admin/qa/${p.id}/references`),
      '_blank',
      'noopener,noreferrer'
    );
  }

  // ---- Download a server-proxied asset (GLB / FBX / SPP / Source
  // zip) through our endpoint. The server resolves the latest URL
  // for the requested type and streams it with a clean filename.
  async function downloadAsset(
    p: Project,
    type: 'glb' | 'fbx' | 'spp' | 'zip',
    present: boolean,
    filename: string
  ) {
    const key = `${p.id}:${type}`;
    if (!present || assetBusy) return;
    setAssetBusy(key);
    setAssetErr(null);
    try {
      const res = await crmFetch(
        `/api/projects/${p.id}/download?type=${type}`
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAssetErr({
          key,
          message: data?.error || `Download failed (${res.status}).`,
        });
        return;
      }
      const blob = await res.blob();
      // Honor the server's filename when it sets one (FBX comes back
      // as a <slug>-fbx.zip folder, not a single .fbx), falling back
      // to the requested name for everything else.
      const cd = res.headers.get('content-disposition') || '';
      const cdMatch = cd.match(/filename="?([^";]+)"?/i);
      const saveName = cdMatch ? cdMatch[1] : filename;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = saveName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setAssetErr({
        key,
        message: (err as Error).message || 'Network error.',
      });
    } finally {
      setAssetBusy(null);
    }
  }

  // ---- Zip + save the reference images. Mirrors the gallery's
  // download-all: fetch each image, add it under a sequential
  // name, skip failures, only error out if none could be fetched.
  async function downloadReferences(p: Project) {
    if (p.references.length === 0 || refBusyId) return;
    setRefBusyId(p.id);
    setRefErr(null);
    try {
      const zip = new JSZip();
      let ok = 0;
      await Promise.all(
        p.references.map(async (r, i) => {
          try {
            const res = await fetch(r.image_url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const m = r.image_url.match(/\.([a-z0-9]+)(?:\?|$)/i);
            const ext = m ? m[1].toLowerCase() : 'jpg';
            const num = String(i + 1).padStart(2, '0');
            zip.file(`reference-${num}.${ext}`, blob);
            ok++;
          } catch {
            // Skip and keep going.
          }
        })
      );
      if (ok === 0) {
        setRefErr({
          id: p.id,
          message: 'Could not download the reference images.',
        });
        return;
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.slug}-references.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setRefErr({ id: p.id, message: (err as Error).message || 'Network error.' });
    } finally {
      setRefBusyId(null);
    }
  }

  // ---- Brand filter, synced with the sidebar ClientSwitcher.
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedClientId(getStoredClientId());
    function onChange() {
      setSelectedClientId(getStoredClientId());
    }
    window.addEventListener(CLIENT_FILTER_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CLIENT_FILTER_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (selectedClientId && p.client_id !== selectedClientId) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)
      );
    });
  }, [projects, selectedClientId, query]);

  const { sorted, sort, onSort } = useTableSort(visible, {
    name: (p) => p.name,
    artist: (p) => p.assignee?.name ?? null,
    client: (p) => p.client.name,
    created: (p) => new Date(p.created_at),
    updated: (p) => new Date(p.updated_at),
    status: (p) => statusRank(p.status),
  });

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Download Jobs</h1>
              <p className="crm-page-sub">
                View or download each job&rsquo;s model files (GLB, FBX, SPP),
                source zip and reference images, plus its IQA/EQA revision
                counts. A dash means that asset isn&rsquo;t available yet.
              </p>
            </div>
          </header>

          {/* Search box. Filters the in-memory list on name + slug. */}
          <div style={{ marginBottom: 16, maxWidth: 360 }}>
            <input
              className="crm-input"
              type="search"
              placeholder="Search by name or slug…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {visible.length === 0 ? (
            <EmptyMini
              message={
                query.trim()
                  ? `No jobs match “${query.trim()}”.`
                  : 'No jobs to show.'
              }
            />
          ) : (
            <table className="crm-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <thead>
                <tr>
                  <SortableTh label="Project" sortKey="name" sort={sort} onSort={onSort} />
                  <SortableTh label="Artist" sortKey="artist" sort={sort} onSort={onSort} />
                  <SortableTh label="Uploaded" sortKey="updated" sort={sort} onSort={onSort} />
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                  <th style={thCenter}>IQA</th>
                  <th style={thCenter}>EQA</th>
                  <th style={thCenter}>GLB</th>
                  <th style={thCenter}>FBX</th>
                  <th style={thCenter}>SPP</th>
                  <th style={thCenter}>Source</th>
                  <th style={thCenter}>Reference</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const assetErrFor = (type: string) =>
                    assetErr?.key === `${p.id}:${type}` ? assetErr.message : null;
                  const assetBusyFor = (type: string) =>
                    assetBusy === `${p.id}:${type}`;
                  const refError = refErr?.id === p.id ? refErr.message : null;
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong style={{ display: 'block' }}>{p.name}</strong>
                        <span
                          style={{ color: 'var(--text-faint)', fontSize: 12 }}
                        >
                          {p.slug}
                        </span>
                      </td>
                      <td>
                        {p.assignee?.name || (
                          <em style={{ color: 'var(--text-faint)' }}>
                            unassigned
                          </em>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-dim)' }}>
                        {new Date(p.updated_at).toLocaleString(undefined, {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true,
                        })}
                      </td>
                      <td>
                        <StatusBadge
                          status={p.status}
                          revisionCount={p.revision_count}
                          assigned={p.assigned_to !== null}
                        />
                      </td>

                      {/* ---- IQA rejection rounds ---- */}
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <span
                          style={revPill}
                          title="IQA — internal / admin rejection rounds"
                        >
                          {p.iqa_count}
                        </span>
                      </td>

                      {/* ---- EQA rejection rounds ---- */}
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <span
                          style={revPill}
                          title="EQA — external / client rejection rounds"
                        >
                          {p.eqa_count}
                        </span>
                      </td>

                      {/* ---- GLB (3D model) ---- */}
                      <AssetCell
                        present={!!p.glb_url}
                        busy={assetBusyFor('glb')}
                        error={assetErrFor('glb')}
                        onView={() => viewGlb(p)}
                        onDownload={() =>
                          downloadAsset(p, 'glb', !!p.glb_url, `${p.slug}.glb`)
                        }
                        viewTitle="View 3D model"
                        downloadTitle="Download GLB"
                      />

                      {/* ---- FBX (download only) ---- */}
                      <AssetCell
                        present={!!p.fbx_url}
                        busy={assetBusyFor('fbx')}
                        error={assetErrFor('fbx')}
                        onDownload={() =>
                          downloadAsset(p, 'fbx', !!p.fbx_url, `${p.slug}.fbx`)
                        }
                        downloadTitle="Download FBX folder (.zip)"
                      />

                      {/* ---- SPP (Substance Painter, download only) ---- */}
                      <AssetCell
                        present={!!p.spp_url}
                        busy={assetBusyFor('spp')}
                        error={assetErrFor('spp')}
                        onDownload={() =>
                          downloadAsset(p, 'spp', !!p.spp_url, `${p.slug}.spp`)
                        }
                        downloadTitle="Download SPP"
                      />

                      {/* ---- Source (complete .zip, download only) ---- */}
                      <AssetCell
                        present={!!p.zip_url}
                        busy={assetBusyFor('zip')}
                        error={assetErrFor('zip')}
                        onDownload={() =>
                          downloadAsset(
                            p,
                            'zip',
                            !!p.zip_url,
                            `${p.slug}-source.zip`
                          )
                        }
                        downloadTitle="Download source (.zip)"
                      />

                      {/* ---- Reference images ---- */}
                      <AssetCell
                        present={p.references.length > 0}
                        busy={refBusyId === p.id}
                        error={refError}
                        onView={() => viewReferences(p)}
                        onDownload={() => downloadReferences(p)}
                        viewTitle={`View references (${p.references.length})`}
                        downloadTitle="Download references (zip)"
                      />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}

// ============================================================
// AssetCell — a view + download icon pair (or a muted dash when
// the asset is absent). Shared by the GLB and Reference columns
// so both look and behave identically.
// ============================================================
function AssetCell({
  present,
  busy,
  error,
  onView,
  onDownload,
  viewTitle,
  downloadTitle,
}: {
  present: boolean;
  busy: boolean;
  error: string | null;
  onView?: () => void;
  onDownload: () => void;
  viewTitle?: string;
  downloadTitle: string;
}) {
  return (
    <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
      {present ? (
        <span style={iconRow}>
          {onView && (
            <button
              type="button"
              className="crm-btn crm-btn-ghost crm-btn-icon"
              style={iconBtn}
              onClick={onView}
              title={viewTitle}
              aria-label={viewTitle}
            >
              <Eye size={15} strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            className="crm-btn crm-btn-ghost crm-btn-icon"
            style={iconBtn}
            onClick={onDownload}
            disabled={busy}
            title={busy ? 'Working\u2026' : downloadTitle}
            aria-label={downloadTitle}
          >
            <Download size={15} strokeWidth={1.75} />
          </button>
        </span>
      ) : (
        <span style={muted}>—</span>
      )}
      {error && <div style={errStyle}>{error}</div>}
    </td>
  );
}

// ============================================================
// Inline style helpers
// ============================================================
const thCenter: CSSProperties = { textAlign: 'center', whiteSpace: 'nowrap' };
const iconRow: CSSProperties = {
  display: 'inline-flex',
  gap: 2,
  alignItems: 'center',
  justifyContent: 'center',
};
const iconBtn: CSSProperties = { padding: '4px 6px' };
const muted: CSSProperties = { color: 'var(--text-faint)' };
const errStyle: CSSProperties = { color: '#dc2626', fontSize: 11, marginTop: 2 };
const revPill: CSSProperties = {
  display: 'inline-block',
  minWidth: 18,
  padding: '1px 6px',
  borderRadius: 999,
  background: 'var(--surface-2, rgba(0,0,0,0.05))',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 12,
};

// ============================================================
// Helpers
// ============================================================
function EmptyMini({ message }: { message: string }) {
  return (
    <p
      style={{
        color: 'var(--text-dim)',
        padding: '16px 0 32px',
        fontSize: 13,
      }}
    >
      {message}
    </p>
  );
}
