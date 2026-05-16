# Unntangle CRM — Setup

This is the internal CRM that lives at **crm.unntangle.com**. It coordinates
3D Artists and QA reviewers for client projects (currently: Officemate).

Tech: Next.js 16 (this same monorepo), Supabase (Postgres + auth users),
Cloudinary (zip + GLB + feedback image storage), signed-cookie sessions.

---

## 1. One-time setup

### 1.1 Install dependencies

From the project root:

```bash
npm install @supabase/supabase-js adm-zip bcryptjs cloudinary jose
npm install -D @types/adm-zip @types/bcryptjs
```

### 1.2 Create the Supabase tables

1. Open your Supabase project: <https://supabase.com/dashboard>
2. SQL Editor → **New query**
3. Paste the entire contents of `app/crm/schema.sql`
4. Click **Run**

This creates: `crm_users`, `crm_clients`, `crm_projects`,
`crm_feedback_images`, plus seed rows for the Officemate client, the
existing Jupiter chair project, and two demo users.

### 1.3 Create a Cloudinary account

1. Sign up at <https://cloudinary.com> (free tier: 25 GB storage, 25 GB
   bandwidth / month — plenty for this workflow)
2. Dashboard → **API keys** → copy **Cloud name**, **API key**,
   **API secret**

### 1.4 Environment variables

Create `.env.local` at the project root (same folder as `package.json`):

```bash
# Supabase
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
# This is the SERVICE ROLE key (not anon). Settings → API → service_role.
# It bypasses RLS — never expose to the browser.
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# Cloudinary
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=abcdef...

# Session cookie signing — any 32+ char random string.
# Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRM_SESSION_SECRET=replace-with-a-long-random-string-please

# Public-facing URL (used by direct-to-Cloudinary uploads to sign requests)
# Only needs to be set in production; defaults to localhost otherwise.
NEXT_PUBLIC_SITE_URL=https://unntangle.com
```

In Vercel, add the same vars under
**Project → Settings → Environment Variables** for all environments
(Production, Preview, Development).

### 1.5 DNS for the subdomain

Add a CNAME for `crm.unntangle.com` pointing to `cname.vercel-dns.com`
(same target as the existing `officemate.unntangle.com` record).

In Vercel: **Project → Settings → Domains → Add** → `crm.unntangle.com`.
Vercel will verify the CNAME and issue an SSL cert automatically.

The `middleware.ts` already handles the rewrite from `crm.*` host to
`/crm/*` paths — no extra config needed.

---

## 2. First-time login

Two demo users are seeded by the SQL:

| Role      | Email                     | Password    |
| --------- | ------------------------- | ----------- |
| 3D Artist | `artist@unntangle.com`    | `artist123` |
| QA        | `qa@unntangle.com`        | `qa123`     |

**⚠️ Change these immediately.** To create a new password hash:

```bash
node -e "console.log(require('bcryptjs').hashSync('newPasswordHere', 10))"
```

Then in Supabase SQL Editor:

```sql
update crm_users
set password_hash = '$2b$10$...the-hash-from-above'
where email = 'artist@unntangle.com';
```

To add more users:

```sql
insert into crm_users (email, password_hash, name, role) values
  ('alice@unntangle.com', '$2b$10$...', 'Alice', '3d_artist'),
  ('bob@unntangle.com',   '$2b$10$...', 'Bob',   'qa');
```

Valid roles: `3d_artist`, `qa`, `admin` (admin sees both dashboards).

---

## 3. Local development

```bash
npm run dev
```

Open <http://localhost:3000/crm/login>.

To test the subdomain rewrite locally, either:

- Edit `C:\Windows\System32\drivers\etc\hosts` and add:
  ```
  127.0.0.1  crm.localhost
  ```
  then open <http://crm.localhost:3000>, **or**
- Just use the `/crm/...` paths directly during dev.

---

## 4. Workflow reference

```
Artist creates project        →  status: draft
Artist uploads zip            →  status: qa_pending
QA reviews:
  - submits with 0 images     →  status: approved    (GLB copied to /approved/)
  - submits with N images     →  status: rejected    (badge: "Rejected 1")
Artist re-uploads             →  status: qa_pending  (revision_count++)
...repeat until approved
```

The approved GLB lives at a stable Cloudinary URL in
`<client>/<project>/approved/<slug>.glb`, recorded in
`crm_projects.approved_glb_url`.

The public endpoint:

```
GET /api/public/model?client=officemate&slug=jupiter
→ { name, glb_url, updated_at }
```

is what `officemate.unntangle.com` calls to render the latest approved
version of each model.

---

## 5. Adding a new client

```sql
insert into crm_clients (slug, name) values ('acme', 'Acme Corp');
```

That's it — the slug becomes the Cloudinary folder prefix and the
project namespace. Artists pick the client from the dropdown when
creating a project.

---

## 6. Folder structure on disk

```
app/crm/
├── schema.sql                  ← paste into Supabase
├── SETUP.md                    ← you are here
├── layout.tsx                  ← scoped CRM layout (no-index, own font)
├── crm.css                     ← all styles, namespaced under .crm-root
├── page.tsx                    ← role-based redirect
├── login/
│   ├── page.tsx
│   └── LoginForm.tsx
├── artist/
│   ├── page.tsx
│   └── ArtistDashboard.tsx
├── qa/
│   ├── page.tsx
│   └── QaDashboard.tsx
├── components/
│   ├── NavBar.tsx
│   ├── StatusBadge.tsx
│   └── ModelViewer.tsx         ← Google's <model-viewer>, same as Officemate
├── lib/
│   ├── supabase.ts             ← server-side client + types
│   ├── cloudinary.ts           ← upload helpers + folder layout
│   ├── session.ts              ← signed JWT cookies
│   ├── auth.ts                 ← requireUser / requireApiUser guards
│   └── zip.ts                  ← extract fbx/glb/gltf from artist zip
└── api/
    ├── auth/
    │   ├── login/route.ts
    │   └── logout/route.ts
    ├── projects/
    │   ├── route.ts            ← GET (list) / POST (create)
    │   └── [id]/
    │       ├── upload/route.ts        ← LEGACY 410 stub
    │       ├── upload-sign/route.ts   ← issue signed direct upload params
    │       ├── finalize-upload/route.ts ← register direct-upload result
    │       ├── feedback-sign/route.ts  ← QA: signed image uploads
    │       └── feedback/route.ts       ← QA approve/reject (JSON body)
    └── public/
        └── model/route.ts              ← public lookup for officemate subdomain
```

---

## 7. Troubleshooting

**"Missing SUPABASE_URL"** on first run
→ Restart `npm run dev` after editing `.env.local`. Next.js reads
env vars only at startup.

**"Invalid email or password" but credentials look right**
→ The seed bcrypt hashes were generated with `bcryptjs`. If you used
some other tool to generate the hash, make sure it's compatible
(prefix `$2a$` or `$2b$`).

**Zip upload fails with 413 / "Payload too large"**
→ Vercel's default body limit is 4.5 MB. The CRM uses
**direct-to-Cloudinary uploads** (see `upload-sign` + `finalize-upload`
routes) to bypass this. If you're hitting 413, you're probably on the
old proxy-through-Next route — the artist dashboard should be calling
the direct flow.

**GLB preview is blank in the QA modal**
→ Hard-refresh the browser. The `<model-viewer>` script loads once
per page; if it failed the first time (network glitch), the dashboard
won't retry. Refresh forces a reload.
