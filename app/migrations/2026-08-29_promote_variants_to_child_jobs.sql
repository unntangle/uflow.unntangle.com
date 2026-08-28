-- ============================================================
-- Migration: promote colourway variants to child jobs
-- Date: 2026-08-29
-- ============================================================
--
-- GOAL
-- Retire uflow_project_variants as a live concept. Every extra
-- colourway becomes a REAL JOB in uflow_projects, linked to the
-- model it came from by the parent_id added on 2026-08-28.
--
-- Before:  Zenpro Grey (project)
--            └ Original      (primary variant — holds the state)
--            └ Zenpro Black  (variant — its own status + assets)
--
-- After:   Zenpro Grey  (project, model_type='parent')
--          Zenpro Black (project, model_type='child',
--                        parent_id → Zenpro Grey)
--
-- WHY THIS IS SAFE TO RUN BEFORE THE CODE IS CLEANED UP
-- Every pipeline route (start, upload-sign, finalize-upload,
-- feedback, client-review, status) takes variant_id as OPTIONAL
-- and falls back to a project-level path when it's absent. The
-- roll-up helpers in lib/variant-status.ts do the same: with
-- zero variant rows, rollupStatus / anyVariantIn / queueStatus
-- all fall back to uflow_projects.status. So emptying the table
-- moves every surface onto the legacy single-model path rather
-- than breaking it.
--
-- That is also why the PRIMARY variant's state is copied BACK
-- onto its project row first. Since 2026-08-06 the primary row
-- has been the authoritative holder of status, revision count
-- and asset URLs; uflow_projects.status has been going stale.
-- Skipping this step would roll every job back to whatever its
-- product column last said — usually 'draft'.
--
-- THIS MIGRATION IS NOT AUTOMATICALLY REVERSIBLE.
-- It creates rows, rewrites foreign keys and deletes variant
-- rows. TAKE A DATABASE BACKUP FIRST. The verification queries
-- at the bottom should be run before you accept the result.
--
-- The table itself is deliberately NOT dropped — only emptied.
-- Dropping it is a one-line follow-up once the app code no
-- longer references it, and keeping it means this migration is
-- inspectable if something looks wrong afterwards.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Guard: the 2026-08-28 hierarchy migration must be in place
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'uflow_projects'
      and column_name = 'parent_id'
  ) then
    raise exception
      'Run 2026-08-28_add_parent_child_models.sql before this migration.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Copy the PRIMARY variant's state back onto its project
-- ------------------------------------------------------------
-- coalesce on the asset URLs so a primary that never got a zip
-- doesn't blank out a URL the product row still legitimately
-- holds (pre-2026-08-06 jobs kept theirs on the product).
update public.uflow_projects p
set
  status                 = v.status,
  revision_count         = v.revision_count,
  feedback_seen_revision = v.feedback_seen_revision,
  zip_url                = coalesce(v.zip_url, p.zip_url),
  glb_url                = coalesce(v.glb_url, p.glb_url),
  fbx_url                = coalesce(v.fbx_url, p.fbx_url),
  gltf_url               = coalesce(v.gltf_url, p.gltf_url),
  approved_glb_url       = coalesce(v.approved_glb_url, p.approved_glb_url),
  assigned_to            = coalesce(v.assigned_to, p.assigned_to),
  updated_at             = greatest(p.updated_at, v.updated_at)
from public.uflow_project_variants v
where v.project_id = p.id
  and v.is_primary;

-- hold_prev_status only exists if 2026-08-28_add_on_hold_status
-- has run. Guarded so this migration works either way.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'uflow_project_variants'
      and column_name = 'hold_prev_status'
  ) then
    update public.uflow_projects p
    set hold_prev_status = v.hold_prev_status
    from public.uflow_project_variants v
    where v.project_id = p.id
      and v.is_primary
      and v.hold_prev_status is not null;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Temporary back-reference column
-- ------------------------------------------------------------
-- INSERT ... SELECT can't RETURNING its way back to the source
-- row, and we need that mapping to re-point feedback images. A
-- scratch column is the simplest reliable join key; it's dropped
-- at the end of this transaction.
alter table public.uflow_projects
  add column if not exists _promoted_from_variant uuid;

