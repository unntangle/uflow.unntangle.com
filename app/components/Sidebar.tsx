'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  LayoutDashboard,
  ShieldCheck,
  Users,
  Building2,
  FilePlus,
  Repeat,
  Briefcase,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Folder,
  Inbox,
  ChevronRight,
  CheckCircle2,
} from 'lucide-react';
import { crmFetch, crmPath } from '../lib/client-fetch';
import ClientSwitcher, {
  CLIENT_FILTER_EVENT,
  getStoredClientId,
} from './ClientSwitcher';

type Role = '3d_artist' | 'admin' | 'client';

type Props = {
  name: string;
  role: Role;
  // "+ Create Job" and "+ Add 3D Artist" both navigate to their
  // own pages by default (/admin/jobs/new and /admin/artists/new).
  // Pages can still pass these callbacks to override the navigation
  // (e.g. if we ever bring back an inline / modal experience).
  onCreateJob?: () => void;
  onAddArtist?: () => void;
  // QA Review uses every pixel for the model viewer + references;
  // default the sidebar to collapsed there. User can still
  // toggle it open with the chevron.
  defaultCollapsed?: boolean;
  // Client-role sidebars show their brand name in the same pill
  // slot where admin shows the client switcher. Optional because
  // admin/artist sidebars don't need it.
  brandName?: string;
};

const roleLabel: Record<Role, string> = {
  '3d_artist': '3D Artist',
  admin: 'Admin',
  client: 'Client',
};

// Storage key for the user's last manual choice. Once they click
// the toggle, that choice wins over `defaultCollapsed` everywhere
// (we don't want to fight the user across pages).
const STORAGE_KEY = 'crm:sidebarCollapsed';

