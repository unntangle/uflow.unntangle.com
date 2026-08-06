import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// POST /api/projects/:id/start
//
// Transitions a project to a WIP state. This is the artist's
// "I've seen the brief / feedback, I'm working on it"
// acknowledgement. The exact target status depends on what the
// artist is acknowledging:
//
//   draft         + Start → wip       (fresh job)
//   iqa_rejected  + Start → iqa_wip   (responding to admin's feedback)
//   eqa_rejected  + Start → eqa_wip   (responding to client's feedback)
//
// The three WIP flavours behave identically downstream — all
// three upload back to qa_pending. The split exists so the
// admin's WIP tab can show context: a badge labelled "IQA WIP"
// tells the admin at a glance that this row is a revision of
// previously-rejected work, not a fresh draft.
//
// State machine reminder:
//   draft → wip → qa_pending
//   iqa_rejected → iqa_wip → qa_pending
//   eqa_rejected → eqa_wip → qa_pending
//
// Authorization:
//   - Caller must be a 3D artist
//   - Caller must be the ASSIGNED artist on this project
//   - Project must be in 'draft', 'iqa_rejected', or 'eqa_rejected'
// ============================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('3d_artist');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // Optional variant target. Omitted = the product row (legacy
  // single-model path), so existing callers are unaffected.
  let reqBody: { variant_id?: string } = {};
  try {
    reqBody = await req.json();
  } catch {
    // No body is fine.
  }
  const variantId = reqBody.variant_id;

  // ----- Variant path -----
  // Each colourway starts independently: acknowledging feedback
  // on Grey shouldn't drag Black out of its own queue.
  if (variantId) {
    const { data: variant, error: vErr } = await supabase()
      .from('uflow_project_variants')
      .select('id, project_id, status, assigned_to')
      .eq('id', variantId)
      .maybeSingle();

    if (vErr || !variant) {
      return NextResponse.json({ error: 'Variant not found.' }, { status: 404 });
    }
    if (variant.project_id !== id) {
      return NextResponse.json(
        { error: 'That variant belongs to a different project.' },
        { status: 400 }
      );
    }

    // Ownership: the artist may hold the variant directly, or the
    // product it belongs to.
    const { data: parent } = await supabase()
      .from('uflow_projects')
      .select('assigned_to')
      .eq('id', id)
      .maybeSingle();
    if (
      variant.assigned_to !== auth.userId &&
      parent?.assigned_to !== auth.userId
    ) {
      return NextResponse.json(
        { error: 'This variant is not assigned to you.' },
        { status: 403 }
      );
    }

    if (
      variant.status !== 'draft' &&
      variant.status !== 'iqa_rejected' &&
      variant.status !== 'eqa_rejected'
    ) {
      return NextResponse.json(
        {
          error: `Cannot start work \u2014 this variant is "${variant.status}".`,
        },
        { status: 400 }
      );
    }

    const vFrom = variant.status;
    const vNew =
      vFrom === 'iqa_rejected' ? 'iqa_wip' :
      vFrom === 'eqa_rejected' ? 'eqa_wip' :
      'wip';

    const { data: vUpdated, error: vuErr } = await supabase()
      .from('uflow_project_variants')
      .update({ status: vNew, updated_at: new Date().toISOString() })
      .eq('id', variantId)
      .eq('status', vFrom)
      .select()
      .single();

    if (vuErr || !vUpdated) {
      console.error('[projects.start.variant]', vuErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, variant: vUpdated });
  }

  // Verify ownership + state in one query, before the update,
  // so we can return a meaningful error code if either check fails.
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select('id, status, assigned_to')
    .eq('id', id)
    .maybeSingle();

  if (pErr || !project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  if (project.assigned_to !== auth.userId) {
    return NextResponse.json(
      { error: 'This project is not assigned to you.' },
      { status: 403 }
    );
  }
  if (
    project.status !== 'draft' &&
    project.status !== 'iqa_rejected' &&
    project.status !== 'eqa_rejected'
  ) {
    return NextResponse.json(
      {
        error: `Cannot start work \u2014 project is "${project.status}". Only "draft", "iqa_rejected", or "eqa_rejected" projects can be started.`,
      },
      { status: 400 }
    );
  }

  // Capture the starting state so the race guard below targets
  // the exact value we just read — prevents a draft → wip race
  // from accidentally undoing an iqa_rejected → iqa_wip transition.
  const fromStatus = project.status;

  // Branch the target status by source. The split lets the
  // admin's StatusBadge tell the difference between three
  // otherwise-identical "in progress" states. Downstream
  // (upload / qa) treats all three the same.
  const newStatus =
    fromStatus === 'iqa_rejected' ? 'iqa_wip' :
    fromStatus === 'eqa_rejected' ? 'eqa_wip' :
    'wip';

  const { data: updated, error: uErr } = await supabase()
    .from('uflow_projects')
    .update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    // Guard against a race: only transition if it's still in the
    // same state we read. If two artist clicks land at the same
    // time, only one wins.
    .eq('status', fromStatus)
    .select()
    .single();

  if (uErr || !updated) {
    console.error('[projects.start]', uErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, project: updated });
}
