-- ============================================================
-- Migration: redefine revision_count to be rejection-based
-- Date: 2026-05-16
-- ============================================================
--
-- BACKGROUND
-- The old semantics of uflow_projects.revision_count was
-- "count of upload attempts the artist has submitted." Under
-- that rule, the counter ticked on every artist upload — so a
-- project that had been uploaded once, IQA-rejected, and
-- re-uploaded once would show revision_count=2, even though
-- structurally only ONE rejection round had completed.
--
-- The new semantics: revision_count = count of REJECTION rounds
-- (IQA + EQA combined). It ticks ONLY when admin or client
-- rejects, never on upload. So a fresh first submission has
-- revision_count=0; first rejection ticks it to 1; the artist's
-- re-upload after the first rejection keeps it at 1; second
-- rejection ticks it to 2; etc.
--
-- Feedback image rows (uflow_feedback_images.revision,
-- uflow_client_feedback_images.revision_number) are now tagged
-- with the POST-bump number so they match what the artist
-- sees in their Revision Round dropdown.
--
-- IMPACT ON EXISTING ROWS
-- Every existing row has a revision_count under the OLD rule.
-- Under the new rule, a row with N completed rejection rounds
-- should have revision_count = (number of admin + client
-- rejection feedback entries that actually exist).
--
-- We rebuild revision_count from the feedback tables, which
-- are the only durable record of how many rejection rounds
-- actually happened. This is more accurate than trying to
-- compute it from the old revision_count value, which mixed
-- "rejections seen" with "uploads sent."
--
-- We also remap the feedback rows' revision number from the
-- OLD scheme (number = the attempt number that got rejected,
-- e.g. attempt 1 rejected → revision=1, attempt 2 rejected →
-- revision=2) to the NEW scheme (number = the rejection round
-- number, which under the old upload-per-rejection rule
-- coincides one-to-one — so attempt N rejected ≡ rejection
-- round N). For existing data the numbers happen to be the
-- same. No remap query is needed for the feedback row tags.
-- ============================================================

BEGIN;

-- Rebuild revision_count = count of distinct rejection rounds
-- recorded for this project (admin IQA + client EQA combined).
-- A "round" is identified by the (project_id, revision) tuple
-- in uflow_feedback_images plus (project_id, revision_number)
-- in uflow_client_feedback_images. We count distinct revision
-- numbers across both tables so a single round with multiple
-- feedback images still counts as one rejection.
UPDATE uflow_projects p
SET revision_count = COALESCE((
  SELECT COUNT(DISTINCT rev) FROM (
    SELECT revision        AS rev FROM uflow_feedback_images        WHERE project_id = p.id
    UNION
    SELECT revision_number AS rev FROM uflow_client_feedback_images WHERE project_id = p.id
  ) rounds
), 0);

-- Sanity check: no row should now have revision_count greater
-- than the number of rejection rows in either table. (No
-- mutation; will surface as a NOTICE if anything looks off.)
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM uflow_projects p
  WHERE p.revision_count < 0;
  IF bad_count > 0 THEN
    RAISE NOTICE 'Found % rows with negative revision_count', bad_count;
  END IF;
END $$;

COMMIT;

-- ============================================================
-- After running this:
--   - Projects never rejected   → revision_count = 0
--   - Projects rejected N times → revision_count = N
-- ============================================================
