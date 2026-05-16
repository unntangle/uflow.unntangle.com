-- ============================================================
-- Migration: add iqa_wip + eqa_wip statuses
-- Date: 2026-05-16
-- ============================================================
--
-- WHY
-- The previous flow lumped every "artist actively working"
-- state into a single `wip`, regardless of whether the work
-- originated from a fresh assignment, an IQA rejection, or an
-- EQA rejection. Splitting `wip` into three flavours lets the
-- StatusBadge tell the admin at a glance whether the artist is
-- responding to internal QA feedback, client feedback, or
-- working on a new model.
--
-- STATE MACHINE (post-migration):
--   draft         + Start  → wip          (fresh job)
--   iqa_rejected  + Start  → iqa_wip      (working on admin's feedback)
--   eqa_rejected  + Start  → eqa_wip      (working on client's feedback)
--   wip / iqa_wip / eqa_wip + Upload → qa_pending
--
-- The three WIP statuses behave identically downstream — they
-- all upload back to qa_pending. The difference is purely
-- display-layer so admins can see context in the WIP tab.
--
-- SAFETY
-- Idempotent on the CHECK constraint via drop-and-recreate. No
-- existing rows need to be remapped — anything currently in
-- `wip` stays in `wip` (since we can't infer which kind of WIP
-- it came from without the rejection history, and it doesn't
-- matter for already-in-progress work).
-- ============================================================

BEGIN;

-- Drop and replace the CHECK constraint to allow the two new
-- values alongside the existing ones.
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
    'approved'
  ));

COMMIT;
