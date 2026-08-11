import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import {
  uploadBuffer,
  fetchFromUrl,
  approvedKey,
  isOurPublicUrl,
} from '../../../../lib/r2';
import { publishGlbToPublicFolder } from '../../../../lib/publish';

export const runtime = 'nodejs';
export const maxDuration = 300;

// ============================================================
// POST /api/projects/:id/client-review
//
// Body (JSON), preferred PER-COLOURWAY form:
//   { decisions: [
//       { variant_id: string,
//         image_urls: string[],   // R2 URLs from client-feedback-sign
//         note?: string }, ... ] }
//
// Legacy form (still accepted — what the pre-variant client sent):
//   { image_urls: string[], note?: string }
//
// Decision rule, evaluated INDEPENDENTLY for each colourway,
// mirroring the admin /feedback endpoint:
//   - image_urls non-empty → REJECT (back to admin's queue)
//   - image_urls empty     → APPROVE (final — model goes public)
//
// Each colourway is its own model with its own faults, so each
// carries its own screenshots and its own outcome. Grey can be
// signed off while Black goes back in the same submission; the
// dashboards resolve the mix via lib/variant-status.ts.
//
// WHY THIS IS COLOURWAY-AWARE
// Since the 2026-08-06 variants migration, uflow_projects.status
// is only written on the legacy single-model path. Admin's IQA
// approval writes 'client_review' onto the VARIANT row, so the
// old guard here (project.status !== 'client_review' → 400)
// rejected every submission for exactly the jobs the client had
// just been asked to sign off on.
//
// Auth: 'client' role only, and the project must belong to the
// caller's own brand (auth.clientId). A client can NEVER act on
// another brand's project, whatever they post.
//
// All-or-nothing validation: every named colourway is checked
// for 'client_review' status and an uploaded GLB BEFORE anything
// is written, so a bad id can't leave half the product moved.
//
// REJECT path (per colourway):
//   - status = 'eqa_rejected' (External QA rejection)
//   - revision_count bumped on THAT colourway's own counter
//   - one row per URL into uflow_client_feedback_images, TAGGED
//     WITH THAT COLOURWAY'S id and its post-bump revision
//   - admin picks it up in their EQA Rejected queue
//
// APPROVE path (per colourway):
//   - Copy the GLB to <client>/<assetSlug>/approved/<assetSlug>.glb
//     as the durable archive, then publish the viewer folder
//   - status = 'approved', approved_glb_url = public viewer URL
//
//   assetSlug is the product slug for the primary colourway and
//   `<projectSlug>-<variantSlug>` for the rest — the same
//   namespacing upload-sign writes and the variant DELETE route
//   purges, so an approved Black can't overwrite the original's
//   published model.
// ============================================================

