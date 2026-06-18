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
  approved_glb_url: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  references: Reference[];
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
  const [glbBusyId, setGlbBusyId] = useState<string | null>(null);
  const [glbErr, setGlbErr] = useState<{ id: string; message: string } | null>(
    null
  );
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

  // ---- Download the GLB through our proxy endpoint (forces a
  // real file save, resolves the latest revision server-side).
  async function downloadGlb(p: Project) {
    if (!p.glb_url || glbBusyId) return;
    setGlbBusyId(p.id);
    setGlbErr(null);
    try {
      const res = await crmFetch(`/api/projects/${p.id}/download`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setGlbErr({
          id: p.id,
          message: data?.error || `Download failed (${res.status}).`,
        });
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.slug}.glb`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setGlbErr({ id: p.id, message: (err as Error).message || 'Network error.' });
    } finally {
      setGlbBusyId(null);
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
                View or download each job&rsquo;s 3D model and reference
                images. A dash means that asset isn&rsquo;t available yet.
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
            <table className="crm-table">
              <thead>
                <tr>
                  <SortableTh label="Project" sortKey="name" sort={sort} onSort={onSort} />
                  <SortableTh label="Artist" sortKey="artist" sort={sort} onSort={onSort} />
                  <SortableTh label="Client" sortKey="client" sort={sort} onSort={onSort} />
                  <SortableTh label="Created" sortKey="created" sort={sort} onSort={onSort} />
                  <SortableTh label="Updated" sortKey="updated" sort={sort} onSort={onSort} />
                  <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                  <th style={thCenter}>GLB</th>
                  <th style={thCenter}>Reference</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const glbError = glbErr?.id === p.id ? glbErr.message : null;
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
                      <td>{p.client.name}</td>
                      <td style={{ color: 'var(--text-dim)' }}>
                        {new Date(p.created_at).toLocaleDateString()}
                      </td>
                      <td style={{ color: 'var(--text-dim)' }}>
                        {new Date(p.updated_at).toLocaleDateString()}
                      </td>
                      <td>
                        <StatusBadge
                          status={p.status}
                          revisionCount={p.revision_count}
                          assigned={p.assigned_to !== null}
                        />
                      </td>

                      {/* ---- GLB (3D model) ---- */}
                      <AssetCell
                        present={!!p.glb_url}
                        busy={glbBusyId === p.id}
                        error={glbError}
                        onView={() => viewGlb(p)}
                        onDownload={() => downloadGlb(p)}
                        viewTitle="View 3D model"
                        downloadTitle="Download GLB"
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
  onView: () => void;
  onDownload: () => void;
  viewTitle: string;
  downloadTitle: string;
}) {
  return (
    <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
      {present ? (
        <span style={iconRow}>
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
