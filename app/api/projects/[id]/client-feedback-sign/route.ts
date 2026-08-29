import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { signUploadUrl, clientFeedbackKey } from '../../../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// POST /api/projects/:id/client-feedback-sign
// Body: { count: number,
//         content_types?: string[],
//         variant_ids?: (string | null)[] }
//
// Mirrors the admin /feedback-sign endpoint but for client-role
// users on models awaiting EQA sign-off. Returns N presigned R2
// PUT URLs scoped to the client-feedback/ folder.
//
// Auth: 'client' only. Project must belong to the caller's own
// brand AND have something awaiting their sign-off. The route
// trusts only auth.clientId (from the JWT) for the brand check —
// never the request body.
//
// variant_ids is parallel to content_types: which colourway each
// file belongs to. Feedback is attached PER COLOURWAY, and each
// one carries its own revision counter, so the R2 folder has to
// follow that colourway rather than one product-wide figure —
// two models under review can sit at different counts (Grey on
// 4, a newly added Black on 0), and filing Black's screenshot
// under rev-5 would put it in a round its rows never claim.
// ============================================================

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function safeContentType(t: unknown): string {
  return typeof t === 'string' && ALLOWED_TYPES.has(t)
    ? t
    : 'application/octet-stream';
}

function extFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
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

  let body: {
    count?: number;
    content_types?: unknown;
    variant_ids?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const count = body.count || 0;
  if (count < 1 || count > 20) {
    return NextResponse.json(
      { error: 'count must be between 1 and 20.' },
      { status: 400 }
    );
  }

  const rawTypes = Array.isArray(body.content_types) ? body.content_types : [];
  const rawVariantIds = Array.isArray(body.variant_ids)
    ? body.variant_ids
    : [];

  // ----- Load project + verify brand + status -----
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select(
      'slug, name, status, revision_count, glb_url, client_id, client:uflow_clients(slug)'
    )
    .eq('id', id)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  // Brand check FIRST so we don't leak status info for projects
  // a client shouldn't see.
  if (project.client_id !== auth.clientId) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // ----- Reviewable check -----
  // uflow_projects.status is only written on the legacy single-
  // model path, so since the variants migration it goes stale as
  // soon as a colourway moves on its own — a product whose
  // colourways were all forwarded for sign-off can still read
  // 'wip' here. Guarding on it alone rejected uploads for exactly
  // the jobs the client review page was legitimately reviewing.
  // So we ask the same question that page does: is ANYTHING here
  // awaiting this client's decision?
  const { data: variants } = await supabase()
    .from('uflow_project_variants')
    .select('id, status, revision_count, glb_url')
    .eq('project_id', id);

  const reviewable = (variants ?? []).filter(
    (v) => v.status === 'client_review'
  );

  if (reviewable.length === 0 && project.status !== 'client_review') {
    return NextResponse.json(
      {
        error: `Cannot sign client-feedback uploads — nothing on "${project.slug}" is awaiting your review.`,
      },
      { status: 400 }
    );
  }

  // ----- Asset check: EVERY guard client-review will apply -----
  // This endpoint hands out presigned PUT URLs, and the browser
  // uploads to R2 the moment it gets them — BEFORE the decision
  // is posted to /client-review. So any guard that lives only in
  // that route runs too late: the files are already in the bucket
  // when it returns 400, and because no DB rows are written they
  // are unreachable from every screen afterwards. That is exactly
  // how a batch of client screenshots was uploaded, refused, and
  // silently lost.
  //
  // The rule is now: this endpoint must refuse anything
  // /client-review would refuse. The GLB check is the one that
  // was missing — since the variants migration uploads wrote
  // glb_url onto the colourway and left the product's own column
  // null, so a legacy-path target could pass the status check and
  // still have nothing to review.
  const someTargetHasNoModel =
    reviewable.length > 0
      ? reviewable.some((v) => !v.glb_url)
      : !project.glb_url;

  if (someTargetHasNoModel) {
    return NextResponse.json(
      {
        error: `Cannot attach feedback — "${project.name}" has no uploaded model to review yet. Nothing was uploaded.`,
      },
      { status: 400 }
    );
  }

  // Named colourways must each be one of the reviewable ones.
  // Signing a slot for a colourway that isn't awaiting sign-off
  // would put its file in a revision folder no DB row will ever
  // claim.
  const strayVariantId = rawVariantIds.find(
    (v) =>
      typeof v === 'string' && !reviewable.some((r) => r.id === v)
  );
  if (typeof strayVariantId === 'string') {
    return NextResponse.json(
      {
        error:
          'One of the models in this submission is no longer awaiting your review. Reload the page and try again — nothing was uploaded.',
      },
      { status: 400 }
    );
  }

  const clientSlug = Array.isArray(project.client)
    ? (project.client[0] as { slug: string } | undefined)?.slug
    : (project.client as { slug: string } | null)?.slug;
  if (!clientSlug) {
    return NextResponse.json(
      { error: 'Project has no client.' },
      { status: 500 }
    );
  }

  // Same semantics as feedback-sign: the next rejection bumps
  // revision_count from N to N+1 and tags feedback rows with the
  // post-bump number. The R2 folder must match. First rejection
  // (revision_count=0) puts feedback under client-feedback/rev-1/.
  //
  // Per-colourway lookup: each one advances its OWN counter, so
  // each file's folder comes from the colourway it was attached
  // to rather than one product-wide figure.
  const revisionByVariant = new Map<string, number>(
    reviewable.map((v) => [
      v.id as string,
      (v.revision_count as number) + 1,
    ])
  );
  // Files with no colourway (legacy single-model path, or an
  // older client bundle that doesn't send variant_ids) fall back
  // to the furthest-along round so the key can't collide with a
  // folder an earlier round already wrote.
  const fallbackRevision = reviewable.length
    ? Math.max(...reviewable.map((v) => (v.revision_count as number) + 1))
    : project.revision_count + 1;

  try {
    const signed = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const contentType = safeContentType(rawTypes[i]);
        const vid = rawVariantIds[i];
        const revision =
          typeof vid === 'string' && revisionByVariant.has(vid)
            ? (revisionByVariant.get(vid) as number)
            : fallbackRevision;
        const filename = `${randomUUID()}.${extFor(contentType)}`;
        const key = clientFeedbackKey(
          clientSlug,
          project.slug,
          revision,
          filename
        );
        const { url, publicUrl } = await signUploadUrl({
          key,
          contentType,
          expiresInSeconds: 3600,
        });
        return {
          upload_url: url,
          public_url: publicUrl,
          content_type: contentType,
          // Echoed back so the caller can map a signed slot to the
          // colourway it belongs to without relying on array
          // order alone.
          variant_id: typeof vid === 'string' ? vid : null,
        };
      })
    );

    return NextResponse.json({ signed });
  } catch (err) {
    console.error('[client-feedback-sign]', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Could not sign uploads.' },
      { status: 500 }
    );
  }
}