// Displayed in error messages. The primary colourway's stored
// name is a backfill artefact ('Original'), and the primary IS
// the product, so it reads as the product's own name — same rule
// the QA pages and the full-screen viewer apply.
function labelFor(projectName: string, variantName: string | null): string {
  return variantName ? `${projectName} \u00b7 ${variantName}` : projectName;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser('client');
  if (auth instanceof NextResponse) return auth;

  if (!auth.clientId) {
    return NextResponse.json(
      { error: 'Your account is not linked to a client brand.' },
      { status: 403 }
    );
  }

  const { id } = await params;

  // ----- Load project + client slug -----
  const { data: project, error: pErr } = await supabase()
    .from('uflow_projects')
    .select(
      'id, slug, name, status, revision_count, glb_url, client_id, client:uflow_clients(slug)'
    )
    .eq('id', id)
    .maybeSingle();

  if (pErr || !project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }

  // ----- Brand scoping check -----
  // A client can only act on projects belonging to their own
  // brand. We compare the trusted JWT clientId against the
  // project's client_id; never trust anything from the body.
  // Checked BEFORE any state guard so we don't leak whether
  // another brand's job happens to be awaiting review.
  if (project.client_id !== auth.clientId) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const clientRel = project.client as
    | { slug: string }
    | { slug: string }[]
    | null;
  const cSlug = Array.isArray(clientRel) ? clientRel[0]?.slug : clientRel?.slug;
  if (!cSlug) {
    return NextResponse.json(
      { error: 'Project has no client.' },
      { status: 500 }
    );
  }

  // ----- Parse JSON body -----
  let body: {
    image_urls?: unknown;
    note?: unknown;
    variant_id?: unknown;
    decisions?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Every URL must be from our R2 bucket so a client can't pin
  // arbitrary external images as "feedback".
  const cleanUrls = (raw: unknown): string[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((u): u is string => typeof u === 'string')
      .filter((u) => isOurPublicUrl(u));

  type Decision = { variantId: string | null; imageUrls: string[] };
  let decisions: Decision[] = [];

  if (Array.isArray(body.decisions)) {
    for (const raw of body.decisions) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      decisions.push({
        variantId: typeof d.variant_id === 'string' ? d.variant_id : null,
        imageUrls: cleanUrls(d.image_urls),
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
    // ----- Legacy shape -----
    // One flat verdict with no colourway named. Applying it to the
    // product row would hit the stale-status wall on any variant
    // job, so we fan it out across everything actually awaiting
    // this client's decision. Falls through to the product row
    // only when there are no colourways at all (pre-migration).
    const imageUrls = cleanUrls(body.image_urls);
    const explicit =
      typeof body.variant_id === 'string' ? body.variant_id : null;

    if (explicit) {
      decisions = [{ variantId: explicit, imageUrls }];
    } else {
      const { data: awaiting, error: aErr } = await supabase()
        .from('uflow_project_variants')
        .select('id')
        .eq('project_id', id)
        .eq('status', 'client_review');
      if (aErr) {
        console.error('[client-review] legacy variant lookup', aErr);
        return NextResponse.json({ error: 'DB error' }, { status: 500 });
      }
      decisions =
        (awaiting ?? []).length > 0
          ? (awaiting ?? []).map((v) => ({
              variantId: v.id as string,
              imageUrls,
            }))
          : [{ variantId: null, imageUrls }];
    }
  }

  // ----- Resolve the review targets -----
  type ReviewTarget = Decision & {
    table: 'uflow_projects' | 'uflow_project_variants';
    rowId: string;
    status: string;
    revisionCount: number;
    glbUrl: string | null;
    // Slug the approved asset is filed and published under.
    assetSlug: string;
    // Human-readable name for errors + the published viewer page.
    label: string;
  };

  const variantIds = decisions
    .map((d) => d.variantId)
    .filter((v): v is string => typeof v === 'string');

  type VariantRow = {
    id: string;
    project_id: string;
    name: string;
    slug: string;
    status: string;
    revision_count: number;
    glb_url: string | null;
    is_primary: boolean;
  };
  const variantById = new Map<string, VariantRow>();

  if (variantIds.length > 0) {
    const { data: rows, error: vErr } = await supabase()
      .from('uflow_project_variants')
      .select(
        'id, project_id, name, slug, status, revision_count, glb_url, is_primary'
      )
      .in('id', variantIds);
    if (vErr) {
      console.error('[client-review] variant lookup', vErr);
      return NextResponse.json({ error: 'DB error' }, { status: 500 });
    }
    if (!rows || rows.length !== variantIds.length) {
      return NextResponse.json(
        { error: 'One or more colourways were not found.' },
        { status: 404 }
      );
    }
    // Every id must belong to THIS product — otherwise a crafted
    // request could move another product's colourway, including
    // one belonging to a brand the caller can't see.
    const stray = rows.find((v) => v.project_id !== id);
    if (stray) {
      return NextResponse.json(
        { error: 'That colourway belongs to a different project.' },
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
        assetSlug: project.slug,
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
      // The primary colourway IS the product, so it keeps the bare
      // product slug — its published folder is the one the public
      // viewer URL has always pointed at.
      assetSlug: v.is_primary ? project.slug : `${project.slug}-${v.slug}`,
      label: labelFor(project.name, v.is_primary ? null : v.name),
    };
  });

  // Guards run against every TARGET, not the product. All-or-
  // nothing: a partially applied decision would leave the product
  // in a state nobody asked for.
  for (const t of targets) {
    if (t.status !== 'client_review') {
      return NextResponse.json(
        {
          error: `"${t.label}" is "${t.status}" \u2014 only models awaiting your sign-off can be reviewed.`,
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
  // ============================================================
  const rejected: { id: string; label: string; revision: number }[] = [];
  const approved: { id: string; label: string; url: string }[] = [];

  for (const t of targets) {
    // ---------------- REJECT ----------------
    if (t.imageUrls.length > 0) {
      // revision_count counts REJECTION rounds. Rows are tagged
      // with the POST-bump number so the round reads as "this
      // feedback drove the work that produced revision N", and so
      // the DB agrees with the R2 folder client-feedback-sign
      // already wrote these files into.
      const revision = t.revisionCount + 1;
      const rows = t.imageUrls.map((url) => ({
        project_id: id,
        // Tagged to the colourway it marks up, so the gallery can
        // group "Black - revision 3" rather than one pile.
        variant_id: t.table === 'uflow_project_variants' ? t.rowId : null,
        revision_number: revision,
        image_url: url,
        uploaded_by: auth.userId,
      }));
      const { error: fErr } = await supabase()
        .from('uflow_client_feedback_images')
        .insert(rows);
      if (fErr) {
        console.error('[client-review.reject] insert', fErr);
        // Surface the underlying Postgres message — a bare "DB
        // error" hides things like CHECK failures.
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
          status: 'eqa_rejected',
          revision_count: revision,
          updated_at: new Date().toISOString(),
        })
        .eq('id', t.rowId);
      if (uErr) {
        console.error('[client-review.reject] update', uErr);
        return NextResponse.json(
          { error: `DB error updating "${t.label}": ${uErr.message}` },
          { status: 500 }
        );
      }
      rejected.push({ id: t.rowId, label: t.label, revision });
      continue;
    }

    // ---------------- APPROVE ----------------
    // Two storage side-effects, in this order so a failure in the
    // second doesn't strand the first:
    //
    //   1. Copy the GLB to <client>/<assetSlug>/approved/. This is
    //      the durable archive — even if the published folder is
    //      wiped, this copy survives and the URL stays valid.
    //   2. Publish the viewer folder (GLB + index.html + logo) so
    //      the model is browsable.
    //
    // approved_glb_url stores the PUBLIC VIEWER url, because
    // that's where the dashboards' "View GLB" link should land.
    let r2ApprovedUrl: string;
    try {
      const buf = await fetchFromUrl(t.glbUrl as string);
      const { publicUrl } = await uploadBuffer({
        key: approvedKey(cSlug, t.assetSlug, `${t.assetSlug}.glb`),
        body: buf,
        contentType: 'model/gltf-binary',
      });
      r2ApprovedUrl = publicUrl;
    } catch (err) {
      console.error('[client-review.approve] r2 copy', err);
      return NextResponse.json(
        {
          error: `Could not finalise "${t.label}" (R2 copy): ${
            (err as Error).message
          }`,
        },
        { status: 500 }
      );
    }

    // Publish from the archived copy, not the rev-N upload: the
    // approved/ key is never rewritten, so the published model
    // can't be changed out from under the viewer by a later
    // re-upload to the same rev folder.
    let publishResult;
    try {
      publishResult = await publishGlbToPublicFolder({
        glbSourceUrl: r2ApprovedUrl,
        slug: t.assetSlug,
        projectName: t.label,
      });
    } catch (err) {
      console.error('[client-review.approve] publish', err);
      return NextResponse.json(
        {
          // The archive copy already succeeded, so say so — the
          // model is safe and only the publish step failed.
          error: `"${t.label}" was archived to R2 but could not be published: ${
            (err as Error).message
          }`,
        },
        { status: 500 }
      );
    }

    const approvedUrl = publishResult.publicViewerUrl;

    const { error: uErr } = await supabase()
      .from(t.table)
      .update({
        status: 'approved',
        approved_glb_url: approvedUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', t.rowId);
    if (uErr) {
      console.error('[client-review.approve] update', uErr);
      return NextResponse.json(
        { error: `DB error updating "${t.label}": ${uErr.message}` },
        { status: 500 }
      );
    }
    approved.push({ id: t.rowId, label: t.label, url: approvedUrl });
  }

  return NextResponse.json({
    ok: true,
    // 'mixed' when the submission split both ways — callers that
    // only read a single decision string still get something
    // truthful rather than a silently wrong one.
    decision:
      rejected.length && approved.length
        ? 'mixed'
        : rejected.length
          ? 'eqa_rejected'
          : 'approved',
    rejected,
    approved,
  });
}

// ============================================================
// GET /api/projects/:id/client-review
//
// Returns all client-feedback images for the project. Used by
// admin's QA page to surface why the client previously rejected
// a project that has come back around.
//
// Auth:
//   - admin: any project
//   - client: only their own brand's project
// ============================================================
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;
  if (auth.role !== 'admin' && auth.role !== 'client') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;

  // Client-role scoping check: verify the project belongs to the
  // caller's own brand before exposing any feedback.
  if (auth.role === 'client') {
    if (!auth.clientId) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    const { data: p } = await supabase()
      .from('uflow_projects')
      .select('client_id')
      .eq('id', id)
      .maybeSingle();
    if (!p || p.client_id !== auth.clientId) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
  }

  const { data, error } = await supabase()
    .from('uflow_client_feedback_images')
    .select('id, revision_number, image_url, variant_id, created_at')
    .eq('project_id', id)
    .order('revision_number', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[client-review.list]', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }
  return NextResponse.json({ feedback: data });
}
