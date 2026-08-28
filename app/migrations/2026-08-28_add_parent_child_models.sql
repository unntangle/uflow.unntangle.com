-- ============================================================
-- Migration: parent / child models
-- Date: 2026-08-28
-- ============================================================
--
-- GOAL
-- Replace the user-facing "variants" (colourways) idea with a
-- plain hierarchy between JOBS.
--
--   * every job is either a PARENT or a CHILD
--   * a CHILD points at exactly one existing PARENT job
--   * a CHILD is a full job in its own right: its own slug, its
--     own artist, its own zip, its own QA cycle, its own status
--
-- This is deliberately different from uflow_project_variants.
-- A variant was a sub-row hanging off one product and had to be
-- rolled up before a dashboard could show a single status. A
-- child is just another row in uflow_projects, so every existing
-- list, queue, badge and upload path keeps working untouched —
-- parent_id is only a link for grouping and display.
--
-- DEPTH
-- One level only. A child cannot itself be a parent. That is
-- enforced in the API layer (app/api/projects/route.ts), not
-- here: Postgres CHECK constraints cannot see another row, and
-- a trigger would be more machinery than this needs.
--
-- ON DELETE
-- SET NULL, not CASCADE. Deleting a parent must never silently
-- destroy finished child models. Orphaned children keep their
-- work and are re-parented (or flipped back to parent) by hand.
-- Note the shape constraint below tolerates the orphan window.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
-- Existing rows all become parents, which is the correct
-- reading: nothing created before today was declared a child of
-- anything.
alter table public.uflow_projects
  add column if not exists model_type text not null default 'parent';

alter table public.uflow_projects
  drop constraint if exists uflow_projects_model_type_check;
alter table public.uflow_projects
  add constraint uflow_projects_model_type_check
  check (model_type in ('parent', 'child'));

alter table public.uflow_projects
  add column if not exists parent_id uuid
    references public.uflow_projects(id) on delete set null;

create index if not exists idx_uflow_projects_parent
  on public.uflow_projects(parent_id);
create index if not exists idx_uflow_projects_model_type
  on public.uflow_projects(model_type);

-- ------------------------------------------------------------
-- 2. Shape rules
-- ------------------------------------------------------------
-- A parent must not carry a parent_id. A child normally has one,
-- but is allowed to be temporarily orphaned: the FK above is ON
-- DELETE SET NULL, so deleting a parent nulls its children's
-- parent_id, and a stricter constraint would make that delete
-- fail outright and block the admin. An orphan is surfaced in
-- the UI as "child, parent removed" rather than being prevented.
alter table public.uflow_projects
  drop constraint if exists uflow_projects_parent_shape_check;
alter table public.uflow_projects
  add constraint uflow_projects_parent_shape_check
  check (model_type = 'child' or parent_id is null);

-- A row can never be its own parent.
alter table public.uflow_projects
  drop constraint if exists uflow_projects_no_self_parent_check;
alter table public.uflow_projects
  add constraint uflow_projects_no_self_parent_check
  check (parent_id is null or parent_id <> id);

COMMIT;

-- ============================================================
-- VERIFY (expect zero rows from each):
--
--   -- no child without a parent link
--   select id, name from uflow_projects
--   where model_type = 'child' and parent_id is null;
--
--   -- no grandchildren (API-enforced, checked here)
--   select c.id, c.name from uflow_projects c
--   join uflow_projects p on p.id = c.parent_id
--   where p.model_type = 'child';
--
--   -- no cross-client parenting
--   select c.id, c.name from uflow_projects c
--   join uflow_projects p on p.id = c.parent_id
--   where p.client_id <> c.client_id;
--
-- TO REVERT:
--   alter table uflow_projects drop constraint if exists
--     uflow_projects_no_self_parent_check;
--   alter table uflow_projects drop constraint if exists
--     uflow_projects_parent_shape_check;
--   alter table uflow_projects drop constraint if exists
--     uflow_projects_model_type_check;
--   alter table uflow_projects drop column if exists parent_id;
--   alter table uflow_projects drop column if exists model_type;
-- ============================================================
