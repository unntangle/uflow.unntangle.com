-- ============================================================
-- Migration: add uflow_projects.spp_url
-- Date: 2026-06-24
-- ============================================================
--
-- Adds a column to store the public R2 URL of the artist's
-- Substance Painter project file (.spp), extracted from the
-- uploaded source zip alongside the glb/fbx/gltf.
--
-- Forward-looking: existing rows get NULL (no .spp captured for
-- past uploads). The value is populated on the next finalize-
-- upload once the artist's zip contains a .spp file. The admin
-- Download Jobs page shows a dash for any job whose spp_url is
-- still NULL.
--
-- Idempotent and safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.uflow_projects
  ADD COLUMN IF NOT EXISTS spp_url text;

COMMIT;
