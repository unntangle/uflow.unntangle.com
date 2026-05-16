import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireApiUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { signUploadUrl, referenceKey } from '../../lib/r2';

export const runtime = 'nodejs';

// ============================================================
// POST /api/references-sign
// Body: { client_slug: string, project_slug: string, count: number,
//         content_types?: string[] }
//
// Returns N presigned R2 PUT URLs scoped to:
//    <client_slug>/<project_slug>/references/
//
// Used at job-creation time — the project row doesn't exist yet,
// so we can't use the per-project signature endpoint. Both admin
// and client roles can call this:
//   - admin can sign for any client_slug
//   - client can ONLY sign for their own brand's slug (verified
//     against auth.clientId)
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

export async function POST(req: NextRequest) {
  // Allow both admin and client. We enforce the brand scoping
  // below — a client can ONLY sign uploads for their own brand.
  const auth = await requireApiUser();
  if (auth instanceof NextResponse) return auth;
  if (auth.role !== 'admin' && auth.role !== 'client') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: {
    client_slug?: string;
    project_slug?: string;
    count?: number;
    content_types?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const clientSlug = body.client_slug?.trim();
  const projectSlug = body.project_slug
    ?.toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const count = body.count || 0;

  if (!clientSlug || !projectSlug) {
    return NextResponse.json(
      { error: 'client_slug and project_slug required.' },
      { status: 400 }
    );
  }
  if (count < 1 || count > 20) {
    return NextResponse.json(
      { error: 'count must be between 1 and 20.' },
      { status: 400 }
    );
  }

  // ----- Client-role scoping check -----
  // A client can only sign uploads for their own brand. We look
  // up the brand by id (from the JWT) and reject if the slug in
  // the request doesn't match. The JWT's clientId is trusted;
  // the request body is not.
  if (auth.role === 'client') {
    if (!auth.clientId) {
      return NextResponse.json(
        { error: 'Your account is not linked to a client brand.' },
        { status: 403 }
      );
    }
    const { data: c } = await supabase()
      .from('uflow_clients')
      .select('slug')
      .eq('id', auth.clientId)
      .maybeSingle();
    if (!c || c.slug !== clientSlug) {
      return NextResponse.json(
        { error: 'You can only upload references for your own brand.' },
        { status: 403 }
      );
    }
  }

  const rawTypes = Array.isArray(body.content_types) ? body.content_types : [];

  try {
    const signed = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const contentType = safeContentType(rawTypes[i]);
        const filename = `${randomUUID()}.${extFor(contentType)}`;
        const key = referenceKey(clientSlug, projectSlug, filename);
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
    console.error('[references-sign]', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Could not sign uploads.' },
      { status: 500 }
    );
  }
}
