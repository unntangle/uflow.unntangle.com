# Unntangle CRM — what's built

This file is for you, future maintainer (or me, when you ask me to extend this).

## Summary

A self-contained CRM at `crm.unntangle.com` that coordinates 3D model production
between artists and QA reviewers. Approved models flow out to `officemate.unntangle.com`
via the same database, with no manual file moves.

## Architecture at a glance

```
┌──────────────────────┐         ┌──────────────────────┐
│ crm.unntangle.com    │         │ officemate.          │
│ (this CRM)           │         │ unntangle.com        │
│                      │         │                      │
│ /login               │         │ / (catalog index)    │
│ /artist              │         │ /<slug> (viewer)     │
│ /qa                  │         │                      │
└─────────┬────────────┘         └──────────┬───────────┘
          │                                 │
          │      reads/writes               │  reads approved
          │                                 │     glb_url
          ▼                                 ▼
       ┌──────────────────────────────────────┐
       │  Supabase (crm_projects, etc.)       │
       └──────────────────────────────────────┘
                       │
                       │  uploads / fetches
                       ▼
       ┌──────────────────────────────────────┐
       │  Cloudinary                          │
       │   <client>/<slug>/uploads/rev-N/...  │
       │   <client>/<slug>/feedback/rev-N/... │
       │   <client>/<slug>/approved/<slug>.glb│ ← served to officemate
       └──────────────────────────────────────┘
```

Both subdomains are rewrites in `middleware.ts` — no separate deployments.

## Upload flow (direct-to-Cloudinary)

We can't proxy large zips through Vercel (4.5 MB inbound limit), so:

1. Artist picks a `.zip` in the browser
2. Browser → `POST /api/projects/:id/upload-sign` → server returns a signed Cloudinary signature scoped to that project's next revision folder
3. Browser uploads the zip **directly** to Cloudinary using that signature (with XHR upload progress)
4. Browser → `POST /api/projects/:id/finalize-upload` with the resulting URL
5. Server fetches the zip back (outbound fetches have no size limit), unpacks it, uploads the individual `.glb`/`.fbx`/`.gltf` files to Cloudinary, updates the DB row to `qa_pending`

The QA "reject" flow uses the same pattern for feedback images.

## Status state machine

```
draft ──upload──▶ qa_pending ──QA reject──▶ rejected
                       │                       │
                       │                       └─re-upload─▶ qa_pending
                       │
                       └──QA approve──▶ approved
                                          │
                                          └─ approved_glb_url set
                                             officemate.unntangle.com
                                             serves it from here
```

QA decision rule (as specified): submit with ≥1 feedback image → reject; submit with 0 → approve.

## Files of note

| File | Purpose |
|------|---------|
| `middleware.ts` | Rewrites `crm.*` and `officemate.*` to `/crm/*` and `/officemate/*` |
| `app/crm/schema.sql` | Paste into Supabase to bootstrap |
| `app/crm/SETUP.md` | Step-by-step setup (env vars, DNS, default logins, troubleshooting) |
| `app/crm/lib/zip.ts` | Pulls `.glb`/`.fbx`/`.gltf` out of an artist zip |
| `app/crm/lib/cloudinary.ts` | Folder-layout single-source-of-truth |
| `app/crm/api/projects/[id]/upload-sign/route.ts` | Mints scoped Cloudinary signatures |
| `app/crm/api/projects/[id]/finalize-upload/route.ts` | Extracts the uploaded zip |
| `app/crm/api/projects/[id]/feedback/route.ts` | Approve/reject decision |
| `app/officemate/[slug]/page.tsx` | Renders the approved GLB for any model in the CRM |

## Dead code (safe to delete, can't via Filesystem MCP)

- `app/crm/_components/` — leftover from an earlier scaffold; replaced with empty stubs
- `app/crm/api/projects/[id]/upload/route.ts` — old FormData upload, now a 410 stub
- `app/crm/api/upload-signature/route.ts` — superseded by per-project signature, now a 410 stub

To clean up: `rm -rf app/crm/_components app/crm/api/projects/\[id\]/upload app/crm/api/upload-signature`

## Compatibility with existing Officemate site

The existing `public/officemate/jupiter/index.html` static page still works — Next.js serves static files from `public/` before checking the app router. The seeded Jupiter row in the DB points to that static URL, so it shows up in the CRM dashboard immediately. New models added through the CRM render via the dynamic `app/officemate/[slug]/page.tsx` route.

## What's intentionally NOT included

- **Email notifications**: when QA rejects, the artist has to check the dashboard. Easy to add — wire Resend or Supabase Auth email triggers to the status-change.
- **Multi-file GLTF scene uploads**: only the `.gltf` index file is extracted. The raw zip is archived intact, so you can pull `.bin` and textures later.
- **Audit log**: no record of who did what when (beyond `created_by` on rows). Add a `crm_events` table if needed.
- **Project deletion**: no UI for it. Use Supabase Table Editor.
- **Real auth providers**: hardcoded email/password per the user's request. Swap to Supabase Auth or Clerk if you want SSO.
