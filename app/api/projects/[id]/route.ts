import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';

export const runtime = 'nodejs';

// ============================================================
// DELETE /api/projects/[id]
//
// Admin-only project delete.
//
// Constraints:
//   1. Caller must be admin (requireApiUser('admin')).
//   2. Project must be in 'draft' status. Anything past draft
//      (wip, qa_pending, …, approved) is part of an in-flight
//      pipeline that depends on the row existing — deleting it
//      would orphan feedback history, artist work, etc.
//   3. The project must have been CREATED BY AN ADMIN. Jobs
//      created by a client belong to that client's workflow and
//      are deleted from the client dashboard (with the client's
//      own ownership rules). An admin yanking a client's job
//      out from under them would be confusing and surprising.
//
// On success, ON DELETE CASCADE rules in schema.sql clean up
// uflow_project_references and uflow_feedback_images
// automatically. R2 objects are intentionally left in place —
// see the comment in /api/client/projects/[id]/route.ts for
// the reasoning.
//
// Note on error codes:
//   404 — project not found OR not owned (i.e. not created by
//         an admin). We collapse both into 404 so a probing
//         caller can't enumerate which jobs exist.
//   409 — project exists and is admin-created, but its status
//         is no longer 'draft' (someone else has progressed it
//         while the admin's dashboard was stale). We surface a
//         specific message so the UI can explain why the delete
//         failed.
// ============================================================
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // Load the project together with its creator's role. Joining
  // via the FK constraint name keeps the query precise — there
  // are two FKs from uflow_projects into uflow_users (created_by
  // and assigned_to), so Supabase needs the constraint hint to
  // know which one to follow.
  const { data, error } = await supabase()
    .from('uflow_projects')
    .select(
      'id, status, created_by, creator:uflow_users!uflow_projects_created_by_fkey(role)'
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[projects.delete.load]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  // Normalise the joined relation — Supabase may return it as
  // either {role:'admin'} or [{role:'admin'}] depending on the
  // cardinality hint it infers.
  const creator = Array.isArray(data?.creator)
    ? data.creator[0]
    : data?.creator;

  // Ownership gate. We treat "not found" and "not created by an
  // admin" identically (both return 404) so the response doesn't
  // leak whether a project id belongs to a client-created job
  // that admin can't touch.
  if (!data || creator?.role !== 'admin') {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // State gate. Once the pipeline has started, deletion would
  // leave dangling references in artist queues / feedback history.
  // The dashboard hides the Delete button outside draft already,
  // but a stale tab might still send the request — answer with a
  // specific message.
  if (data.status !== 'draft') {
    return NextResponse.json(
      {
        error:
          'This job has already moved past draft and can no longer be deleted. Reassign or let it finish the pipeline.',
      },
      { status: 409 }
    );
  }

  const { error: delErr } = await supabase()
    .from('uflow_projects')
    .delete()
    .eq('id', id);

  if (delErr) {
    console.error('[projects.delete]', delErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
