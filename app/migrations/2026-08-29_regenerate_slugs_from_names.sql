-- ============================================================
-- Migration: regenerate every project slug from its name
-- Date: 2026-08-29
-- ============================================================
--
-- WHY
-- The 2026-08-29 variant promotion built child slugs as
-- '<parent-slug>-<variant-slug>'. That was right when a variant
-- was named for its colour alone ("Black" → "ferro-black"), but
-- most variants here already carried the full product name, so
-- the rule doubled it up:
--
--   Ferro Grey                        → ferro-ferro-grey
--   Sync Workstation 6 Seater - Paria Oak
--     → sync-workstation-4-seater---paria-oak-sync-workstation-
--       6-seater-paria-oak
--
-- This recomputes EVERY project's slug from its own name, so a
-- job's slug always reads as its product name and nothing else.
--
-- ------------------------------------------------------------
-- READ THIS BEFORE RUNNING
-- ------------------------------------------------------------
-- The slug is not just a label. It is:
--
--   1. the PUBLIC URL segment on officemate.unntangle.com/<slug>
--   2. the R2/Cloudinary folder prefix for FUTURE uploads,
--      '<client>/<slug>/uploads/rev-N/...'
--
-- What this migration does NOT break: every already-uploaded
-- asset. zip_url / glb_url / fbx_url / gltf_url / approved_glb_url
-- are stored as ABSOLUTE urls, so existing files keep resolving
-- from their old prefix untouched. Nothing is moved or deleted.
--
-- What it DOES change:
--
--   * Public viewer links change. Any URL already shared with a
--     client for an approved model will 404 on the old slug.
--     Republish afterwards (scripts/republish-all.ts) and re-send
--     anything that was circulated.
--   * A job's future uploads land under the NEW prefix while its
--     existing revisions sit under the old one. Harmless — the DB
--     holds absolute urls either way — but the storage bucket
--     will show two folders for those jobs.
--
-- If either of those matters more than tidy slugs, don't run
-- this; rename only the promoted children by hand instead.
--
-- TAKE A BACKUP FIRST.
-- ============================================================

-- ------------------------------------------------------------
-- PREVIEW — run this ALONE first, before the transaction below.
-- It writes nothing and shows exactly what would change.
-- ------------------------------------------------------------
-- with computed as (
--   select
--     p.id, p.client_id, p.name, p.slug as old_slug, p.created_at,
--     coalesce(
--       nullif(
--         regexp_replace(
--           regexp_replace(lower(p.name), '[^a-z0-9]+', '-', 'g'),
--           '^-+|-+$', '', 'g'
--         ), ''
--       ),
--       'model-' || left(replace(p.id::text, '-', ''), 8)
--     ) as base
--   from public.uflow_projects p
-- ),
-- numbered as (
--   select *, row_number() over (
--     partition by client_id, base order by created_at, id
--   ) as rn
--   from computed
-- )
-- select name, old_slug,
--        case when rn = 1 then base else base || '-' || rn end as new_slug
-- from numbered
-- where old_slug is distinct from
--       (case when rn = 1 then base else base || '-' || rn end)
-- order by name;

BEGIN;

-- ------------------------------------------------------------
-- Pass 1 — park every row on a guaranteed-unique temporary slug
-- ------------------------------------------------------------
-- (client_id, slug) is a non-deferrable UNIQUE constraint, so
-- Postgres checks it row-by-row DURING the update. Renaming
-- straight to the final values would fail the moment two rows
-- need to swap or shift positions (e.g. 'ferro-grey' freeing up
-- for a row that is processed later). Parking on an id-derived
-- value first makes the second pass collision-free by
-- construction.
update public.uflow_projects
set slug = 'tmp-' || replace(id::text, '-', '');

-- ------------------------------------------------------------
-- Pass 2 — write the real slugs
-- ------------------------------------------------------------
-- base: lowercase the name, collapse every run of non-alphanumeric
--   characters to a single hyphen, trim hyphens off both ends.
--   Handles the en-dash in "6 Seater - Paria Oak" and stops the
--   '---' runs the old data had.
--
-- fallback: a name with no letters or digits at all would slugify
--   to an empty string, which is not a usable URL segment. Those
--   get 'model-<id fragment>' rather than failing the migration.
--
-- rn: duplicate names within ONE client get -2, -3, ... in
--   created_at order, so the oldest job keeps the clean slug.
--   Different clients may share a slug — the unique key is
--   (client_id, slug), and their storage prefixes differ.
with computed as (
  select
    p.id,
    p.client_id,
    p.created_at,
    coalesce(
      nullif(
        regexp_replace(
          regexp_replace(lower(p.name), '[^a-z0-9]+', '-', 'g'),
          '^-+|-+$', '', 'g'
        ), ''
      ),
      'model-' || left(replace(p.id::text, '-', ''), 8)
    ) as base
  from public.uflow_projects p
),
numbered as (
  select
    id,
    base,
    row_number() over (
      partition by client_id, base order by created_at, id
    ) as rn
  from computed
)
update public.uflow_projects p
set slug = case when n.rn = 1 then n.base else n.base || '-' || n.rn end
from numbered n
where n.id = p.id;

COMMIT;

-- ============================================================
-- VERIFY
--
--   -- nothing parked on a temporary slug (expect 0)
--   select count(*) from uflow_projects where slug like 'tmp-%';
--
--   -- every slug now derives from its own name (expect 0 rows)
--   select name, slug from uflow_projects
--   where slug <> regexp_replace(
--           regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'),
--           '^-+|-+$', '', 'g')
--     and slug !~ '-[0-9]+$';
--
--   -- the promoted children, for a sanity read
--   select c.name, c.slug, p.name as parent
--   from uflow_projects c
--   join uflow_projects p on p.id = c.parent_id
--   where c.model_type = 'child'
--   order by p.name, c.name;
--
-- AFTERWARDS
--   Republish approved models so the public viewer serves them
--   from their new slug:  npx tsx app/scripts/republish-all.ts
-- ============================================================
