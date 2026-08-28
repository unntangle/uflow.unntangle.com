import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// PATCH /api/projects/[id]/type
//
// Admin-only. Moves a job between the two positions in the
// hierarchy introduced by
// migrations/2026-08-28_add_parent_child_models.sql:
//
//   { model_type: 'parent' }
//     → standalone. Any existing parent_id is cleared.
//
//   { model_type: 'child', parent_id: '<uuid>' }
//     → derived from another job.
//
// Deliberately its own endpoint rather than more fields on
// PATCH /api/projects/[id]. That handler is the "rename and
// relabel" surface — name, brief, complexity, category, refs —
// and its contract is that nothing it touches changes how a job
// relates to anything else. Re-parenting is a structural move
// with its own rules, so it sits next to /assign and /status,
// which are separate routes for the same reason.
//
// This does NOT touch status, assignee, or any asset URL. A
// child is a full job in its own right; where it sits in the
// hierarchy says nothing about how far along it is.
//
// Every rejected move returns 400 with a specific message, so
// the table can explain the refusal inline on the row.
// ============================================================

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: { model_type?: unknown; parent_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Unlike the create path — where an unrecognised value safely
  // defaults to 'parent' — an explicit edit we can't read is a
  // caller bug. Rejecting beats silently flattening a hierarchy.
  if (body.model_type !== 'parent' && body.model_type !== 'child') {
    return NextResponse.json(
      { error: "model_type must be 'parent' or 'child'." },
      { status: 400 }
    );
  }
  const modelType: 'parent' | 'child' = body.model_type;

  let parentId: string | null = null;
  if (modelType === 'child') {
    const raw =
      typeof body.parent_id === 'string' ? body.parent_id.trim() : '';
    if (!raw) {
      return NextResponse.json(
        { error: 'A child model must name its parent.' },
        { status: 400 }
      );
    }
    if (raw === id) {
      return NextResponse.json(
        { error: 'A job cannot be its own parent.' },
        { status: 400 }
      );
    }
    parentId = raw;
  }

  // ----- The job being changed -----
  const { data: target, error: tErr } = await supabase()
    .from('uflow_projects')
    .select('id, name, model_type, parent_id')
    .eq('id', id)
    .maybeSingle();

  if (tErr) {
    // PostgREST errors aren't real Errors and their properties
    // don't survive being logged as one object, so they're pulled
    // out by hand. 42703 is undefined_column, which on this route
    // has exactly one likely cause — so name it rather than
    // returning a bare 500 the admin can't act on.
    console.error('[projects.type.load]', {
      code: tErr.code,
      message: tErr.message,
      details: tErr.details,
    });
    if (tErr.code === '42703') {
      return NextResponse.json(
        {
          error:
            'The parent/child columns are missing. Run app/migrations/2026-08-28_add_parent_child_models.sql against the database.',
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!target) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // ----- Would this create grandchildren? -----
  // Only a concern when demoting a parent that already has
  // children of its own. The names go in the error because the
  // fix is to re-parent those specific rows, and "it has
  // children" wouldn't tell the admin which.
  if (modelType === 'child') {
    const { data: kids, error: kErr } = await supabase()
      .from('uflow_projects')
      .select('id, name')
      .eq('parent_id', id)
      .limit(6);
    if (kErr) {
      console.error('[projects.type.children]', kErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
    if (kids && kids.length > 0) {
      const names = kids
        .slice(0, 3)
        .map((k) => k.name)
        .join(', ');
      const more = kids.length > 3 ? `, +${kids.length - 3} more` : '';
      return NextResponse.json(
        {
          error: `"${target.name}" is the parent of ${names}${more}. Move those onto another parent first.`,
        },
        { status: 400 }
      );
    }
  }

  // ----- The proposed parent -----
  // Same two rules as the create path: it has to exist, and it
  // can't itself be a child. No same-client rule — lineage may
  // legitimately cross brands.
  if (parentId) {
    const { data: parent, error: pErr } = await supabase()
      .from('uflow_projects')
      .select('id, name, model_type')
      .eq('id', parentId)
      .maybeSingle();
    if (pErr) {
      console.error('[projects.type.parent]', pErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
    if (!parent) {
      return NextResponse.json(
        { error: 'Parent model not found.' },
        { status: 400 }
      );
    }
    if (parent.model_type === 'child') {
      return NextResponse.json(
        {
          error: `"${parent.name}" is itself a child model. Pick a parent instead.`,
        },
        { status: 400 }
      );
    }
  }

  // ----- Write -----
  // parent_id is always set explicitly, including to null on the
  // way back to 'parent'. Leaving a stale id behind would trip
  // the uflow_projects_parent_shape_check constraint.
  const { data: updated, error: uErr } = await supabase()
    .from('uflow_projects')
    .update({
      model_type: modelType,
      parent_id: parentId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, name, model_type, parent_id')
    .single();

  if (uErr || !updated) {
    console.error('[projects.type.update]', uErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, project: updated });
}