-- ------------------------------------------------------------
-- 3. Promote every NON-PRIMARY variant to a child job
-- ------------------------------------------------------------
-- name: taken verbatim from the variant. These already read as
--   full job names in practice ("Zenpro Black"), and inventing
--   "<parent> <variant>" would produce "Zenpro Grey Zenpro
--   Black". Anything that reads oddly is fixable from Edit Job.
--
-- slug: '<parent-slug>-<variant-slug>'. This is deliberately the
--   SAME namespace finalize-upload already used for non-primary
--   variant assets, so every file uploaded to date still sits
--   under its new job's prefix. A short id fragment is appended
--   only if that slug is already taken for this client, since
--   (client_id, slug) is unique.
--
-- brief / complexity / category are inherited: the colourway was
--   always modelled from the parent's brief.
insert into public.uflow_projects (
  client_id, slug, name, status, revision_count,
  feedback_seen_revision, zip_url, glb_url, fbx_url, gltf_url,
  approved_glb_url, assigned_to, brief, complexity, category,
  model_type, parent_id, created_by, created_at, updated_at,
  _promoted_from_variant
)
select
  p.client_id,
  case
    when exists (
      select 1 from public.uflow_projects p2
      where p2.client_id = p.client_id
        and p2.slug = p.slug || '-' || v.slug
    )
    then p.slug || '-' || v.slug || '-' ||
         left(replace(v.id::text, '-', ''), 6)
    else p.slug || '-' || v.slug
  end,
  v.name,
  v.status,
  v.revision_count,
  v.feedback_seen_revision,
  v.zip_url, v.glb_url, v.fbx_url, v.gltf_url,
  v.approved_glb_url,
  coalesce(v.assigned_to, p.assigned_to),
  p.brief, p.complexity, p.category,
  'child',
  p.id,
  coalesce(v.created_by, p.created_by),
  v.created_at,
  v.updated_at,
  v.id
from public.uflow_project_variants v
join public.uflow_projects p on p.id = v.project_id
where not v.is_primary;

-- ------------------------------------------------------------
-- 4. Re-point rejection history onto the new child jobs
-- ------------------------------------------------------------
-- Feedback rows carry BOTH project_id (the old product) and
-- variant_id. The screenshots belong to the colourway, so they
-- follow it to its new job row.
update public.uflow_feedback_images f
set project_id = np.id
from public.uflow_projects np
where np._promoted_from_variant = f.variant_id;

update public.uflow_client_feedback_images f
set project_id = np.id
from public.uflow_projects np
where np._promoted_from_variant = f.variant_id;

-- Everything still pointing at a variant is primary-variant
-- feedback, which already sits on the right project_id.
update public.uflow_feedback_images
set variant_id = null
where variant_id is not null;

update public.uflow_client_feedback_images
set variant_id = null
where variant_id is not null;

-- ------------------------------------------------------------
-- 5. Give each child its own copy of the reference images
-- ------------------------------------------------------------
-- References were attached to the PRODUCT and shared across
-- colourways. Now that a colourway is its own job, it needs its
-- own rows or the artist opens it to an empty brief. Same URLs —
-- no files are copied, only the join rows.
insert into public.uflow_project_references (
  project_id, image_url, uploaded_by, created_at
)
select
  child.id, r.image_url, r.uploaded_by, r.created_at
from public.uflow_projects child
join public.uflow_project_references r on r.project_id = child.parent_id
where child._promoted_from_variant is not null;

-- ------------------------------------------------------------
-- 6. Retire the variant rows
-- ------------------------------------------------------------
-- Emptied, not dropped. With zero rows every roll-up helper and
-- every API route falls through to its project-level path, so
-- the app runs unchanged while the code that mentions variants
-- is removed at leisure.
delete from public.uflow_project_variants;

-- ------------------------------------------------------------
-- 7. Remove the scratch column
-- ------------------------------------------------------------
alter table public.uflow_projects
  drop column if exists _promoted_from_variant;

COMMIT;

-- ============================================================
-- VERIFY
--
--   -- no variant rows left (expect 0)
--   select count(*) from uflow_project_variants;
--
--   -- the promoted jobs, with their parents (expect one row per
--   -- former non-primary colourway, e.g. Zenpro Black)
--   select c.name as child, c.slug, c.status, p.name as parent
--   from uflow_projects c
--   join uflow_projects p on p.id = c.parent_id
--   where c.model_type = 'child'
--   order by p.name, c.name;
--
--   -- no orphaned children (expect 0)
--   select count(*) from uflow_projects
--   where model_type = 'child' and parent_id is null;
--
--   -- no feedback still keyed to a variant (expect 0)
--   select count(*) from uflow_feedback_images where variant_id is not null;
--
--   -- nothing lost its approved asset (expect 0)
--   select count(*) from uflow_projects
--   where status = 'approved' and approved_glb_url is null and glb_url is null;
--
-- ONCE THE APP CODE NO LONGER REFERENCES VARIANTS:
--   alter table uflow_feedback_images        drop column variant_id;
--   alter table uflow_client_feedback_images drop column variant_id;
--   drop table uflow_project_variants;
-- ============================================================
