-- ============================================================
-- Unntangle CRM — Supabase schema
-- Paste this entire file into Supabase Dashboard → SQL Editor
-- and click "Run". Safe to re-run (uses IF NOT EXISTS).
-- ============================================================

-- ============================================================
-- USERS (hardcoded CRM users with role: '3d_artist' or 'qa')
-- ============================================================
create table if not exists public.crm_users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  -- bcrypt hash (cost 10). Never store plaintext.
  password_hash text not null,
  name        text not null,
  role        text not null check (role in ('3d_artist', 'qa', 'admin')),
  created_at  timestamptz not null default now()
);

-- ============================================================
-- CLIENTS (e.g. "Officemate")
-- Each client = a top-level folder in Cloudinary (officemate/...)
-- ============================================================
create table if not exists public.crm_clients (
  id          uuid primary key default gen_random_uuid(),
  -- "officemate" — used as the Cloudinary folder prefix and the
  -- subdomain segment on officemate.unntangle.com if you ever
  -- expand to multiple client subdomains.
  slug        text unique not null,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- PROJECTS (a 3D model = one project)
-- Status machine:
--   draft        → artist created, hasn't uploaded yet
--   qa_pending   → artist uploaded zip, awaiting QA
--   rejected_N   → QA rejected with feedback (N = revision count)
--   approved     → QA approved, live on officemate.unntangle.com
-- ============================================================
create table if not exists public.crm_projects (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.crm_clients(id) on delete cascade,
  -- "jupiter" — used as the Cloudinary subfolder name and the URL
  -- slug on officemate.unntangle.com/<model_slug>
  slug           text not null,
  name           text not null,
  status         text not null default 'draft'
                  check (status in ('draft','qa_pending','rejected','approved')),
  -- How many times this project has been rejected. Displayed as
  -- "Rejected 1", "Rejected 2", etc. in the artist dashboard.
  revision_count integer not null default 0,
  -- The currently-uploaded artist asset (latest version)
  zip_url        text,            -- Cloudinary URL to the .zip
  glb_url        text,            -- Cloudinary URL to extracted .glb (preview)
  fbx_url        text,            -- Cloudinary URL to extracted .fbx
  gltf_url       text,            -- Cloudinary URL to extracted .gltf
  -- Set when QA approves. This is the URL officemate.unntangle.com
  -- serves to the public.
  approved_glb_url text,
  created_by     uuid references public.crm_users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (client_id, slug)
);

create index if not exists idx_crm_projects_status on public.crm_projects(status);
create index if not exists idx_crm_projects_client on public.crm_projects(client_id);

-- ============================================================
-- FEEDBACK IMAGES (QA → Artist)
-- Each QA review session creates 0..N feedback rows.
-- "feedback images uploaded" => rejection.
-- "no feedback images"        => approval.
-- ============================================================
create table if not exists public.crm_feedback_images (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.crm_projects(id) on delete cascade,
  -- Each rejection cycle gets its own revision number so we can
  -- show the artist "feedback from Rev 1", "feedback from Rev 2".
  revision      integer not null,
  image_url     text not null,    -- Cloudinary URL to the feedback PNG/JPG
  note          text,             -- optional caption from QA
  uploaded_by   uuid references public.crm_users(id),
  created_at    timestamptz not null default now()
);

create index if not exists idx_crm_feedback_project on public.crm_feedback_images(project_id, revision);

-- ============================================================
-- SEED: Officemate client + Jupiter chair (existing project)
-- ============================================================
insert into public.crm_clients (slug, name)
values ('officemate', 'Officemate')
on conflict (slug) do nothing;

-- Seed the Jupiter project that already exists on disk so the
-- CRM has something to show on first load. Status = approved
-- because Jupiter4.glb is already live on officemate.unntangle.com.
insert into public.crm_projects (client_id, slug, name, status, approved_glb_url)
select
  c.id,
  'jupiter',
  'Jupiter 3D Chair',
  'approved',
  'https://officemate.unntangle.com/jupiter/Jupiter4.glb'
from public.crm_clients c
where c.slug = 'officemate'
on conflict (client_id, slug) do nothing;

-- ============================================================
-- SEED: Two demo users
-- Passwords below are bcrypt hashes of:
--   artist@unntangle.com  / artist123
--   qa@unntangle.com      / qa123
--
-- CHANGE THESE PASSWORDS IMMEDIATELY after first login.
-- To regenerate hashes:
--   node -e "console.log(require('bcryptjs').hashSync('newpass',10))"
-- ============================================================
insert into public.crm_users (email, password_hash, name, role)
values
  ('artist@unntangle.com',
   '$2b$10$bbrcVxL14gMxzoSzxbMAeehPX6b9UFnyhGUTSWSbztU7QO50vbhQ2',
   '3D Artist',
   '3d_artist'),
  ('qa@unntangle.com',
   '$2b$10$lP7CQQKn8oIA8rHjf2p.WesnzdPtotWtfKEw4fxGbvE4hq4iNGI.q',
   'QA Reviewer',
   'qa')
on conflict (email) do nothing;

-- ============================================================
-- Row-level security: we use the service-role key from the
-- Next.js server, so RLS doesn't need to be permissive for
-- the anon key. Disable RLS on these CRM tables since all
-- access is gated by our own session middleware.
-- ============================================================
alter table public.crm_users           disable row level security;
alter table public.crm_clients         disable row level security;
alter table public.crm_projects        disable row level security;
alter table public.crm_feedback_images disable row level security;

-- ============================================================
-- MIGRATION (idempotent): role 'qa' → 'admin'
-- + assigned_to / brief on projects
-- + crm_project_references table
-- ============================================================

-- 1) Migrate any existing rows from role 'qa' to 'admin' BEFORE
--    tightening the check constraint.
update public.crm_users set role = 'admin' where role = 'qa';

-- 2) Replace the role check constraint so 'qa' is no longer valid.
alter table public.crm_users drop constraint if exists crm_users_role_check;

alter table public.crm_users
  add constraint crm_users_role_check
  check (role in ('3d_artist', 'admin'));

-- 3) Project assignment + brief.
alter table public.crm_projects
  add column if not exists assigned_to uuid references public.crm_users(id) on delete set null;
alter table public.crm_projects
  add column if not exists brief text;

create index if not exists idx_crm_projects_assigned on public.crm_projects(assigned_to);

-- 4) Reference images attached at job-creation time (admin → artist).
--    Distinct from crm_feedback_images, which is the rejection-cycle artefact.
create table if not exists public.crm_project_references (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.crm_projects(id) on delete cascade,
  image_url   text not null,
  uploaded_by uuid references public.crm_users(id),
  created_at  timestamptz not null default now()
);

create index if not exists idx_crm_refs_project on public.crm_project_references(project_id);

alter table public.crm_project_references disable row level security;
