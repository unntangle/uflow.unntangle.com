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

  // Look up project + client
  const { data: project } = await supabase()
    .from('uflow_projects')
    .select('slug, status, revision_count, client:uflow_clients(slug)')
    .eq('id', id)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  if (project.status !== 'qa_pending' && project.status !== 'eqa_rejected') {
    return NextResponse.json(
      { error: `Cannot sign feedback uploads for status "${project.status}".` },
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
  const revision = project.revision_count + 1;

  try {
    const signed = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const contentType = safeContentType(rawTypes[i]);
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
