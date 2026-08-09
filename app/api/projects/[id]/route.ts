import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import { isOurPublicUrl } from '../../../lib/r2';
import {
  isJobComplexity,
  isJobCategory,
  type JobComplexity,
  type JobCategory,
} from '../../../lib/job-options';

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
// ============================================================
// PATCH /api/projects/[id]
//
// Admin-only project edit. Updates the human-readable `name`
// and the optional `brief`. Deliberately scoped to those two
// fields:
//
//   - `slug` is NEVER editable here. It's the R2 path prefix
//     (officemate/<slug>/...), the public viewer URL segment,
//     and half of the (client_id, slug) unique key. Changing it
//     would orphan every already-uploaded GLB/reference and
//     break the public link of an approved model. The form
//     shows slug as read-only for the same reason the client
//     edit form does.
//   - `status`, `assigned_to`, revision counts, and asset URLs
//     are owned by their respective workflow endpoints (assign,
//     start, upload, feedback, client-review). Renaming must not
//     be a backdoor into mutating pipeline state.
//
// Unlike the client edit flow (draft-only), an admin may rename
// a job at ANY status -- a label fix is harmless on an in-flight
// or approved job, and admins are the ones who notice typos once
// a job is already moving. There's no ownership gate beyond the
// admin role: admins manage all jobs regardless of who created
// them.
//
// Body (JSON), all fields optional but at least one required:
//   { name?: string, brief?: string | null }
//
// Returns the updated row's id + name on success.
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: {
    name?: unknown;
    brief?: unknown;
    complexity?: unknown;
    category?: unknown;
    add_reference_image_urls?: unknown;
    remove_reference_ids?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Build the update payload from only the recognised, present
  // fields. We validate `name` if supplied (non-empty after
  // trim); `brief` may be cleared to null.
  const update: {
    name?: string;
    brief?: string | null;
    complexity?: JobComplexity | null;
    category?: JobCategory | null;
    updated_at: string;
  } = {
    updated_at: new Date().toISOString(),
  };

  if (typeof body.name === 'string') {
    const trimmed = body.name.trim();
    if (!trimmed) {
      return NextResponse.json(
        { error: 'Name cannot be empty.' },
        { status: 400 }
      );
    }
    if (trimmed.length > 200) {
      return NextResponse.json(
        { error: 'Name is too long (200 character max).' },
        { status: 400 }
      );
    }
    update.name = trimmed;
  }

  if ('brief' in body) {
    if (body.brief === null) {
      update.brief = null;
    } else if (typeof body.brief === 'string') {
      const trimmed = body.brief.trim();
      update.brief = trimmed || null;
    } else {
      return NextResponse.json(
        { error: 'Brief must be a string or null.' },
        { status: 400 }
      );
    }
  }

  // Classification fields. Present-key semantics, same as brief:
  // omitting the key leaves the column alone, sending null (or an
  // empty string, which is what a blank <select> submits) clears
  // it back to unclassified. Anything outside the shared
  // vocabulary in lib/job-options is a 400 rather than a silent
  // clear — the DB CHECK would reject it anyway, and a 400 says
  // why. Editable at ANY status, like name and brief: these are
  // labels, not pipeline state.
  if ('complexity' in body) {
    const raw = body.complexity;
    if (raw === null || raw === '') {
      update.complexity = null;
    } else if (isJobComplexity(raw)) {
      update.complexity = raw;
    } else {
      return NextResponse.json(
        { error: 'Invalid complexity value.' },
        { status: 400 }
      );
    }
  }

  if ('category' in body) {
    const raw = body.category;
    if (raw === null || raw === '') {
      update.category = null;
    } else if (isJobCategory(raw)) {
      update.category = raw;
    } else {
      return NextResponse.json(
        { error: 'Invalid category value.' },
        { status: 400 }
      );
    }
  }

  // Reference image mutations. Admins own the job, so (unlike the
  // client edit, which is draft-only) references are editable at
  // ANY status here. Added URLs must be from our R2 bucket; the
  // removes are scoped by project_id so a stray id can't drop
  // another project's rows.
  const rawAdd = Array.isArray(body.add_reference_image_urls)
    ? body.add_reference_image_urls
    : [];
  const addUrls = rawAdd
    .filter((u): u is string => typeof u === 'string')
    .filter((u) => isOurPublicUrl(u));
  const rawRemove = Array.isArray(body.remove_reference_ids)
    ? body.remove_reference_ids
    : [];
  const removeIds = rawRemove.filter((x): x is string => typeof x === 'string');
  const hasRefChange = addUrls.length > 0 || removeIds.length > 0;

  // Nothing meaningful to change -> 400 so the caller knows the
  // request was a no-op rather than silently "succeeding".
  if (
    update.name === undefined &&
    !('brief' in update) &&
    !('complexity' in update) &&
    !('category' in update) &&
    !hasRefChange
  ) {
    return NextResponse.json(
      { error: 'Provide a name, brief, or reference change to update.' },
      { status: 400 }
    );
  }

  // Ensure the project exists before updating so we can return a
  // clean 404 rather than a silent zero-row update.
  const { data: existing, error: loadErr } = await supabase()
    .from('uflow_projects')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (loadErr) {
    console.error('[projects.patch.load]', loadErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const { data: updated, error: updErr } = await supabase()
    .from('uflow_projects')
    .update(update)
    .eq('id', id)
    .select('id, name, brief, complexity, category')
    .single();

  if (updErr) {
    console.error('[projects.patch]', updErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  // ----- Remove reference rows -----
  // Scoped by project_id in addition to id IN (...) so a payload
  // can't drop reference rows belonging to another project.
  if (removeIds.length > 0) {
    const { error: dErr } = await supabase()
      .from('uflow_project_references')
      .delete()
      .eq('project_id', id)
      .in('id', removeIds);
    if (dErr) {
      console.error('[projects.patch.refs.remove]', dErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
  }

  // ----- Add reference rows -----
  if (addUrls.length > 0) {
    const rows = addUrls.map((url) => ({
      project_id: id,
      image_url: url,
      uploaded_by: auth.userId,
    }));
    const { error: iErr } = await supabase()
      .from('uflow_project_references')
      .insert(rows);
    if (iErr) {
      console.error('[projects.patch.refs.add]', iErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, project: updated });
}

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
