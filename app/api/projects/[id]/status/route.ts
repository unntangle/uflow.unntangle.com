import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
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
//     status: ProjectStatus,
//     variant_id?: string | null,
//     clear_assignment?: boolean
//   }
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
// Only `status` and `updated_at` change. Deliberately untouched:
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
// Moving a product row OUT of 'approved' DOES refresh the public
// manifest, because writeManifest() selects on
// uflow_projects.status = 'approved' — leaving it stale would
// keep an unapproved model listed in every public viewer's
// sidebar. Both of these come back as `warnings` so the UI can
// surface them instead of silently succeeding.
// ============================================================

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: {
    status?: unknown;
    variant_id?: unknown;
    clear_assignment?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const status = body.status;
  if (!isProjectStatus(status)) {
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
    .select('id, name, slug, status, assigned_to')
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
      .select('id, project_id, name, status')
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

    // A change of assignment alone is a real change, so the
    // early-out only applies when neither would move.
    if (
      variant.status === status &&
      (!clearAssignment || project.assigned_to === null)
    ) {
      return NextResponse.json({
        ok: true,
        unchanged: true,
        target: 'variant',
        variant_id: variantId,
        from: variant.status,
        to: status,
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
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', variantId)
      // Belt-and-braces: scope the write itself to the product as
      // well as the id, so a mismatched pair can never land.
      .eq('project_id', id);

    if (uErr) {
      console.error('[projects.status.variant.update]', uErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }

    if (status === 'approved') {
      warnings.push(
        'Marked approved without publishing — no public viewer page was written for this colourway.'
      );
    }

    return NextResponse.json({
      ok: true,
      target: 'variant',
      variant_id: variantId,
      from: variant.status,
      to: status,
      unassigned: clearAssignment,
      warnings,
    });
  }

  // ============================================================
  // Product path
  // ============================================================
  if (
    project.status === status &&
    (!clearAssignment || project.assigned_to === null)
  ) {
    return NextResponse.json({
      ok: true,
      unchanged: true,
      target: 'project',
      from: project.status,
      to: status,
      warnings,
    });
  }

  const leavingApproved =
    project.status === 'approved' && status !== 'approved';

  if (!(await applyAssignmentClear())) {
    return NextResponse.json(
      { error: 'DB error clearing the artist assignment.' },
      { status: 500 }
    );
  }

  const { error: uErr } = await supabase()
    .from('uflow_projects')
    .update({ status, updated_at: new Date().toISOString() })
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
  if (leavingApproved || status === 'approved') {
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
  if (status === 'approved') {
    warnings.push(
      'Marked approved without publishing — no public viewer page was written. Use QA Review to publish properly.'
    );
  }

  return NextResponse.json({
    ok: true,
    target: 'project',
    from: project.status,
    to: status,
    unassigned: clearAssignment,
    warnings,
  });
}
