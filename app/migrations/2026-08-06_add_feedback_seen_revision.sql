-- ============================================================
-- Migration: per-artist "feedback seen" marker
-- Date: 2026-08-06
-- ============================================================
--
-- BACKGROUND
-- When admin rejects at IQA (status -> iqa_rejected) or a client
-- rejects at EQA (status -> eqa_rejected), the row surfaces in a
-- Rejected tab on BOTH the admin and the artist dashboards.
--
-- We want the artist's Rejected tab to behave like an inbox: a
-- row leaves it once the artist has actually opened the feedback
-- gallery. Admin must KEEP seeing the row until the artist truly
-- starts work, because that's admin's only signal that feedback
-- is sitting unactioned.
--
-- That rules out driving this off `status` — status is global, so
-- changing it would clear the row from admin's tab at the same
-- time. Hence a separate marker column.
--
-- WHY A REVISION NUMBER, NOT A BOOLEAN OR TIMESTAMP
-- A boolean would latch: once the artist read round 1, a later
-- round-2 rejection would never re-surface in their tab. Storing
-- the revision the artist has seen makes it self-resetting —
-- revision_count ticks on every rejection (see the 2026-05-16
-- rejection-semantics migration), so the row reappears the moment
-- a new round lands.
--
-- READ RULE (artist dashboard):
--   unread feedback  <=>  revision_count > feedback_seen_revision
--
-- WRITE RULE:
--   opening /projects/[id]/feedback as the assigned artist sets
--   feedback_seen_revision = revision_count
--
-- BACKFILL
-- Default 0 means every existing row starts as "unseen". Rejected
-- rows always have revision_count >= 1, so they all correctly
-- appear in the artist's Rejected tab on first deploy. Rows that
-- were never rejected have revision_count = 0, so 0 > 0 is false
-- and they stay out of the tab regardless.
-- ============================================================

BEGIN;

ALTER TABLE uflow_projects
  ADD COLUMN IF NOT EXISTS feedback_seen_revision integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN uflow_projects.feedback_seen_revision IS
  'Highest rejection round whose feedback the assigned artist has opened. '
  'Artist sees unread feedback when revision_count > feedback_seen_revision. '
  'Does not affect admin visibility.';

-- Guard against a marker running ahead of the actual round count
-- (possible only if a row were hand-edited). Clamp to be safe.
UPDATE uflow_projects
SET feedback_seen_revision = revision_count
WHERE feedback_seen_revision > revision_count;

COMMIT;

-- ============================================================
-- To revert:
--   ALTER TABLE uflow_projects DROP COLUMN feedback_seen_revision;
-- ============================================================
