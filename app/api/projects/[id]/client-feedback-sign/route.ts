import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireApiUser } from '../../../../lib/auth';
import { supabase } from '../../../../lib/supabase';
import { signUploadUrl, clientFeedbackKey } from '../../../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// POST /api/projects/:id/client-feedback-sign
// Body: { count: number, content_types?: string[] }
//
// Mirrors the admin /feedback-sign endpoint but for client-role
// users on projects in 'client_review' status. Returns N
// presigned R2 PUT URLs scoped to the client-feedback/ folder.
//
// Auth: 'client' only. Project must belong to the caller's own
// brand AND be in 'client_review' status. The route trusts only
// auth.clientId (from the JWT) for the brand check \u2014 never the
// request body.
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

  let body: { count?: number; content_types?: unknown };
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

  // ----- Load project + verify brand + status -----
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select(
      'slug, status, revision_count, client_id, client:uflow_clients(slug)'
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
  if (project.status !== 'client_review') {
    return NextResponse.json(
      {
        error: `Cannot sign client-feedback uploads for status "${project.status}".`,
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
  const revision = project.revision_count + 1;

  try {
    const signed = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const contentType = safeContentType(rawTypes[i]);
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
