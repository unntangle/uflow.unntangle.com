-- ============================================================
-- Migration: split 'rejected' into 'iqa_rejected' + 'eqa_rejected'
--
-- WHAT THIS DOES:
--   - Adds two new ProjectStatus values:
--       'iqa_rejected' — admin (Internal QA) rejected the artist's
--                        submission; back to artist for revision.
--       'eqa_rejected' — client (External QA) rejected during their
--                        sign-off review; back to admin for triage.
--   - Renames all existing rows where status='rejected' (which are
--     all admin-side rejections under the old model) to
--     'iqa_rejected'.
--   - Tightens the CHECK constraint so the old 'rejected' value
--     is no longer valid going forward.
--
-- WHY:
--   The old model lumped both rejection types into qa_pending or
--   rejected — depending on who rejected — and we had no clean way
--   to filter "admin rejected, waiting on artist" vs "client
--   rejected, waiting on admin" without joining the feedback-
--   images table. Splitting at the status layer makes every query
--   self-explanatory.
--
-- SAFETY:
--   - Idempotent: re-running is a no-op (the rename of existing
--     rows finds none on the second pass).
--   - The CHECK constraint update fails fast if any row still has
--     status='rejected' when it runs, so a partial migration can't
--     leave the DB in an inconsistent state.
-- ============================================================

-- 1) Rename existing admin-side rejections.
--    Existing 'rejected' rows are admin-side under the old model
--    (client rejections went to qa_pending, not rejected).
update public.uflow_projects
   set status = 'iqa_rejected',
       updated_at = now()
 where status = 'rejected';

-- 2) Replace the CHECK constraint so 'rejected' is gone and the
--    two new values are allowed. We drop-and-recreate because
--    Postgres doesn't allow modifying a CHECK in place.
alter table public.uflow_projects
  drop constraint if exists uflow_projects_status_check;

alter table public.uflow_projects
  add constraint uflow_projects_status_check
  check (status in (
    'draft',
    'qa_pending',
    'iqa_rejected',
    'eqa_rejected',
    'wip',
    'client_review',
    'approved'
  ));

-- 3) (No data migration needed for 'eqa_rejected'; no existing
--     rows match — client rejections under the old model set
--     status to qa_pending, which is correct under the new model
--     until the next client rejection writes 'eqa_rejected'.)