export default function Sidebar({
  name,
  role,
  onCreateJob,
  onAddArtist,
  defaultCollapsed = false,
  brandName,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Sidebar collapse state. Lives in localStorage so the choice
  // survives navigation. We boot from `defaultCollapsed` until
  // localStorage hydration overrides it, to avoid an SSR flash.
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        setCollapsed(stored === '1');
      }
    } catch {
      // localStorage may be unavailable (e.g. iframe, privacy mode);
      // fall back to the default already set.
    }
  }, []);
  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* see above */
      }
      return next;
    });
  }

  async function logout() {
    await crmFetch('/api/auth/logout', { method: 'POST' });
    router.push(crmPath('/login'));
    router.refresh();
  }

  // Strip the /crm prefix when present (local dev) so the active-link
  // comparison works the same locally and on the subdomain.
  const path = (pathname || '').replace(/^\/crm/, '');
  const isActive = (target: string) => path === target;

  // QA is a virtual route — it's /admin with ?tab=pending. The
  // sidebar link should highlight only when both match, otherwise
  // the plain Overview link below would steal the highlight every
  // time we're on /admin.
  const tabParam = searchParams?.get('tab');
  const isOnQa = path === '/admin' && tabParam === 'pending';
  // Job Allocation is also a virtual route on /admin, with
  // ?tab=allocation. Distinct from Overview/QA so the highlight
  // travels with the URL state.
  const isOnAllocation = path === '/admin' && tabParam === 'allocation';
  const isOnOverview =
    path === '/admin' && !isOnQa && !isOnAllocation;

  // Client-side virtual routes mirror admin's: /client is
  // Overview, /client?tab=pending is Quality Audit. Same pattern
  // so the muscle memory transfers between roles for anyone who
  // wears both hats (e.g. an internal QA reviewer who also helps
  // a client through their review).
  const isOnClientQa = path === '/client' && tabParam === 'pending';
  // Allocated Jobs is a third client virtual route on /client with
  // ?tab=allocated. Distinct from Overview/QA so the highlight
  // travels with the URL state.
  const isOnClientAllocated = path === '/client' && tabParam === 'allocated';
  // Approved Jobs is the fourth client virtual route on /client
  // with ?tab=approved — a read-only list of signed-off jobs that
  // lives alongside Allocated Jobs in the Jobs group.
  const isOnClientApproved = path === '/client' && tabParam === 'approved';
  const isOnClientOverview =
    path === '/client' && !isOnClientQa && !isOnClientAllocated && !isOnClientApproved;

  // ---- Client's Jobs expandable parent: same pattern as admin's.
  // Children are Create Job (/client/new), Allocated Jobs
  // (/client?tab=allocated), and Approved Jobs
  // (/client?tab=approved). We persist open/closed state under
  // its own localStorage key so it doesn't fight admin's group.
  const CLIENT_JOBS_KEY = 'crm:sidebarGroup:clientJobs';
  const isOnClientJobsChild =
    isOnClientAllocated || isOnClientApproved || isActive('/client/new');
  const [clientJobsOpen, setClientJobsOpen] = useState<boolean>(
    isOnClientJobsChild
  );
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CLIENT_JOBS_KEY);
      if (stored !== null) {
        setClientJobsOpen(stored === '1' || isOnClientJobsChild);
      } else {
        setClientJobsOpen(isOnClientJobsChild);
      }
    } catch {
      /* fall back to in-memory default */
    }
    // Hydrate once on mount; subsequent path changes are handled
    // by the toggle + the conditional above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function toggleClientJobsOpen() {
    setClientJobsOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(CLIENT_JOBS_KEY, next ? '1' : '0');
      } catch {
        /* see above */
      }
      return next;
    });
  }

  // ---- Expandable groups: persist the open/closed state so it
  // survives navigation. We default 'jobs' to open whenever the
  // current page is one of its children, so the user lands inside
  // an open group rather than a collapsed one.
  const JOBS_KEY = 'crm:sidebarGroup:jobs';
  const isOnJobsChild =
    isOnAllocation ||
    isActive('/admin/jobs/new') ||
    isActive('/admin/jobs/reassign');
  const [jobsOpen, setJobsOpen] = useState<boolean>(isOnJobsChild);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(JOBS_KEY);
      if (stored !== null) {
        // localStorage wins, but if we're on a child page force-open
        // so the active child is visible.
        setJobsOpen(stored === '1' || isOnJobsChild);
      } else {
        setJobsOpen(isOnJobsChild);
      }
    } catch {
      /* fall back to in-memory default */
    }
    // We intentionally don't list isOnJobsChild as a dep — we only
    // want to hydrate once on mount. Subsequent path changes are
    // handled by toggleJobsOpen + the conditional above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function toggleJobsOpen() {
    setJobsOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(JOBS_KEY, next ? '1' : '0');
      } catch {
        /* see above */
      }
      return next;
    });
  }

  // ---- Track which client is selected in the sidebar dropdown.
  // The sidebar uses this to decide what to render: when no
  // client is picked ("All clients"), the Job Management section
  // is hidden because per-job operations are scoped to one brand
  // at a time. User Management stays visible either way — it's
  // brand-agnostic (Artists are global, Clients lists all brands).
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
  const showJobManagement = role === 'admin' && selectedClientId !== null;

  return (
    <aside className={`crm-sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="crm-sidebar-brand">
        {/* Logo + tagline stack. The logo replaces the previous
            text+dot mark; the tagline reads as the parent brand
            attribution (“by Unntangle”) under product names that
            are sub-brands of the Unntangle umbrella. */}
        <div className="crm-sidebar-brand-mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/uflow/uflow-logo.webp"
            alt="UFlow"
            className="crm-sidebar-logo"
          />
          <span className="crm-sidebar-brand-tagline">
            by <span className="crm-sidebar-brand-tagline-accent">unntangle</span>
          </span>
        </div>
        <button
          type="button"
          className="crm-sidebar-toggle"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeftOpen size={14} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Client selector — admin only. Hidden in collapsed mode
          (no room for a dropdown trigger when icons-only). */}
      {role === 'admin' && !collapsed && (
        <div className="crm-sidebar-section">
          <ClientSwitcher />
        </div>
      )}

      {/* Client-role brand pill — visually mirrors the admin's
          client switcher (same slot, same pill shape) but it's
          static: the client is locked to one brand, so there's
          nothing to switch. We render it as a non-interactive
          element so the appearance stays consistent without
          implying a choice. */}
      {role === 'client' && !collapsed && brandName && (
        <div className="crm-sidebar-section">
          <div className="crm-client-switcher">
            <div
              className="crm-client-switcher-trigger"
              aria-disabled="true"
              style={{ cursor: 'default' }}
            >
              <span className="crm-client-switcher-label">
                {brandName}
              </span>
            </div>
          </div>
        </div>
      )}

      <nav className="crm-sidebar-nav">
        {role === 'admin' && (
          <>
            {/* ============ JOB MANAGEMENT ============ */}
            {/* Only rendered when a specific client is selected.
                On "All clients" we hide the whole section because
                per-job operations (Overview, QA, Allocation, etc.)
                are scoped to one brand at a time and would be
                misleading without a brand context. */}
            {showJobManagement && (
              <>
                {!collapsed && (
                  <div className="crm-sidebar-group-label">Job Management</div>
                )}
                <button
                  className={`crm-sidebar-link ${isOnOverview ? 'is-active' : ''}`}
                  onClick={() => router.push(crmPath('/admin'))}
                  title={collapsed ? 'Overview' : undefined}
                >
                  <LayoutDashboard size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span>Overview</span>
                </button>
                <button
                  className={`crm-sidebar-link ${isOnQa ? 'is-active' : ''}`}
                  onClick={() => router.push(crmPath('/admin?tab=pending'))}
                  title={collapsed ? 'Quality Audit' : undefined}
                >
                  <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span>Quality Audit</span>
                </button>

                {/* ---- Jobs (expandable parent) ---- */}
                <button
                  className={`crm-sidebar-link crm-sidebar-link-parent ${
                    jobsOpen ? 'is-open' : ''
                  } ${isOnJobsChild && !jobsOpen ? 'is-active' : ''}`}
                  onClick={toggleJobsOpen}
                  aria-expanded={jobsOpen}
                  title={collapsed ? 'Jobs' : undefined}
                >
                  <Folder size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span>Jobs</span>
                  {!collapsed && (
                    <ChevronRight
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className="crm-sidebar-chevron"
                    />
                  )}
                </button>
                {jobsOpen && !collapsed && (
                  <div className="crm-sidebar-children">
                    <button
                      className={`crm-sidebar-link crm-sidebar-link-child ${
                        isOnAllocation ? 'is-active' : ''
                      }`}
                      onClick={() => router.push(crmPath('/admin?tab=allocation'))}
                    >
                      <Inbox size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span>Job Allocation</span>
                    </button>
                    <button
                      className={`crm-sidebar-link crm-sidebar-link-child ${
                        isActive('/admin/jobs/new') ? 'is-active' : ''
                      }`}
                      onClick={
                        onCreateJob
                          ? onCreateJob
                          : () => router.push(crmPath('/admin/jobs/new'))
                      }
                    >
                      <FilePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span>Create Job</span>
                    </button>
                    <button
                      className={`crm-sidebar-link crm-sidebar-link-child ${
                        isActive('/admin/jobs/reassign') ? 'is-active' : ''
                      }`}
                      onClick={() => router.push(crmPath('/admin/jobs/reassign'))}
                    >
                      <Repeat size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span>Reassign Job</span>
                    </button>
                  </div>
                )}
              </>
            )}

            {/* ============ USER MANAGEMENT ============ */}
            {/* Always visible for admin — brand-agnostic. */}
            {!collapsed && (
              <div className="crm-sidebar-group-label">User Management</div>
            )}
            <button
              className={`crm-sidebar-link ${isActive('/admin/artists') ? 'is-active' : ''}`}
              onClick={
                onAddArtist
                  ? onAddArtist
                  : () => router.push(crmPath('/admin/artists'))
              }
              title={collapsed ? 'Artists' : undefined}
            >
              <Users size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Artists</span>
            </button>
            <button
              className={`crm-sidebar-link ${isActive('/admin/clients') ? 'is-active' : ''}`}
              onClick={() => router.push(crmPath('/admin/clients'))}
              title={collapsed ? 'Clients' : undefined}
            >
              <Building2 size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Clients</span>
            </button>
          </>
        )}
        {role === '3d_artist' && (
          <button
            className={`crm-sidebar-link ${isActive('/artist') ? 'is-active' : ''}`}
            onClick={() => router.push(crmPath('/artist'))}
            title={collapsed ? 'My Jobs' : undefined}
          >
            <Briefcase size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>My Jobs</span>
          </button>
        )}
        {role === 'client' && (
          <>
            {/* ============ JOB MANAGEMENT ============ */}
            {/* Mirrors the admin sidebar's structure so the two
                roles feel like the same product. Clients only get
                this one section — no User Management — because
                clients only act on their own brand's projects.
                Within it: Overview, then Jobs (expandable: Create
                Job + Allocated Jobs), then Quality Audit. The
                Jobs group is expandable just like admin's. */}
            {!collapsed && (
              <div className="crm-sidebar-group-label">Job Management</div>
            )}
            <button
              className={`crm-sidebar-link ${isOnClientOverview ? 'is-active' : ''}`}
              onClick={() => router.push(crmPath('/client'))}
              title={collapsed ? 'Overview' : undefined}
            >
              <LayoutDashboard size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Overview</span>
            </button>

            {/* ---- Jobs (expandable parent) ---- */}
            <button
              className={`crm-sidebar-link crm-sidebar-link-parent ${
                clientJobsOpen ? 'is-open' : ''
              } ${isOnClientJobsChild && !clientJobsOpen ? 'is-active' : ''}`}
              onClick={toggleClientJobsOpen}
              aria-expanded={clientJobsOpen}
              title={collapsed ? 'Jobs' : undefined}
            >
              <Folder size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Jobs</span>
              {!collapsed && (
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="crm-sidebar-chevron"
                />
              )}
            </button>
            {clientJobsOpen && !collapsed && (
              <div className="crm-sidebar-children">
                <button
                  className={`crm-sidebar-link crm-sidebar-link-child ${
                    isActive('/client/new') ? 'is-active' : ''
                  }`}
                  onClick={() => router.push(crmPath('/client/new'))}
                >
                  <FilePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>Create Job</span>
                </button>
                <button
                  className={`crm-sidebar-link crm-sidebar-link-child ${
                    isOnClientAllocated ? 'is-active' : ''
                  }`}
                  onClick={() => router.push(crmPath('/client?tab=allocated'))}
                >
                  <Inbox size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>Allocated Jobs</span>
                </button>
                <button
                  className={`crm-sidebar-link crm-sidebar-link-child ${
                    isOnClientApproved ? 'is-active' : ''
                  }`}
                  onClick={() => router.push(crmPath('/client?tab=approved'))}
                >
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>Approved Jobs</span>
                </button>
              </div>
            )}

            <button
              className={`crm-sidebar-link ${isOnClientQa ? 'is-active' : ''}`}
              onClick={() => router.push(crmPath('/client?tab=pending'))}
              title={collapsed ? 'Quality Audit' : undefined}
            >
              <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Quality Audit</span>
            </button>
          </>
        )}
      </nav>

      <div className="crm-sidebar-foot">
        <div className="crm-sidebar-user">
          <strong>{name}</strong>
          <span>{roleLabel[role]}</span>
        </div>
        <button
          className="crm-logout"
          onClick={logout}
          title={collapsed ? 'Log out' : undefined}
        >
          <LogOut size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>Log out</span>
        </button>
      </div>
    </aside>
  );
}
