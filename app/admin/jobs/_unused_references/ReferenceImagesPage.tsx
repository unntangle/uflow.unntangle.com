'use client';

import { useEffect, useMemo, useState } from 'react';
import { Eye, Download, ImageOff } from 'lucide-react';
import JSZip from 'jszip';
import Sidebar from '../../../components/Sidebar';
import {
  CLIENT_FILTER_EVENT,
  getStoredClientId,
} from '../../../components/ClientSwitcher';
import { crmPath } from '../../../lib/client-fetch';
import { useTableSort, SortableTh } from '../../../lib/use-table-sort';

// ============================================================
// Types
// ============================================================
type Reference = { id: string; image_url: string };

type Project = {
  id: string;
  slug: string;
  name: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client: { slug: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  references: Reference[];
};

// ============================================================
// ReferenceImagesPage
//
// Sibling of List Jobs / Download Jobs: same flat all-status
// index with the brand filter + search, but the focus is the
// reference images attached to each job.
//
//   - View     reuses the existing standalone gallery at
//              /admin/qa/[id]/references (thumbnail grid +
//              lightbox + keyboard nav), opened in a new tab the
//              same way the QA review screens open it. No need to
//              re-implement a viewer here.
//   - Download zips the job's references client-side with JSZip —
//              identical code path to that gallery's "Download
//              all" — and saves <slug>-references.zip.
//
// Jobs with no references render a muted "No references" state so
// the list still mirrors the full job index rather than dropping
// rows.
// ============================================================
export default function ReferenceImagesPage({
  initialProjects,
  currentUser,
}: {
  initialProjects: Project[];
  currentUser: { name: string; role: 'admin' };
}) {
  const [projects] = useState<Project[]>(initialProjects);
  const [query, setQuery] = useState('');

  // Per-row download state. `downloadingId` disables the button
  // and shows a pending label while the zip is being built;
  // `dlError` surfaces a failure against the row that triggered it.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [dlError, setDlError] = useState<{ id: string; message: string } | null>(
    null
  );

  // Open the existing references gallery in a new tab. It's a
  // standalone, sidebar-less viewer designed exactly for this.
  function viewReferences(p: Project) {
    window.open(
      crmPath(`/admin/qa/${p.id}/references`),
      '_blank',
      'noopener,noreferrer'
    );
  }

  // Zip + save a job's references. Mirrors the gallery's
  // download-all: fetch each image, add it to the archive with a
  // sequential name, skip any that fail, and only error out if
  // none could be fetched.
  async function downloadAll(p: Project) {
    if (p.references.length === 0 || downloadingId) return;
    setDownloadingId(p.id);
    setDlError(null);
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
            // Skip and keep going — a single bad URL shouldn't
            // sink the whole archive.
          }
        })
      );
      if (ok === 0) {
        setDlError({
          id: p.id,
          message: 'Could not download any of the reference images.',
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
      setDlError({
        id: p.id,
        message: (err as Error).message || 'Network error.',
      });
    } finally {
      setDownloadingId(null);
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
    images: (p) => p.references.length,
  });

  return (
    <div className="crm-shell">
      <Sidebar name={currentUser.name} role={currentUser.role} />

      <main className="crm-main">
        <div className="crm-page">
          <header className="crm-page-header">
            <div>
              <h1 className="crm-page-title">Reference Images</h1>
              <p className="crm-page-sub">
                Reference images attached to each job at creation. View opens
                the full gallery; Download saves them as a zip. Jobs created
                without references have nothing to show.
              </p>
            </div>
          </header>

          {/* Search box — filters on name + slug, same as the
              other job index pages. */}
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
                  <SortableTh label="Images" sortKey="images" sort={sort} onSort={onSort} />
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const count = p.references.length;
                  const hasRefs = count > 0;
                  const isDownloading = downloadingId === p.id;
                  const rowError = dlError?.id === p.id ? dlError.message : null;
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
                      <td style={{ color: hasRefs ? undefined : 'var(--text-faint)' }}>
                        {count}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div
                          style={{
                            display: 'inline-flex',
                            flexDirection: 'column',
                            alignItems: 'flex-end',
                            gap: 4,
                          }}
                        >
                          {hasRefs ? (
                            <div
                              style={{
                                display: 'inline-flex',
                                gap: 8,
                                justifyContent: 'flex-end',
                              }}
                            >
                              <button
                                type="button"
                                className="crm-btn crm-btn-ghost crm-btn-icon"
                                onClick={() => viewReferences(p)}
                                title="Open the reference gallery in a new tab"
                                style={{ whiteSpace: 'nowrap' }}
                              >
                                <Eye size={14} strokeWidth={1.75} />
                                <span>View</span>
                              </button>
                              <button
                                type="button"
                                className="crm-btn crm-btn-ghost crm-btn-icon"
                                onClick={() => downloadAll(p)}
                                disabled={isDownloading}
                                title="Download all reference images as a zip"
                                style={{ whiteSpace: 'nowrap' }}
                              >
                                <Download size={14} strokeWidth={1.75} />
                                <span>
                                  {isDownloading ? 'Zipping\u2026' : 'Download'}
                                </span>
                              </button>
                            </div>
                          ) : (
                            <span
                              className="crm-btn crm-btn-ghost crm-btn-icon"
                              aria-disabled="true"
                              title="This job has no reference images"
                              style={{
                                whiteSpace: 'nowrap',
                                color: 'var(--text-faint)',
                                cursor: 'default',
                                opacity: 0.7,
                              }}
                            >
                              <ImageOff size={14} strokeWidth={1.75} />
                              <span>No references</span>
                            </span>
                          )}
                          {rowError && (
                            <span style={{ color: '#dc2626', fontSize: 12 }}>
                              {rowError}
                            </span>
                          )}
                        </div>
                      </td>
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
