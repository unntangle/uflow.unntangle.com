import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { signUploadUrl, feedbackKey } from '../../../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// POST /api/projects/:id/feedback-sign
// Body: { count: number, content_types?: string[] }
//
// Returns N presigned R2 PUT URLs. The QA dashboard PUTs each
// feedback image directly to its assigned URL, then sends the
// resulting public URLs to /feedback to finalise the rejection.
//
// content_types is optional — when provided, each entry pins the
// Content-Type the browser must send on the matching PUT. Lets us
// store PNG/JPG/WebP correctly so the public URL serves with the
// right MIME instead of generic octet-stream.
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
  const auth = await requireApiUser('admin');
  if (auth instanceof NextResponse) return auth;

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
  if (count < 1 || count > 40) {
    return NextResponse.json(
      { error: 'count must be between 1 and 40.' },
      { status: 400 }
    );
  }

  const rawTypes = Array.isArray(body.content_types) ? body.content_types : [];
  // Parallel to content_types: which colourway each file belongs
  // to. Since feedback is now attached PER VARIANT, the key path
  // has to follow that variant's own revision counter — two
  // colourways under review can sit at different counts (Grey on
  // 10, a newly added Black on 0), and putting Black's screenshot
  // in rev-11 would file it under a round its rows never claim.
  // null / missing entries fall back to the product-wide figure
  // (legacy single-model path).
  const rawVariantIds = Array.isArray(body.variant_ids)
    ? body.variant_ids
    : [];

  // Look up project + client
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select('slug, status, revision_count, client:uflow_clients(slug)')
    .eq('id', id)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }

  // ----- Reviewable check -----
  // uflow_projects.status is only written on the legacy single-
  // model path, so since the variants migration it goes stale as
  // soon as a colourway moves on its own — a product whose
  // colourways are all in qa_pending can still read 'wip' here.
  // Guarding on it alone made the sign step reject uploads for
  // jobs the review page was legitimately reviewing. So we ask
  // the same question the review page does: is ANYTHING here
  // awaiting an admin decision?
  const { data: variants } = await supabase()
    .from('uflow_project_variants')
    .select('id, status, revision_count')
    .eq('project_id', id);

  const REVIEWABLE = ['qa_pending', 'eqa_rejected'];
  const reviewable = (variants ?? []).filter((v) =>
    REVIEWABLE.includes(v.status as string)
  );

  if (reviewable.length === 0 && !REVIEWABLE.includes(project.status)) {
    return NextResponse.json(
      {
        error: `Cannot sign feedback uploads \u2014 nothing on "${project.slug}" is awaiting review.`,
      },
      { status: 400 }
    );
  }

  const clientSlug = Array.isArray(project.client)
    ? (project.client[0] as { slug: string } | undefined)?.slug
    : (project.client as { slug: string } | null)?.slug;
  if (!clientSlug) {
    return NextResponse.json({ error: 'Project has no client.' }, { status: 500 });
  }

  // The next rejection will bump revision_count from N to N+1
  // and tag feedback rows with the post-bump number. The R2
  // folder for the in-flight upload must match — so we compute
  // the same N+1 here for the key path.
  //
  // Per-variant lookup: each colourway advances its OWN counter,
  // so each file's folder is derived from the variant it was
  // attached to rather than one product-wide figure.
  const revisionByVariant = new Map<string, number>(
    reviewable.map((v) => [
      v.id as string,
      (v.revision_count as number) + 1,
    ])
  );
  // Fallback for files with no variant (legacy single-model
  // path, or a client that hasn't been updated yet).
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
        const key = feedbackKey(clientSlug, project.slug, revision, filename);
        const { url, publicUrl } = await signUploadUrl({
          key,
          contentType,
          expiresInSeconds: 3600,
        });
        return {
          upload_url: url,
          public_url: publicUrl,
          content_type: contentType,
          // Echoed back so the caller can map the signed slot to
          // the colourway it belongs to without relying on
          // array order alone.
          variant_id: typeof vid === 'string' ? vid : null,
        };
      })
    );

    return NextResponse.json({ signed });
  } catch (err) {
    console.error('[feedback-sign]', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Could not sign uploads.' },
      { status: 500 }
    );
  }
}
