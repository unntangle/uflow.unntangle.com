import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase, ProjectStatus } from '../../../../lib/supabase';
import { isProjectStatus } from '../../../../lib/status-options';
import { refreshManifest } from '../../../../lib/publish';

export const runtime = 'nodejs';

// ============================================================
// PATCH /api/projects/:id/status
//
// Admin-only MANUAL OVERRIDE of a job's pipeline status. This is
// the API behind the sidebar's Change Status page, and it's the
// hosted equivalent of scripts/set-project-status.ts.
//
// Body (JSON):
//   {
//     status?: ProjectStatus,
//     resume?: boolean,
//     variant_id?: string | null,
//     clear_assignment?: boolean
//   }
//
// Exactly one of `status` or `resume: true` is required.
//
// Why clear_assignment exists
// ---------------------------
// The page's dropdown offers YTA and YTS, which are not two
// statuses — both are 'draft', and StatusBadge splits them on
// whether an artist is assigned. Writing status alone would make
// YTA silently land on YTS whenever the job already had an
// artist, so the caller says explicitly whether the assignment
// goes with it.
//
// Assignment is a JOB-level concept everywhere else in this app
// (Job Allocation and Reassign both operate on uflow_projects),
// so this always clears uflow_projects.assigned_to — even when
// variant_id targets a colourway. Per-variant assigned_to is
// left alone; finalize-upload already treats the project's
// assignee as the fallback owner.
//
// Why `resume` exists
// -------------------
// 'on_hold' ("On Hold by Client") is a parking state, not a
// pipeline stage — see migrations/2026-08-28. Coming off a hold
// means going back to whatever the row was doing when it was
// paused, and only the server knows that: it's stashed in
// hold_prev_status when the hold is applied.
//
// The caller therefore can't send a status for this move without
// guessing, so it sends `resume: true` and this route resolves
// the destination. The inverse bookkeeping lives here too:
//
//   → on_hold      record the current status as hold_prev_status
//                  (an already-held row keeps its ORIGINAL origin,
//                  so re-holding can't overwrite it with 'on_hold')
//   → resume       write hold_prev_status back, then clear it
//   → anything else  clear hold_prev_status; it no longer
//                  describes where the row is
//
// A resume with no recorded origin (a hold applied before the
// column existed) falls back to 'draft' and says so in
// `warnings` rather than failing — refusing would strand the job
// in a state with no way out.
//
// Why this is a separate endpoint from PATCH /api/projects/:id
// -----------------------------------------------------------
// That route deliberately refuses to touch status: its comment
// says renaming "must not be a backdoor into mutating pipeline
// state". That reasoning still holds, so rather than weakening
// it, status lives here — one endpoint with one obvious purpose,
// which also means a status change can't hide inside a rename.
//
// Which row gets written
// ----------------------
// Since the 2026-08-06 variants migration, uflow_project_variants
// holds the authoritative per-colourway status and every
// dashboard derives its badge from those rows (see
// lib/variant-status.ts). uflow_projects.status is only written
// on the legacy single-model path.
//
// So passing variant_id writes ONLY that variant row — the same
// rule finalize-upload follows ("When a variant was targeted we
// write ONLY the variant row"). Omitting it writes the product
// row, which is what pre-migration jobs with no variant rows
// need.
//
// WHAT THIS DOES NOT DO
// ---------------------
// Only `status`, `hold_prev_status` and `updated_at` change.
// Deliberately untouched:
//
//   - revision_count   owned by the rejection path (POST /feedback)
//   - assigned_to      owned by /assign
//   - glb_url etc.     owned by /finalize-upload
//   - approved_glb_url + the published viewer page
//
// That last one is the sharp edge. Setting a job to 'approved'
// here does NOT run publishGlbToPublicFolder, so no public
// viewer page is written and approved_glb_url stays empty — the
// job reads as approved everywhere internally while having
// nothing published. Use the QA Review approve flow for a real
// sign-off; use this to correct a status that's simply wrong.
//
// Resuming BACK INTO 'approved' is the exception: that row was
// genuinely approved before it was held, so its published page
// and approved_glb_url are still intact and no warning is due.
//
// Moving a product row OUT of 'approved' DOES refresh the public
// manifest, because writeManifest() selects on
// uflow_projects.status = 'approved' — leaving it stale would
// keep an unapproved model listed in every public viewer's
// sidebar. Putting an approved job on hold counts as leaving it,
// for the same reason: a paused job shouldn't stay listed. Both
// of these come back as `warnings` so the UI can surface them
// instead of silently succeeding.
// ============================================================

