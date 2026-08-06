import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { isOurPublicUrl } from '../../../../lib/r2';

export const runtime = 'nodejs';
export const maxDuration = 300;

// ============================================================
// POST /api/projects/:id/feedback
// Body (JSON):
//   { image_urls: string[],   // R2 public URLs from feedback-sign
//     note?: string }
//
// Decision rule:
//   - image_urls non-empty → REJECT (back to artist)
//   - image_urls empty     → APPROVE (forward to client for sign-off)
//
// REJECT path:
//   - status = 'iqa_rejected' (Internal QA rejection)
//   - one row per URL inserted into uflow_feedback_images,
//     tagged with current revision
//
// APPROVE path:
//   - status = 'client_review' (NOT 'approved' — two-stage approval)
//   - We do NOT copy the GLB to the approved/ folder yet. That
//     happens only when the client also approves (in the client-
//     review endpoint). Until then the public viewer must not
//     publish this model.
// ============================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  // ----- Load project (we no longer need the client slug here —
  // the GLB copy to the approved/ folder happens in the client-
  // review endpoint now). -----
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, glb_url'
    )
    .eq('id', id)
    .maybeSingle();

  if (pErr || !project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }

  // ----- Parse JSON body -----
  let body: { image_urls?: unknown; note?: unknown; variant_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const variantId =
    typeof body.variant_id === 'string' ? body.variant_id : null;

  // ----- Resolve the review target -----
  // Each colourway is approved or rejected on its own, so the
  // decision lands on the variant row. Without variant_id we fall
  // back to the product row (legacy single-model behaviour).
  type ReviewTarget = {
    table: 'uflow_projects' | 'uflow_project_variants';
    rowId: string;
    status: string;
    revisionCount: number;
    glbUrl: string | null;
    label: string;
  };
  let target: ReviewTarget = {
    table: 'uflow_projects',
    rowId: project.id,
    status: project.status,
    revisionCount: project.revision_count,
    glbUrl: project.glb_url,
    label: project.name,
  };

  if (variantId) {
    const { data: variant, error: vErr } = await supabase()
      .from('uflow_project_variants')
      .select('id, project_id, name, status, revision_count, glb_url')
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
    target = {
      table: 'uflow_project_variants',
      rowId: variant.id,
      status: variant.status,
      revisionCount: variant.revision_count,
      glbUrl: variant.glb_url,
      label: `${project.name} \u00b7 ${variant.name}`,
    };
  }

  // State + asset guards run against the TARGET, not the product.
  // A product may sit in any status while one of its colourways
  // is the thing actually under review.
  if (target.status !== 'qa_pending' && target.status !== 'eqa_rejected') {
    return NextResponse.json(
      {
        error: `"${target.label}" is "${target.status}" \u2014 only "qa_pending" or "eqa_rejected" can be reviewed by admin.`,
      },
      { status: 400 }
    );
  }
  if (!target.glbUrl) {
    return NextResponse.json(
      { error: `"${target.label}" has no GLB to review.` },
      { status: 400 }
    );
  }

  const rawUrls = Array.isArray(body.image_urls) ? body.image_urls : [];
  const note =
    typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

  // Validate every URL is from our R2 bucket so a malicious admin
  // client can't insert arbitrary external image references.
  const imageUrls: string[] = rawUrls
    .filter((u): u is string => typeof u === 'string')
    .filter((u) => isOurPublicUrl(u));

  // revision_count is the count of REJECTION rounds. We tag the
  // feedback rows with the POST-bump number so the rev number
  // means "this feedback drove the work that produced revision
  // N":
  //   rev_count was 0, rejection bumps to 1 → feedback tagged 1
  //   rev_count was 1, rejection bumps to 2 → feedback tagged 2
  // Symmetric with where the artist's NEXT upload will live
  // (uploads/rev-N/source.zip with revision_count=N).
  const nextRevisionCount = target.revisionCount + 1;

  // ============================================================
  // Branch A: REJECT
  // ============================================================
  if (imageUrls.length > 0) {
    const rows = imageUrls.map((url) => ({
      project_id: id,
      // Scope the screenshots to the colourway they describe, so
      // the artist opening Grey's feedback doesn't see Black's.
      variant_id: variantId,
      revision: nextRevisionCount,
      image_url: url,
      note,
      uploaded_by: auth.userId,
    }));
    const { error: fErr } = await supabase()
      .from('uflow_feedback_images')
      .insert(rows);
    if (fErr) {
      console.error('[feedback.reject] insert', fErr);
      return NextResponse.json(
        { error: `DB error inserting feedback rows: ${fErr.message}` },
        { status: 500 }
      );
    }

    const { error: uErr } = await supabase()
      .from(target.table)
      .update({
        status: 'iqa_rejected',
        // Advance the rejection counter. This is the ONLY path
        // that writes revision_count — uploads don't touch it.
        revision_count: nextRevisionCount,
        // A fresh rejection is unread by definition, so reset the
        // artist's marker. Without this, an artist who had read
        // round 1 would never see round 2 land in their inbox.
        feedback_seen_revision: target.revisionCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', target.rowId);
    if (uErr) {
      console.error('[feedback.reject] update', uErr);
      return NextResponse.json(
        { error: `DB error updating project: ${uErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      decision: 'iqa_rejected',
      variant_id: variantId,
      revision: nextRevisionCount,
      feedback_count: imageUrls.length,
    });
  }

  // ============================================================
  // Branch B: APPROVE → forward to client
  //
  // Two-stage approval: admin approval no longer finalises the
  // job. We move it to 'client_review' so the client can sign off
  // in /client/qa/[id]. The GLB copy to the approved/ folder is
  // deferred until that final approval (so the public viewer
  // doesn't accidentally publish unsigned-off models).
  // ============================================================
  const { error: uErr } = await supabase()
    .from(target.table)
    .update({
      status: 'client_review',
      updated_at: new Date().toISOString(),
    })
    .eq('id', target.rowId);
  if (uErr) {
    console.error('[feedback.approve] update', uErr);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    decision: 'client_review',
    variant_id: variantId,
  });
}

// ============================================================
// GET /api/projects/:id/feedback
// Returns all feedback images for the project, grouped by revision.
// Used by the artist dashboard so they can review what QA flagged.
// ============================================================
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { data, error } = await supabase()
    .from('uflow_feedback_images')
    .select('id, revision, image_url, note, created_at')
    .eq('project_id', id)
    .order('revision', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ feedback: data });
}
