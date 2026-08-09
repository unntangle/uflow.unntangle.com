import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../../lib/auth';
import { supabase } from '../../../../../lib/supabase';
import { deleteByPrefix } from '../../../../../lib/r2';
import { refreshManifest } from '../../../../../lib/publish';

export const runtime = 'nodejs';
export const maxDuration = 300;

// ============================================================
// DELETE /api/projects/:id/variants/:variantId
//
// Removes ONE colourway from a product. Admin-only, and
// irreversible — it takes the variant's uploaded zip/GLB out of
// R2 along with every feedback screenshot attached to it.
//
// Why the primary variant can't be deleted
// ----------------------------------------
// The 2026-08-06 variants migration made uflow_project_variants
// the authoritative holder of per-model state, and every product
// carries exactly one primary row standing for the original
// colourway. The parent row on every dashboard badges that
// primary's status. Deleting it would leave a product whose
// status resolves to nothing and whose QA switcher opens on an
// empty list. Deleting the ORIGINAL means deleting the job, so
// this endpoint answers 409 and points the caller at the job
// Delete button on List Jobs instead. (The migration says as
// much: "Deleting it is blocked in app code, not here.")
//
// Order of operations mirrors the project purge route: R2 first
// and best-effort, then the DB. An orphaned R2 object is
// harmless; a DB row pointing at deleted assets is not.
//
// Status is deliberately NOT a gate. An admin removing a
// colourway that was added by mistake shouldn't have to wait for
// it to finish the pipeline, and unlike the job-level soft
// delete there's no cross-team history to strand — a variant's
// feedback belongs to that variant alone.
// ============================================================
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id, variantId } = await params;

  // ---- Load the parent product (for the R2 key prefix) ----
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select('id, slug, client:uflow_clients(slug)')
    .eq('id', id)
    .maybeSingle();

  if (pErr) {
    console.error('[variants.delete.project]', pErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // ---- Load the variant ----
  const { data: variant, error: vErr } = await supabase()
    .from('uflow_project_variants')
    .select('id, project_id, name, slug, is_primary')
    .eq('id', variantId)
    .maybeSingle();

  if (vErr) {
    console.error('[variants.delete.load]', vErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  // Scope the variant to the product in the URL so a stray id
  // from another job can't be deleted through this path.
  if (!variant || variant.project_id !== id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  if (variant.is_primary) {
    return NextResponse.json(
      {
        error:
          'The original colourway cannot be removed on its own — it IS the product. Delete the whole job from List Jobs instead.',
      },
      { status: 409 }
    );
  }

  // ---- 1. R2 purge (best-effort) ----
  // Non-primary variants namespace their assets under
  // <projectSlug>-<variantSlug>, per the upload-sign route. The
  // primary keeps the bare project slug, which is exactly why
  // this route refuses primaries — deleting that prefix would
  // take the product's own published model with it.
  const clientRel = project.client as
    | { slug: string }
    | { slug: string }[]
    | null;
  const clientSlug = Array.isArray(clientRel)
    ? clientRel[0]?.slug
    : clientRel?.slug;

  const assetSlug = `${project.slug}-${variant.slug}`;
  const r2Warnings: string[] = [];
  const prefixes = new Set<string>();
  if (clientSlug) prefixes.add(`${clientSlug}/${assetSlug}/`);
  // Published copies always live under officemate/, whatever the
  // brand — same reasoning as the project purge route.
  prefixes.add(`officemate/${assetSlug}/`);

  for (const prefix of prefixes) {
    try {
      await deleteByPrefix(prefix);
    } catch (err) {
      console.error('[variants.delete.r2]', prefix, err);
      r2Warnings.push(prefix);
    }
  }

  // ---- 2. DB delete (children first, then the variant) ----
  // uflow_feedback_images.variant_id and its client-side twin
  // both cascade per the migration, but we clear them explicitly
  // so this stays correct if a future migration relaxes the FK.
  const childDeletes = await Promise.all([
    supabase()
      .from('uflow_feedback_images')
      .delete()
      .eq('variant_id', variantId),
    supabase()
      .from('uflow_client_feedback_images')
      .delete()
      .eq('variant_id', variantId),
  ]);
  for (const res of childDeletes) {
    if (res.error) {
      console.error('[variants.delete.children]', res.error);
      return NextResponse.json(
        { error: `DB error clearing related rows: ${res.error.message}` },
        { status: 500 }
      );
    }
  }

  const { error: delErr } = await supabase()
    .from('uflow_project_variants')
    .delete()
    .eq('id', variantId)
    // Belt-and-braces: scope the delete itself to the product as
    // well as the id, so a mismatched pair can never land.
    .eq('project_id', id);

  if (delErr) {
    console.error('[variants.delete]', delErr);
    return NextResponse.json(
      { error: `DB error deleting variant: ${delErr.message}` },
      { status: 500 }
    );
  }

  // ---- 3. Refresh the public manifest (best-effort) ----
  // Only matters if this colourway had been approved and
  // published; regenerating drops it out of every viewer's
  // sidebar. Non-fatal either way — the row is already gone.
  try {
    await refreshManifest();
  } catch (err) {
    console.warn('[variants.delete.manifest]', err);
  }

  return NextResponse.json({
    ok: true,
    deleted: variantId,
    r2_warnings: r2Warnings,
  });
}
