-- ============================================================
-- Migration: add the on_hold status ("On Hold by Client")
-- Date: 2026-08-28
-- ============================================================
--
-- WHY
-- A client sometimes pauses a job mid-pipeline: the brief is
-- under review on their side, a PO hasn't landed, the product
-- itself changed. Until now there was nowhere to put that job.
-- It stayed in whatever queue it was in, so the artist's list,
-- the IQA queue and the Open Jobs count all kept claiming work
-- that nobody was allowed to touch.
--
-- `on_hold` is a PARKING state, not a pipeline stage. Nothing
-- transitions into it by doing work — only an admin sets it,
-- from the Change Status page. Nothing transitions out of it by
-- doing work either, so the job has to remember where it came
-- from.
--
-- hold_prev_status
-- ----------------
-- That's what this column is for. When a row is put on hold we
-- stash its current status here; when it's resumed we write that
-- value back and null this out. Without it, releasing a hold
-- could only send the job back to the START of the pipeline,
-- which would throw away everything between draft and wherever
-- the client paused it — a job held while awaiting EQA sign-off
-- would come back as an unstarted draft.
--
-- It is deliberately NOT part of the status CHECK list: a job
-- can never have been on hold *before* being on hold, so
-- 'on_hold' is excluded from the values this column accepts.
-- NULL means "not currently held, or held from a state we
-- couldn't record" — the app falls back to 'draft' in that case.
--
-- BOTH TABLES
-- Since the 2026-08-06 variants migration, uflow_project_variants
-- carries the authoritative per-colourway status and
-- uflow_projects.status is only written on the legacy
-- single-model path. A hold has to be expressible on either, so
-- both tables get the same treatment — otherwise holding a job
-- that has colourways would save happily and change nothing any
-- dashboard can see.
--
-- SAFETY
-- Purely additive. No existing row changes value, no existing
-- row violates the new constraints, and the new column is
-- nullable with no default. Idempotent: the constraints are
-- dropped before being recreated and the columns use IF NOT
-- EXISTS, so re-running is a no-op.
--
-- RUN THIS BEFORE DEPLOYING THE APP CODE. The Change Status
-- page selects hold_prev_status (via VARIANT_SELECT_WITH_HOLD in
-- lib/variant-status.ts), and PostgREST rejects the WHOLE query
-- when a selected column doesn't exist. Nothing else selects it,
-- so that page is the only one that breaks if the app ships
-- first — but every part of the feature is dead until this runs,
-- because 'on_hold' isn't a legal status value beforehand.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. uflow_projects — allow the new status
-- ------------------------------------------------------------
ALTER TABLE public.uflow_projects
  DROP CONSTRAINT IF EXISTS uflow_projects_status_check;

ALTER TABLE public.uflow_projects
  ADD CONSTRAINT uflow_projects_status_check
  CHECK (status IN (
    'draft',
    'qa_pending',
    'iqa_rejected',
    'eqa_rejected',
    'wip',
    'iqa_wip',
    'eqa_wip',
    'client_review',
    'approved',
    'on_hold'
  ));

ALTER TABLE public.uflow_projects
  ADD COLUMN IF NOT EXISTS hold_prev_status text;

ALTER TABLE public.uflow_projects
  DROP CONSTRAINT IF EXISTS uflow_projects_hold_prev_status_check;

ALTER TABLE public.uflow_projects
  ADD CONSTRAINT uflow_projects_hold_prev_status_check
  CHECK (hold_prev_status IS NULL OR hold_prev_status IN (
    'draft',
    'qa_pending',
    'iqa_rejected',
    'eqa_rejected',
    'wip',
    'iqa_wip',
    'eqa_wip',
    'client_review',
    'approved'
  ));

-- ------------------------------------------------------------
-- 2. uflow_project_variants — same, per colourway
-- ------------------------------------------------------------
-- The variants table declared its CHECK inline in the 2026-08-06
-- migration, so Postgres auto-named it <table>_<column>_check.
ALTER TABLE public.uflow_project_variants
  DROP CONSTRAINT IF EXISTS uflow_project_variants_status_check;

ALTER TABLE public.uflow_project_variants
  ADD CONSTRAINT uflow_project_variants_status_check
  CHECK (status IN (
    'draft',
    'qa_pending',
    'iqa_rejected',
    'eqa_rejected',
    'wip',
    'iqa_wip',
    'eqa_wip',
    'client_review',
    'approved',
    'on_hold'
  ));

ALTER TABLE public.uflow_project_variants
  ADD COLUMN IF NOT EXISTS hold_prev_status text;

ALTER TABLE public.uflow_project_variants
  DROP CONSTRAINT IF EXISTS uflow_project_variants_hold_prev_status_check;

ALTER TABLE public.uflow_project_variants
  ADD CONSTRAINT uflow_project_variants_hold_prev_status_check
  CHECK (hold_prev_status IS NULL OR hold_prev_status IN (
    'draft',
    'qa_pending',
    'iqa_rejected',
    'eqa_rejected',
    'wip',
    'iqa_wip',
    'eqa_wip',
    'client_review',
    'approved'
  ));

-- Held jobs are read as a set (the Overview's Hold tab), so the
-- existing status index earns its keep here too. Listed for
-- completeness — idx_uflow_variants_status already exists from
-- the variants migration and covers this.
create index if not exists idx_uflow_projects_status
  on public.uflow_projects(status);

COMMIT;

-- ============================================================
-- VERIFY
--
--   -- the new value is accepted
--   select 'on_hold'::text = any (
--     enum_range(null::text)::text[]  -- n/a: this is a CHECK, not an enum
--   );
--
--   -- nothing is stranded: no row claims a hold origin while
--   -- not actually being on hold
--   select id from uflow_project_variants
--   where hold_prev_status is not null and status <> 'on_hold';
--
--   select id from uflow_projects
--   where hold_prev_status is not null and status <> 'on_hold';
--
-- TO REVERT:
--   update uflow_project_variants
--     set status = coalesce(hold_prev_status, 'draft'), hold_prev_status = null
--     where status = 'on_hold';
--   update uflow_projects
--     set status = coalesce(hold_prev_status, 'draft'), hold_prev_status = null
--     where status = 'on_hold';
--   alter table uflow_projects        drop column hold_prev_status;
--   alter table uflow_project_variants drop column hold_prev_status;
--   -- then re-add the pre-migration CHECK constraints (the same
--   -- lists above, minus 'on_hold').
-- ============================================================
