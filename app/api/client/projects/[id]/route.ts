import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { isOurPublicUrl } from '../../../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// /api/client/projects/[id]
//
// Per-project operations available to the owning client brand.
//
// Mutability rule (enforced server-side on every write):
//   A client can ONLY edit/delete a project while it is still in
//   'draft' — i.e. before an admin has allocated it to an artist.
//   Once the pipeline has started (status ∈ wip, qa_pending,
//   iqa_rejected, client_review, eqa_rejected, approved, ...),
//   the project is locked from the client's perspective: an
//   artist may have already built against the spec, feedback
//   history depends on it, etc. The admin can still mutate via
//   their own endpoints; the client cannot.
//
// Every handler verifies BOTH ownership (project.client_id ===
// auth.clientId) AND state (status === 'draft') before touching
// the DB. The two checks are run together in the same select so
// a client trying to mutate someone else's job and a client
// trying to edit a started job both get the same 404 — no info
// leak about which other brands' jobs exist.
// ============================================================

type ProjectRow = {
  id: string;
  client_id: string;
  status: string;
  slug: string;
  name: string;
  brief: string | null;
};

async function loadOwnedDraft(
  projectId: string,
  clientId: string
): Promise<ProjectRow | null> {
  const { data } = await supabase()
    .from('uflow_projects')
    .select('id, client_id, status, slug, name, brief')
    .eq('id', projectId)
    .eq('client_id', clientId)
    .maybeSingle();
  return (data as ProjectRow | null) ?? null;
}

// ============================================================
// GET /api/client/projects/[id]
//
// Returns the project plus its current reference image rows so
// the edit form can prefill. Allowed for any status (read-only
// — useful for "view details" surfaces too), but the edit UI
// itself will only render the form when status === 'draft'.
// ============================================================
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('client');
  if (auth instanceof NextResponse) return auth;

  if (!auth.clientId) {
    return NextResponse.json(
      { error: 'Your account is not linked to a client brand. Contact an admin.' },
      { status: 403 }
    );
  }

  const { id } = await params;

  const { data: project, error } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, brief, created_at, updated_at, client_id, client:uflow_clients(slug, name)'
    )
    .eq('id', id)
    .eq('client_id', auth.clientId)
    .maybeSingle();

  if (error) {
    console.error('[client.project.get]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!project) {
    // 404 (not 403) so a client probing other brands' ids can't
    // tell which exist.
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const { data: refs } = await supabase()
    .from('uflow_project_references')
    .select('id, image_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  return NextResponse.json({
    project,
    references: refs ?? [],
  });
}

