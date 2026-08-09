-- ============================================================
-- Migration: add uflow_projects.complexity + uflow_projects.category
-- Date: 2026-08-09
-- ============================================================
--
-- Two new classification fields set by the admin on the Create
-- Job form and editable afterwards from Edit Job:
--
--   complexity — modelling effort band: easy | moderate | hard | complex
--   category   — product type: sofa | table | chair | office_chair
--                | cushion_chair | bar_stool | pouffe
--
-- Both are NULLABLE on purpose. Every row that existed before
-- this migration has neither, and backfilling would mean
-- guessing — a job's complexity isn't derivable from its name.
-- NULL reads as "not classified" and renders as an em dash in
-- the UI. The forms leave the select on a blank placeholder
-- rather than defaulting to the first option, so an admin never
-- silently ships a value they didn't pick.
--
-- The CHECK constraints mirror app/lib/job-options.ts, which is
-- the single source of truth for the UI + API validation. If you
-- add an option there, widen the matching constraint in a NEW
-- migration — don't edit this file after it has been run.
--
-- Idempotent and safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE public.uflow_projects
  ADD COLUMN IF NOT EXISTS complexity text,
  ADD COLUMN IF NOT EXISTS category   text;

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so we guard
-- on the catalog to keep the whole file re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uflow_projects_complexity_check'
  ) THEN
    ALTER TABLE public.uflow_projects
      ADD CONSTRAINT uflow_projects_complexity_check
      CHECK (
        complexity IS NULL
        OR complexity IN ('easy', 'moderate', 'hard', 'complex')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uflow_projects_category_check'
  ) THEN
    ALTER TABLE public.uflow_projects
      ADD CONSTRAINT uflow_projects_category_check
      CHECK (
        category IS NULL
        OR category IN (
          'sofa', 'table', 'chair', 'office_chair',
          'cushion_chair', 'bar_stool', 'pouffe'
        )
      );
  END IF;
END $$;

-- Category is the field you'd realistically filter or group the
-- job list by ("show me all the bar stools"), so it gets an
-- index. Complexity has only four distinct values across a small
-- table — a scan beats an index there, so it doesn't get one.
CREATE INDEX IF NOT EXISTS idx_uflow_projects_category
  ON public.uflow_projects(category);

COMMIT;
