import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { deleteByPrefix } from '../../../../lib/r2';
import { refreshManifest } from '../../../../lib/publish';

export const runtime = 'nodejs';
export const maxDuration = 300;

// ============================================================
// DELETE /api/projects/[id]/purge
//
// HARD delete — wipes a project from BOTH the database and R2,
// at ANY status. This is the destructive action behind the
// "Delete" button on the List Jobs pages (admin + client).
//
// Unlike the soft deletes in /api/projects/[id] (admin, draft-
// only, admin-created-only) and /api/client/projects/[id]
// (client, draft-only), this endpoint deletes regardless of
// status — including approved / publicly-published models. It
// is irreversible, so the UI gates it behind an explicit
// confirmation dialog.
//
// Auth:
//   - admin  : may purge ANY project.
//   - client : may purge ONLY their own brand's projects
//              (project.client_id === auth.clientId).
//   - 3d_artist / anything else : forbidden.
//
// Order of operations (R2 before DB, but R2 best-effort):
//   1. R2 purge — delete every object under the project's key
//      prefixes:
//        <clientSlug>/<slug>/   (uploads, feedback, refs, approved)
//        officemate/<slug>/     (the published public viewer)
//      For the OfficeMate brand these coincide; for other brands
//      the published copy still lives under officemate/, so we
//      purge both. R2 failures are logged + surfaced as a
//      warning but do NOT block the DB delete: an orphaned R2
//      object is harmless, a DB row pointing at deleted assets
//      is not.
//   2. DB delete — child rows first (client feedback, admin
//      feedback, references), then the project row. Explicit
//      child deletes make this correct whether or not every FK
//      has ON DELETE CASCADE. If a child delete fails we abort
//      BEFORE removing the project, so we never strand a row.
//   3. Manifest refresh — regenerate officemate/manifest.json so
//      a purged approved model leaves every viewer's sidebar.
// ============================================================
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  // Artists (and any non-admin/non-client role) never delete jobs.
  if (auth.role !== 'admin' && auth.role !== 'client') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;

  // Load the project + its client slug (needed to build the R2
  // working-asset prefix).
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select('id, slug, status, client_id, client:uflow_clients(slug)')
    .eq('id', id)
    .maybeSingle();

  if (pErr) {
    console.error('[projects.purge.load]', pErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // Client brand-scoping: a client may only purge their own
  // brand's jobs. We answer 404 (not 403) so a probing client
  // can't enumerate which other brands' ids exist.
  if (auth.role === 'client') {
    if (!auth.clientId || project.client_id !== auth.clientId) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
  }

  const clientRel = project.client as
    | { slug: string }
    | { slug: string }[]
    | null;
  const clientSlug = Array.isArray(clientRel)
    ? clientRel[0]?.slug
    : clientRel?.slug;

  // ---- 1. R2 purge (best-effort) ----
  // Dedupe the prefix set so the OfficeMate case (where the
  // working-asset prefix and the published prefix are identical)
  // doesn't list/delete the same keys twice.
  const r2Warnings: string[] = [];
  const prefixes = new Set<string>();
  if (clientSlug && project.slug) {
    prefixes.add(`${clientSlug}/${project.slug}/`);
  }
  if (project.slug) {
    prefixes.add(`officemate/${project.slug}/`);
  }
  for (const prefix of prefixes) {
    try {
      await deleteByPrefix(prefix);
    } catch (err) {
      console.error('[projects.purge.r2]', prefix, err);
      r2Warnings.push(prefix);
    }
  }

  // ---- 2. DB delete (children first, then the project) ----
  const childDeletes = await Promise.all([
    supabase()
      .from('uflow_client_feedback_images')
      .delete()
      .eq('project_id', id),
    supabase().from('uflow_feedback_images').delete().eq('project_id', id),
    supabase().from('uflow_project_references').delete().eq('project_id', id),
  ]);
  for (const res of childDeletes) {
    if (res.error) {
      console.error('[projects.purge.children]', res.error);
      return NextResponse.json(
        { error: `DB error clearing related rows: ${res.error.message}` },
        { status: 500 }
      );
    }
  }

  const { error: delErr } = await supabase()
    .from('uflow_projects')
    .delete()
    .eq('id', id);
  if (delErr) {
    console.error('[projects.purge.delete]', delErr);
    return NextResponse.json(
      { error: `DB error deleting project: ${delErr.message}` },
      { status: 500 }
    );
  }

  // ---- 3. Refresh the public manifest (best-effort) ----
  // If the purged project was approved/published it appeared in
  // the sidebar manifest; regenerate so it drops out. Non-fatal:
  // the row is already gone either way.
  try {
    await refreshManifest();
  } catch (err) {
    console.warn('[projects.purge.manifest]', err);
  }

  return NextResponse.json({
    ok: true,
    purged: id,
    // Prefixes whose R2 cleanup failed (if any). The job is gone
    // from the app regardless; this is just so the caller can log
    // that some storage objects may need a manual sweep.
    r2_warnings: r2Warnings,
  });
}