// ============================================================
// PATCH /api/client/projects/[id]
// Body: {
//   name?: string,
//   brief?: string | null,
//   add_reference_image_urls?: string[],   // new R2 urls (must
//                                          // be from our bucket)
//   remove_reference_ids?: string[],       // ids of existing
//                                          // uflow_project_references rows to drop
// }
//
// Updates the editable fields. Notably the slug is NOT editable
// once created — it's used as an R2 path prefix and would orphan
// any pre-signed upload URLs the client used during creation if
// changed mid-flight. (Slug changes are an admin-side concern,
// not exposed even there at the moment.)
//
// We don't run the same auto-suffix collision loop POST uses,
// because we're not changing the slug; only the human-facing
// `name` and `brief` are touched.
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('client');
  if (auth instanceof NextResponse) return auth;

  if (!auth.clientId) {
    return NextResponse.json(
      { error: 'Your account is not linked to a client brand. Contact an admin.' },
      { status: 403 }
    );
  }

  const { id } = await params;

  let body: {
    name?: unknown;
    brief?: unknown;
    add_reference_image_urls?: unknown;
    remove_reference_ids?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // ----- Ownership + draft-state gate -----
  const project = await loadOwnedDraft(id, auth.clientId);
  if (!project) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (project.status !== 'draft') {
    // Once an admin has allocated the job or any work has begun
    // we hard-stop edits. The dashboard hides the buttons too,
    // but a stale tab might still send this request — return a
    // helpful message rather than a generic 403.
    return NextResponse.json(
      {
        error:
          'This job has already been allocated to an artist and can no longer be edited. Contact your admin if changes are needed.',
      },
      { status: 409 }
    );
  }

  // ----- Build the field update patch -----
  const patch: { name?: string; brief?: string | null; updated_at: string } = {
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
    patch.name = trimmed;
  }

  if (body.brief !== undefined) {
    // Allow explicit null/empty string to clear the brief, mirroring
    // the POST shape (`brief?.trim() || null`).
    if (body.brief === null) {
      patch.brief = null;
    } else if (typeof body.brief === 'string') {
      patch.brief = body.brief.trim() || null;
    } else {
      return NextResponse.json(
        { error: 'brief must be a string or null.' },
        { status: 400 }
      );
    }
  }

  // ----- Apply the field update if anything changed -----
  // We always set updated_at, but if no fields beyond that came
  // through (caller only wanted to add/remove refs), skip the
  // round-trip — the references mutations below will still bump
  // updated_at separately via a final touch.
  const hasFieldChange = 'name' in patch || 'brief' in patch;
  if (hasFieldChange) {
    const { error: uErr } = await supabase()
      .from('uflow_projects')
      .update(patch)
      .eq('id', id)
      .eq('client_id', auth.clientId);
    if (uErr) {
      console.error('[client.project.patch.fields]', uErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
  }

  // ----- Remove reference rows -----
  // We scope the delete by project_id (in addition to id IN ...)
  // so a malicious payload can't drop reference rows on someone
  // else's project even if they guessed valid ids.
  const rawRemove = Array.isArray(body.remove_reference_ids)
    ? body.remove_reference_ids
    : [];
  const removeIds = rawRemove.filter((x): x is string => typeof x === 'string');
  if (removeIds.length > 0) {
    const { error: dErr } = await supabase()
      .from('uflow_project_references')
      .delete()
      .eq('project_id', id)
      .in('id', removeIds);
    if (dErr) {
      console.error('[client.project.patch.refs.remove]', dErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
  }

  // ----- Add reference rows -----
  // Same validation as POST: every URL must be from our R2 bucket
  // so the client can't pin arbitrary external images.
  const rawAdd = Array.isArray(body.add_reference_image_urls)
    ? body.add_reference_image_urls
    : [];
  const addUrls = rawAdd
    .filter((u): u is string => typeof u === 'string')
    .filter((u) => isOurPublicUrl(u));
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
      console.error('[client.project.patch.refs.add]', iErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
  }

  // ----- Re-fetch the canonical row to return -----
  // After a reference-only update (no name/brief change) we still
  // want the caller to see a fresh updated_at, so bump it now if
  // we skipped the field-patch round-trip.
  if (!hasFieldChange && (removeIds.length > 0 || addUrls.length > 0)) {
    await supabase()
      .from('uflow_projects')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('client_id', auth.clientId);
  }

  const { data: fresh } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, brief, created_at, updated_at'
    )
    .eq('id', id)
    .maybeSingle();

  return NextResponse.json({ project: fresh });
}

// ============================================================
// DELETE /api/client/projects/[id]
//
// Removes the project entirely. Allowed only while the project
// is still in 'draft' (same rule as PATCH). Related rows in
// uflow_project_references and uflow_feedback_images are removed
// automatically via ON DELETE CASCADE — see schema.sql.
//
// We do NOT clean up the corresponding R2 reference image objects
// here. Reasons:
//   1. R2 deletes need an additional round-trip per file and a
//      failure mid-loop would leave the DB in an inconsistent
//      state. The DB delete is the source of truth; orphaned R2
//      objects are harmless (they're under a per-project prefix
//      that's no longer referenced anywhere).
//   2. The bucket lifecycle / periodic sweep is the right place
//      to garbage-collect orphans, not the request hot-path.
// ============================================================
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('client');
  if (auth instanceof NextResponse) return auth;

  if (!auth.clientId) {
    return NextResponse.json(
      { error: 'Your account is not linked to a client brand. Contact an admin.' },
      { status: 403 }
    );
  }

  const { id } = await params;

  const project = await loadOwnedDraft(id, auth.clientId);
  if (!project) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (project.status !== 'draft') {
    return NextResponse.json(
      {
        error:
          'This job has already been allocated to an artist and can no longer be deleted. Contact your admin if it needs to be cancelled.',
      },
      { status: 409 }
    );
  }

  const { error } = await supabase()
    .from('uflow_projects')
    .delete()
    .eq('id', id)
    .eq('client_id', auth.clientId);

  if (error) {
    console.error('[client.project.delete]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
