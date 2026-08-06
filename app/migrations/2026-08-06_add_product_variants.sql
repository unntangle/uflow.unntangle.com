-- ============================================================
-- Migration: product variants (colourways)
-- Date: 2026-08-06
-- PHASE 1 of 3 — schema only. No app code depends on this yet,
-- so it is safe to run ahead of the UI work.
-- ============================================================
--
-- GOAL
-- One product (e.g. "Reflex chair") can carry several colour
-- variants (Black, Grey, Navy). Requirements this encodes:
--
--   * dashboards show ONE row per product, not one per variant
--   * the artist uploads a SEPARATE zip per variant
--     (same required structure as today: fbx/ glb/ gltf/ spp/)
--   * QA reviews variants side-by-side in one window and
--     approves / rejects EACH ONE INDEPENDENTLY
--   * reference images stay attached to the PRODUCT, uploaded in
--     one shot at creation — they are not split per variant
--
-- MODEL
-- Every product gets at least one variant row. The existing
-- single-model project is backfilled as its primary variant, so
-- there is exactly ONE place that holds per-model state
-- (status, revision_count, zip/glb/fbx/gltf urls).
--
-- uflow_projects keeps its columns for now so nothing breaks
-- mid-migration, but after phase 3 they become derived/legacy:
-- the product's status is a ROLL-UP of its variants, defined as
-- the LEAST ADVANCED variant. A product is 'approved' only when
-- every variant is approved. Phase 3 adds that as a view.
--
-- NOT CHANGED HERE
-- uflow_project_references stays keyed on project_id — reference
-- images belong to the product, per the one-shot upload rule.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Variants table
-- ------------------------------------------------------------
create table if not exists public.uflow_project_variants (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null
                   references public.uflow_projects(id) on delete cascade,

  -- Display name shown in the QA switcher, e.g. "Grey".
  name           text not null,
  -- URL/zip-safe form, e.g. "grey". Unique within the product.
  slug           text not null,

  -- Same nine-state machine as uflow_projects. Each variant runs
  -- through it independently: Grey can be approved while Black is
  -- still in IQA.
  status         text not null default 'draft'
                   check (status in (
                     'draft','qa_pending','iqa_rejected','eqa_rejected',
                     'wip','iqa_wip','eqa_wip','client_review','approved'
                   )),

  -- Rejection rounds for THIS variant only (same semantics as the
  -- 2026-05-16 migration: ticks on rejection, not on upload).
  revision_count         integer not null default 0,
  -- Per-artist "feedback read" marker, mirroring the 2026-08-06
  -- feedback_seen_revision column on uflow_projects.
  feedback_seen_revision integer not null default 0,

  -- Artist deliverables for this variant. One zip per variant.
  zip_url          text,
  glb_url          text,
  fbx_url          text,
  gltf_url         text,
  approved_glb_url text,

  -- Variants are normally all worked by the same artist, but
  -- allowing an override means a colourway can be split off to
  -- someone else without cloning the product.
  assigned_to    uuid references public.uflow_users(id) on delete set null,

  -- Exactly one primary per product (the original colourway).
  -- Deleting it is blocked in app code, not here.
  is_primary     boolean not null default false,
  -- Manual ordering for the QA switcher. Ties break on created_at.
  position       integer not null default 0,

  created_by     uuid references public.uflow_users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (project_id, slug)
);

create index if not exists idx_uflow_variants_project
  on public.uflow_project_variants(project_id);
create index if not exists idx_uflow_variants_status
  on public.uflow_project_variants(status);
create index if not exists idx_uflow_variants_assigned
  on public.uflow_project_variants(assigned_to);

-- At most one primary variant per product.
create unique index if not exists idx_uflow_variants_one_primary
  on public.uflow_project_variants(project_id)
  where is_primary;

alter table public.uflow_project_variants disable row level security;

-- ------------------------------------------------------------
-- 2. Feedback images gain a variant scope
-- ------------------------------------------------------------
-- QA rejects a single variant, so its feedback screenshots must
-- be attributable to that variant. Nullable + backfilled so
-- existing rows keep working; phase 3 starts writing it.
alter table public.uflow_feedback_images
  add column if not exists variant_id uuid
    references public.uflow_project_variants(id) on delete cascade;

alter table public.uflow_client_feedback_images
  add column if not exists variant_id uuid
    references public.uflow_project_variants(id) on delete cascade;

create index if not exists idx_uflow_feedback_variant
  on public.uflow_feedback_images(variant_id, revision);
create index if not exists idx_uflow_client_feedback_variant
  on public.uflow_client_feedback_images(variant_id, revision_number);

-- ------------------------------------------------------------
-- 3. Backfill: every existing project becomes its own primary
--    variant, carrying its current state across verbatim.
-- ------------------------------------------------------------
-- Idempotent: the NOT EXISTS guard means re-running is a no-op.
insert into public.uflow_project_variants (
  project_id, name, slug, status, revision_count,
  feedback_seen_revision, zip_url, glb_url, fbx_url, gltf_url,
  approved_glb_url, assigned_to, is_primary, position,
  created_by, created_at, updated_at
)
select
  p.id,
  'Original',
  'original',
  p.status,
  p.revision_count,
  coalesce(p.feedback_seen_revision, 0),
  p.zip_url, p.glb_url, p.fbx_url, p.gltf_url,
  p.approved_glb_url,
  p.assigned_to,
  true,
  0,
  p.created_by,
  p.created_at,
  p.updated_at
from public.uflow_projects p
where not exists (
  select 1 from public.uflow_project_variants v
  where v.project_id = p.id
);

-- Point existing feedback rows at the primary variant so no
-- rejection history is orphaned once phase 3 reads by variant.
update public.uflow_feedback_images f
set variant_id = v.id
from public.uflow_project_variants v
where v.project_id = f.project_id
  and v.is_primary
  and f.variant_id is null;

update public.uflow_client_feedback_images f
set variant_id = v.id
from public.uflow_project_variants v
where v.project_id = f.project_id
  and v.is_primary
  and f.variant_id is null;

COMMIT;

-- ============================================================
-- VERIFY (expect zero rows from each):
--
--   -- every project has exactly one primary variant
--   select p.id from uflow_projects p
--   left join uflow_project_variants v
--     on v.project_id = p.id and v.is_primary
--   where v.id is null;
--
--   -- no feedback left unattached
--   select id from uflow_feedback_images where variant_id is null;
--
-- TO REVERT:
--   alter table uflow_feedback_images        drop column variant_id;
--   alter table uflow_client_feedback_images drop column variant_id;
--   drop table uflow_project_variants;
-- (uflow_projects is untouched by this migration, so the app
--  keeps working on the old single-model path.)
-- ============================================================
