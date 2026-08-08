import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { isOurPublicUrl } from '../../../../lib/r2';

export const runtime = 'nodejs';
export const maxDuration = 300;

// ============================================================
// POST /api/projects/:id/feedback
// Body (JSON), preferred PER-VARIANT form:
//   { decisions: [
//       { variant_id: string,
//         image_urls: string[],   // R2 public URLs from feedback-sign
//         note?: string }, ... ] }
//
// Legacy form (still accepted — applies ONE outcome to every
// colourway named, and is what the pre-variant client sent):
//   { image_urls: string[], note?: string, variant_ids?: string[] }
//
// Decision rule, evaluated INDEPENDENTLY for each colourway:
//   - image_urls non-empty → REJECT (back to artist)
//   - image_urls empty     → APPROVE (forward to client for sign-off)
//
// Each colourway is its own model with its own faults, so each
// carries its own screenshots, its own note and its own outcome.
// Original can go to the client while Black goes back to the
// artist in the same submission — the product row is a roll-up of
// the variants (see lib/variant-status.ts), so the dashboards
// resolve that mix on their own.
//
// All-or-nothing validation: every named colourway is checked for
// a reviewable status and an uploaded GLB BEFORE anything is
// written, so a bad id can't leave half the product moved.
//
// REJECT path (per colourway):
//   - status = 'iqa_rejected' (Internal QA rejection)
//   - one row per URL inserted into uflow_feedback_images, TAGGED
//     WITH THAT VARIANT'S id and its own post-bump revision, so
//     the artist can tell which colourway each screenshot marks up
//
// APPROVE path (per colourway):
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
  let body: {
    image_urls?: unknown;
    note?: unknown;
    variant_id?: unknown;
    variant_ids?: unknown;
    decisions?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Validate every URL is from our R2 bucket so a malicious admin
  // client can't insert arbitrary external image references.
  const cleanUrls = (raw: unknown): string[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((u): u is string => typeof u === 'string')
      .filter((u) => isOurPublicUrl(u));
  const cleanNote = (raw: unknown): string | null =>
    typeof raw === 'string' && raw.trim() ? raw.trim() : null;

  // ----- Normalise the request into PER-COLOURWAY decisions -----
  // variantId === null means the product row itself, i.e. the
  // legacy single-model path.
  type Decision = {
    variantId: string | null;
    imageUrls: string[];
    note: string | null;
  };
  let decisions: Decision[] = [];

  if (Array.isArray(body.decisions)) {
    for (const raw of body.decisions) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      decisions.push({
        variantId: typeof d.variant_id === 'string' ? d.variant_id : null,
        imageUrls: cleanUrls(d.image_urls),
        note: cleanNote(d.note),
      });
    }
    if (decisions.length === 0) {
      return NextResponse.json(
        { error: 'No colourways were included in this submission.' },
        { status: 400 }
      );
    }
    // Two decisions for the same row would race each other on the
    // status write and double-bump the revision counter.
    const seen = new Set<string>();
    for (const d of decisions) {
      const key = d.variantId ?? '__project';
      if (seen.has(key)) {
        return NextResponse.json(
          { error: 'The same colourway appears twice in this submission.' },
          { status: 400 }
        );
      }
      seen.add(key);
    }
  } else {
    // Legacy shape: one common set of screenshots and one outcome,
    // fanned out across every colourway named.
    const legacyIds: string[] = Array.isArray(body.variant_ids)
      ? body.variant_ids.filter((v): v is string => typeof v === 'string')
      : typeof body.variant_id === 'string'
        ? [body.variant_id]
        : [];
    const imageUrls = cleanUrls(body.image_urls);
    const note = cleanNote(body.note);
    decisions =
      legacyIds.length > 0
        ? legacyIds.map((v) => ({ variantId: v, imageUrls, note }))
        : [{ variantId: null, imageUrls, note }];
  }

  // ----- Resolve the review targets -----
  type ReviewTarget = Decision & {
    table: 'uflow_projects' | 'uflow_project_variants';
    rowId: string;
    status: string;
    revisionCount: number;
    glbUrl: string | null;
    label: string;
  };

  const variantIds = decisions
    .map((d) => d.variantId)
    .filter((v): v is string => typeof v === 'string');

  type VariantRow = {
    id: string;
    project_id: string;
    name: string;
    status: string;
    revision_count: number;
    glb_url: string | null;
  };
  const variantById = new Map<string, VariantRow>();

  if (variantIds.length > 0) {
    const { data: rows, error: vErr } = await supabase()
      .from('uflow_project_variants')
      .select('id, project_id, name, status, revision_count, glb_url')
      .in('id', variantIds);
    if (vErr) {
      console.error('[feedback] variant lookup', vErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
    if (!rows || rows.length !== variantIds.length) {
      return NextResponse.json(
        { error: 'One or more variants were not found.' },
        { status: 404 }
      );
    }
    // Every id must belong to THIS product — otherwise a crafted
    // request could move another product's colourway.
    const stray = rows.find((v) => v.project_id !== id);
    if (stray) {
      return NextResponse.json(
        { error: 'That variant belongs to a different project.' },
        { status: 400 }
      );
    }
    for (const v of rows as unknown as VariantRow[]) {
      variantById.set(v.id, v);
    }
  }

  const targets: ReviewTarget[] = decisions.map((d) => {
    if (d.variantId === null) {
      return {
        ...d,
        table: 'uflow_projects' as const,
        rowId: project.id,
        status: project.status,
        revisionCount: project.revision_count,
        glbUrl: project.glb_url,
        label: project.name,
      };
    }
    const v = variantById.get(d.variantId)!;
    return {
      ...d,
      table: 'uflow_project_variants' as const,
      rowId: v.id,
      status: v.status,
      revisionCount: v.revision_count,
      glbUrl: v.glb_url,
      label: `${project.name} \u00b7 ${v.name}`,
    };
  });

  // State + asset guards run against every TARGET, not the
  // product. A product may sit in any status while its colourways
  // are the things actually under review. All-or-nothing: a
  // partially applied decision would leave the product in a state
  // nobody asked for.
  for (const t of targets) {
    if (t.status !== 'qa_pending' && t.status !== 'eqa_rejected') {
      return NextResponse.json(
        {
          error: `"${t.label}" is "${t.status}" \u2014 only "qa_pending" or "eqa_rejected" can be reviewed by admin.`,
        },
        { status: 400 }
      );
    }
    if (!t.glbUrl) {
      return NextResponse.json(
        { error: `"${t.label}" has no GLB to review.` },
        { status: 400 }
      );
    }
  }

  // ============================================================
  // Apply each colourway's own outcome.
  //
  // revision_count is the count of REJECTION rounds. Feedback rows
  // are tagged with the POST-bump number so the rev number means
  // "this feedback drove the work that produced revision N":
  //   rev_count was 0, rejection bumps to 1 → feedback tagged 1
  //   rev_count was 1, rejection bumps to 2 → feedback tagged 2
  // Symmetric with where the artist's NEXT upload will live
  // (uploads/rev-N/source.zip with revision_count=N).
  //
  // Each colourway carries its OWN counter, so a Black sitting at
  // 0 is tagged revision 1 even while Grey's feedback in the same
  // submission is tagged 11.
  // ============================================================
  const rejected: { id: string; label: string; revision: number }[] = [];
  const approved: { id: string; label: string }[] = [];

  for (const t of targets) {
    // ---------- REJECT ----------
    if (t.imageUrls.length > 0) {
      const revision = t.revisionCount + 1;
      const rows = t.imageUrls.map((url) => ({
        project_id: id,
        // Tagged to the colourway it marks up. The gallery groups
        // on this so the artist sees "Black · revision 3" rather
        // than one undifferentiated pile.
        variant_id: t.table === 'uflow_project_variants' ? t.rowId : null,
        revision,
        image_url: url,
        note: t.note,
        uploaded_by: auth.userId,
      }));
      const { error: fErr } = await supabase()
        .from('uflow_feedback_images')
        .insert(rows);
      if (fErr) {
        console.error('[feedback.reject] insert', fErr);
        return NextResponse.json(
          {
            error: `DB error inserting feedback rows for "${t.label}": ${fErr.message}`,
          },
          { status: 500 }
        );
      }

      const { error: uErr } = await supabase()
        .from(t.table)
        .update({
          status: 'iqa_rejected',
          // Advance the rejection counter. This is the ONLY path
          // that writes revision_count — uploads don't touch it.
          revision_count: revision,
          // A fresh rejection is unread by definition, so reset the
          // artist's marker. Without this, an artist who had read
          // round 1 would never see round 2 land in their inbox.
          feedback_seen_revision: t.revisionCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', t.rowId);
      if (uErr) {
        console.error('[feedback.reject] update', uErr);
        return NextResponse.json(
          { error: `DB error updating "${t.label}": ${uErr.message}` },
          { status: 500 }
        );
      }
      rejected.push({ id: t.rowId, label: t.label, revision });
      continue;
    }

    // ---------- APPROVE → forward to client ----------
    // Two-stage approval: admin approval doesn't finalise the job.
    // It moves to 'client_review' so the client can sign off in
    // /client/qa/[id]. The GLB copy to the approved/ folder is
    // deferred until that final approval, so the public viewer
    // can't publish an unsigned-off model.
    const { error: uErr } = await supabase()
      .from(t.table)
      .update({
        status: 'client_review',
        updated_at: new Date().toISOString(),
      })
      .eq('id', t.rowId);
    if (uErr) {
      console.error('[feedback.approve] update', uErr);
      return NextResponse.json(
        { error: `DB error updating "${t.label}": ${uErr.message}` },
        { status: 500 }
      );
    }
    approved.push({ id: t.rowId, label: t.label });
  }

  return NextResponse.json({
    ok: true,
    // 'mixed' when the submission split both ways — callers that
    // only look at a single decision string still get something
    // truthful rather than a silently wrong one.
    decision:
      rejected.length && approved.length
        ? 'mixed'
        : rejected.length
          ? 'iqa_rejected'
          : 'client_review',
    rejected,
    approved,
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