// The DB columns are plain text, so anything read back out gets
// re-checked against the union rather than trusted. A value that
// doesn't match (hand-edited row, older enum) reads as "no
// recorded origin", which the resume path already handles.
function asStatus(v: unknown): ProjectStatus | null {
  return isProjectStatus(v) ? v : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: {
    status?: unknown;
    resume?: unknown;
    variant_id?: unknown;
    clear_assignment?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const resume = body.resume === true;
  const requestedStatus = asStatus(body.status);

  // `resume` supplies its own destination, so a status is only
  // required when it's absent.
  if (!resume && !requestedStatus) {
    return NextResponse.json(
      { error: 'Invalid status value.' },
      { status: 400 }
    );
  }

  const variantId =
    typeof body.variant_id === 'string' && body.variant_id.trim()
      ? body.variant_id.trim()
      : null;

  const clearAssignment = body.clear_assignment === true;

  // ----- Load the product -----
  // Fetched even on the variant path: it scopes the variant so a
  // stray id from another job can't be written through this URL.
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select('id, name, slug, status, assigned_to, hold_prev_status')
    .eq('id', id)
    .maybeSingle();

  if (pErr) {
    console.error('[projects.status.load]', pErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const warnings: string[] = [];

  // ============================================================
  // resolveMove
  // ============================================================
  // The one place that decides what actually gets written, shared
  // by the variant and product paths so the hold bookkeeping
  // can't diverge between them. Takes the row's current state and
  // returns the pair of values to persist.
  //
  // Returns an error instead of throwing so callers can map it to
  // a 409 — "resume a job that isn't on hold" is a client mistake,
  // not a server fault.
  // ============================================================
  type Move =
    | { ok: true; status: ProjectStatus; holdPrev: ProjectStatus | null }
    | { ok: false; error: string };

  function resolveMove(
    current: ProjectStatus,
    heldFrom: ProjectStatus | null
  ): Move {
    if (resume) {
      if (current !== 'on_hold') {
        return {
          ok: false,
          error: 'This job is not on hold, so there is nothing to resume.',
        };
      }
      if (!heldFrom) {
        warnings.push(
          'There was no record of where this job paused, so it has been resumed at the start of the pipeline.'
        );
        return { ok: true, status: 'draft', holdPrev: null };
      }
      return { ok: true, status: heldFrom, holdPrev: null };
    }

    // Non-null: guarded at the top of the handler.
    const next = requestedStatus!;

    if (next === 'on_hold') {
      // Holding a row that's ALREADY held keeps the first origin.
      // Recording 'on_hold' as its own origin would make the
      // resume path a no-op loop, and the CHECK constraint
      // rejects it anyway.
      return {
        ok: true,
        status: 'on_hold',
        holdPrev: current === 'on_hold' ? heldFrom : current,
      };
    }

    // Any other explicit move (YTA / YTS) discards the origin —
    // once the row is somewhere real, where it used to be paused
    // describes nothing.
    return { ok: true, status: next, holdPrev: null };
  }

  // ----- Assignment -----
  // Done before the status write and shared by both paths below,
  // because a colourway targeted by variant_id still hangs off
  // the product's assignee. No-op when the job is already
  // unassigned, so re-picking YTA on a YTA row costs nothing.
  async function applyAssignmentClear(): Promise<boolean> {
    if (!clearAssignment || !project || project.assigned_to === null) {
      return true;
    }
    const { error } = await supabase()
      .from('uflow_projects')
      .update({ assigned_to: null, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      console.error('[projects.status.unassign]', error);
      return false;
    }
    return true;
  }

  // ============================================================
  // Variant path
  // ============================================================
  if (variantId) {
    const { data: variant, error: vErr } = await supabase()
      .from('uflow_project_variants')
      .select('id, project_id, name, status, hold_prev_status')
      .eq('id', variantId)
      .maybeSingle();

    if (vErr) {
      console.error('[projects.status.variant.load]', vErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
    // Scoped to the product in the URL — same guard the variant
    // DELETE route uses.
    if (!variant || variant.project_id !== id) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }

    const currentStatus = variant.status as ProjectStatus;
    const currentHeldFrom = asStatus(variant.hold_prev_status);

    const move = resolveMove(currentStatus, currentHeldFrom);
    if (!move.ok) {
      return NextResponse.json({ error: move.error }, { status: 409 });
    }

    // A change of assignment alone is a real change, and so is a
    // change to the recorded hold origin, so the early-out only
    // applies when none of the three would move.
    if (
      currentStatus === move.status &&
      currentHeldFrom === move.holdPrev &&
      (!clearAssignment || project.assigned_to === null)
    ) {
      return NextResponse.json({
        ok: true,
        unchanged: true,
        target: 'variant',
        variant_id: variantId,
        from: currentStatus,
        to: move.status,
        warnings,
      });
    }

    if (!(await applyAssignmentClear())) {
      return NextResponse.json(
        { error: 'DB error clearing the artist assignment.' },
        { status: 500 }
      );
    }

    const { error: uErr } = await supabase()
      .from('uflow_project_variants')
      .update({
        status: move.status,
        hold_prev_status: move.holdPrev,
        updated_at: new Date().toISOString(),
      })
      .eq('id', variantId)
      // Belt-and-braces: scope the write itself to the product as
      // well as the id, so a mismatched pair can never land.
      .eq('project_id', id);

    if (uErr) {
      console.error('[projects.status.variant.update]', uErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }

    // Only for a fresh approval by decree. A resume back into
    // 'approved' is restoring a sign-off that already published.
    if (move.status === 'approved' && !resume) {
      warnings.push(
        'Marked approved without publishing — no public viewer page was written for this colourway.'
      );
    }
    if (move.status === 'on_hold') {
      warnings.push(
        'Parked. This colourway has left every queue and will not appear in anyone’s work list until it is resumed.'
      );
    }

    return NextResponse.json({
      ok: true,
      target: 'variant',
      variant_id: variantId,
      from: currentStatus,
      to: move.status,
      held_from: move.holdPrev,
      unassigned: clearAssignment,
      warnings,
    });
  }

  // ============================================================
  // Product path
  // ============================================================
  const currentStatus = project.status as ProjectStatus;
  const currentHeldFrom = asStatus(project.hold_prev_status);

  const move = resolveMove(currentStatus, currentHeldFrom);
  if (!move.ok) {
    return NextResponse.json({ error: move.error }, { status: 409 });
  }

  if (
    currentStatus === move.status &&
    currentHeldFrom === move.holdPrev &&
    (!clearAssignment || project.assigned_to === null)
  ) {
    return NextResponse.json({
      ok: true,
      unchanged: true,
      target: 'project',
      from: currentStatus,
      to: move.status,
      warnings,
    });
  }

  // Includes going on hold: an approved job that's been parked
  // shouldn't stay listed in the public manifest either.
  const leavingApproved =
    currentStatus === 'approved' && move.status !== 'approved';

  if (!(await applyAssignmentClear())) {
    return NextResponse.json(
      { error: 'DB error clearing the artist assignment.' },
      { status: 500 }
    );
  }

  const { error: uErr } = await supabase()
    .from('uflow_projects')
    .update({
      status: move.status,
      hold_prev_status: move.holdPrev,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (uErr) {
    console.error('[projects.status.update]', uErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  // ----- Keep the public manifest honest -----
  // Best-effort and deliberately non-fatal: the status change has
  // already committed, and a stale manifest is a cosmetic problem
  // on the public viewer's sidebar that the next publish
  // corrects. Failing the request here would leave the caller
  // thinking nothing happened when the DB has already moved.
  if (leavingApproved || move.status === 'approved') {
    try {
      await refreshManifest();
    } catch (err) {
      console.warn('[projects.status.manifest]', err);
      warnings.push(
        "Status saved, but the public models manifest couldn't be refreshed."
      );
    }
  }

  if (leavingApproved) {
    warnings.push(
      'The published viewer page is still live in storage — only the manifest listing was updated.'
    );
  }
  if (move.status === 'approved' && !resume) {
    warnings.push(
      'Marked approved without publishing — no public viewer page was written. Use QA Review to publish properly.'
    );
  }
  if (move.status === 'on_hold') {
    warnings.push(
      'Parked. This job has left every queue and will not appear in anyone’s work list until it is resumed.'
    );
  }

  return NextResponse.json({
    ok: true,
    target: 'project',
    from: currentStatus,
    to: move.status,
    held_from: move.holdPrev,
    unassigned: clearAssignment,
    warnings,
  });
}
