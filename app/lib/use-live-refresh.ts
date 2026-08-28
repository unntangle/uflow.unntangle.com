'use client';

import { useEffect, useRef } from 'react';

// ============================================================
// useLiveRefresh — keep a dashboard current without a reload
// ============================================================
// Calls `refresh` on a timer, plus immediately whenever the tab
// comes back to the foreground. Dashboards pass their existing
// list-refetch function, so nothing about how data is loaded
// changes — this only decides WHEN to reload it.
//
// WHY POLLING AND NOT REALTIME
// Supabase Realtime would be the obvious answer, but it needs a
// browser-side Supabase client holding the anon key, and this
// app deliberately has none: every read goes through our own
// /api routes behind the session cookie, and RLS is disabled on
// the uflow_* tables precisely because the server uses the
// service-role key (see the note at the end of schema.sql).
// Shipping an anon key to the browser against RLS-disabled
// tables would expose every client's jobs to every logged-in
// user. Polling reuses the existing authorised endpoint and
// changes no part of the security model.
//
// WHAT THIS IS NOT SAFE FOR
// Any surface holding UNSAVED per-row edits — Change Status,
// Change Type, Reassign — must NOT poll. Those pages keep the
// admin's in-progress dropdown selections in local state, and
// replacing the row list underneath them would silently discard
// work. Polling belongs on read-mostly dashboards.
//
// BACKGROUND TABS
// Nothing fires while the tab is hidden. A dashboard left open
// overnight would otherwise hit the API ~1,700 times before
// anyone looked at it, and the answer is stale the moment it
// arrives anyway. Instead we refresh once on the way back in,
// which is the moment the data actually needs to be right.
// ============================================================

export function useLiveRefresh(
  refresh: () => void,
  {
    intervalMs = 20000,
    enabled = true,
  }: { intervalMs?: number; enabled?: boolean } = {}
) {
  // Held in a ref so the effect below doesn't resubscribe on
  // every render. Dashboards define their refresh function inline,
  // so it's a new identity each pass — listing it as a dependency
  // would tear down and rebuild the interval continuously and the
  // timer would never actually elapse.
  const savedRefresh = useRef(refresh);
  useEffect(() => {
    savedRefresh.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;

    function tick() {
      // Cheap guard rather than clearing and rebuilding the timer
      // around visibility changes.
      if (document.visibilityState !== 'visible') return;
      savedRefresh.current();
    }

    const id = window.setInterval(tick, intervalMs);

    // Coming back to the tab is the one moment a stale list is
    // most likely to be noticed, so refresh immediately rather
    // than waiting out the remainder of the interval.
    function onVisible() {
      if (document.visibilityState === 'visible') {
        savedRefresh.current();
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [intervalMs, enabled]);
}
