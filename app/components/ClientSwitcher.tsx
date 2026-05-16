'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { crmFetch } from '../lib/client-fetch';

// ============================================================
// ClientSwitcher
//
// Sidebar dropdown for admins to pick which client brand they
// want to view. Shows the selected brand's name as the trigger
// and reveals a menu of all brands + an "All clients" option.
//
// The selection is stored in localStorage under the same key
// the AdminDashboard reads on mount and listens for. We dispatch
// a custom 'crm:client-filter-change' event on the window so any
// open dashboard updates instantly without needing a route reload.
//
// Loads the brand list lazily on first open so we don't pay a
// roundtrip for admins who never interact with the selector.
// The list is cached for the lifetime of the component (the
// sidebar) \u2014 brands change rarely.
// ============================================================

const STORAGE_KEY = 'crm:selectedClientId';
const CHANGE_EVENT = 'crm:client-filter-change';

type Brand = {
  id: string;
  slug: string;
  name: string;
};

// ----- Read/write helpers, exported so AdminDashboard can use the
//       same key and event name without hard-coding them. -----
export function getStoredClientId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
export function setStoredClientId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* localStorage unavailable \u2014 fall through */
  }
  // Notify any listener in the same tab. Cross-tab is handled by
  // the native 'storage' event the browser fires automatically.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { id } }));
}
export const CLIENT_FILTER_EVENT = CHANGE_EVENT;

export default function ClientSwitcher() {
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [loadingErr, setLoadingErr] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);

  // ---- Hydrate selection from localStorage on mount, listen for
  //      changes from other places (or other tabs). ----
  useEffect(() => {
    setSelectedClientId(getStoredClientId());
    function onChange() {
      setSelectedClientId(getStoredClientId());
    }
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  // ---- Click-outside + Escape to close ----
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // ---- Lazy-load brands on first open OR whenever we have a
  //      stored selection that we need a label for. Without this
  //      eager fetch, a page refresh shows the placeholder
  //      "Selected client" until the admin opens the dropdown,
  //      because `brands` stays null and we can't resolve the
  //      stored id to a name. The fetch is gated on
  //      `selectedClientId` being non-null so admins on the
  //      default "All clients" view still pay nothing until
  //      they actually open the menu.
  useEffect(() => {
    if (brands !== null) return;
    if (!open && !selectedClientId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await crmFetch('/api/clients');
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadingErr(data.error || 'Could not load clients.');
          return;
        }
        setBrands(data.clients || []);
      } catch (e) {
        if (cancelled) return;
        setLoadingErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, brands, selectedClientId]);

  function pick(id: string | null) {
    setStoredClientId(id);
    setSelectedClientId(id);
    setOpen(false);
  }

  // ---- Resolve the displayed label ----
  //   • No selection            → "All clients"
  //   • Selection + brands loaded → the brand name
  //   • Selection + brands still loading → empty string (the
  //     trigger renders blank for the brief moment between
  //     hydration and the brands fetch resolving, instead of
  //     flashing a misleading "Selected client" placeholder).
  const selectedBrand =
    selectedClientId && brands
      ? brands.find((b) => b.id === selectedClientId) ?? null
      : null;
  const triggerLabel = !selectedClientId
    ? 'All clients'
    : selectedBrand?.name ?? '';

  return (
    <div className="crm-client-switcher" ref={rootRef}>
      <button
        type="button"
        className="crm-client-switcher-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="crm-client-switcher-label">{triggerLabel}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.12s',
            flexShrink: 0,
          }}
        />
      </button>

      {open && (
        <div className="crm-client-switcher-menu" role="listbox">
          {/* "All clients" option \u2014 admin sees every brand's jobs. */}
          <button
            type="button"
            role="option"
            aria-selected={!selectedClientId}
            className={`crm-client-switcher-option ${
              !selectedClientId ? 'is-selected' : ''
            }`}
            onClick={() => pick(null)}
          >
            <span>All clients</span>
            {!selectedClientId && (
              <Check size={14} strokeWidth={2} aria-hidden="true" />
            )}
          </button>

          {brands && brands.length > 0 && (
            <div className="crm-client-switcher-divider" />
          )}

          {brands === null && !loadingErr && (
            <div className="crm-client-switcher-status">Loading\u2026</div>
          )}
          {loadingErr && (
            <div className="crm-client-switcher-status is-error">
              {loadingErr}
            </div>
          )}
          {brands && brands.length === 0 && (
            <div className="crm-client-switcher-status">No clients yet.</div>
          )}
          {brands?.map((b) => {
            const isSel = b.id === selectedClientId;
            return (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={isSel}
                className={`crm-client-switcher-option ${
                  isSel ? 'is-selected' : ''
                }`}
                onClick={() => pick(b.id)}
              >
                <span>{b.name}</span>
                {isSel && (
                  <Check size={14} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
