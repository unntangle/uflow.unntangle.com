// This file is intentionally empty \u2014 the context approach was replaced by
// a localStorage + window event pattern in ClientSwitcher.tsx because the
// CRM doesn't have a shared admin layout that could host the provider.
//
// Kept as a placeholder so any stale import that might still exist would
// surface as a clear missing-export error at build time, rather than a
// confusing runtime crash. Safe to delete entirely once verified unused.

export {};
