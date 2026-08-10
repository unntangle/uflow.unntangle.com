// ============================================================
// Cloudflare R2 helpers (server-side only)
// ============================================================
// R2 speaks the S3 API, so we use the AWS SDK with a custom
// endpoint and `forcePathStyle: true`. The public URL is a
// separate hostname (pub-*.r2.dev or a custom domain) that
// serves objects read-only — we never hit it server-side, we
// only construct it for storage in the DB.
//
// Folder layout (identical to the previous Cloudinary layout
// so existing DB rows and the OfficeMate viewer don't care):
//
//   officemate/jupiter/uploads/rev-1/source.zip
//   officemate/jupiter/uploads/rev-1/glb/Jupiter.glb
//   officemate/jupiter/uploads/rev-1/fbx/Jupiter.fbx
//   officemate/jupiter/uploads/rev-1/gltf/scene.gltf
//   officemate/jupiter/feedback/rev-1/<uuid>.png
//   officemate/jupiter/references/<uuid>.png
//   officemate/jupiter/approved/<slug>.glb
//
// The folder string IS the object key prefix in R2 — there are
// no real "folders" in S3-compatible storage, just /-separated
// keys. We keep the prefix style for two reasons:
//   1. Migration: keys look familiar, easy to eyeball.
//   2. Cloudflare's dashboard groups by prefix, so paths still
//      browse like a folder tree.
// ============================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ----- env -----
function env(): {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
} {
  const {
    R2_ENDPOINT,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    R2_PUBLIC_URL,
  } = process.env;

  if (
    !R2_ENDPOINT ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET ||
    !R2_PUBLIC_URL
  ) {
    throw new Error(
      'Missing Cloudflare R2 env vars. Required: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL.'
    );
  }

  return {
    endpoint: R2_ENDPOINT,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
    // Strip trailing slash so we can join with `/${key}` without doubling.
    publicUrl: R2_PUBLIC_URL.replace(/\/+$/, ''),
  };
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  const e = env();
  _client = new S3Client({
    region: 'auto', // R2 ignores the region but the SDK demands one.
    endpoint: e.endpoint,
    credentials: {
      accessKeyId: e.accessKeyId,
      secretAccessKey: e.secretAccessKey,
    },
    // R2 uses path-style addressing (bucket in the path, not the host).
    forcePathStyle: true,
  });
  return _client;
}

// ============================================================
// Public URL construction
// ============================================================
// The browser/<model-viewer> reads via the public hostname,
// not the S3 endpoint. We never sign reads for the GLB/image
// paths — the bucket is configured as public-read so URLs are
// stable forever.
// ============================================================
export function publicUrlFor(key: string): string {
  const e = env();
  return `${e.publicUrl}/${key.replace(/^\/+/, '')}`;
}

export function bucketName(): string {
  return env().bucket;
}

// Returns true if `url` is a public URL pointing at our R2 bucket.
// Used by the projects POST route to validate reference URLs
// passed in by the client (so an admin can't pin arbitrary
// external images by hand).
export function isOurPublicUrl(url: string): boolean {
  return url.startsWith(env().publicUrl + '/');
}

// ============================================================
// Presigned PUT URL — for browser direct uploads
// ============================================================
// Returns a one-shot URL the browser PUTs to with the raw file
// body (no FormData, no extra fields). 1 hour lifetime by
// default — enough for a slow upload, short enough that a
// leaked URL isn't useful indefinitely.
// ============================================================
export async function signUploadUrl(opts: {
  key: string;
  contentType?: string;
  expiresInSeconds?: number;
}): Promise<{ url: string; publicUrl: string }> {
  const e = env();
  const cmd = new PutObjectCommand({
    Bucket: e.bucket,
    Key: opts.key,
    ContentType: opts.contentType,
  });
  const url = await getSignedUrl(client(), cmd, {
    expiresIn: opts.expiresInSeconds ?? 3600,
    // Pin to PUT — getSignedUrl mints a PUT URL by default for
    // PutObjectCommand, but being explicit avoids surprises.
  });
  return { url, publicUrl: publicUrlFor(opts.key) };
}

// ============================================================
// Server-side upload — for things the server produces directly
// (extracted GLB/FBX/GLTF after unzipping, approved-folder copy).
// Browser uploads never come through here.
// ============================================================
export async function uploadBuffer(opts: {
  key: string;
  body: Buffer;
  contentType: string;
  // Cache-Control to store on the object. R2 replays whatever we
  // set here on every public GET, so this is the ONLY place the
  // browser cache policy for bucket assets can be decided — the
  // `headers()` rules in next.config.ts apply to files Next serves
  // and never touch an R2 URL.
  //
  // Omitted by default because most keys in this bucket are written
  // in place (approved/<slug>.glb, fbx/, gltf/, source.zip): giving
  // those a long TTL would serve a stale asset after a re-upload.
  // Pass IMMUTABLE_CACHE_CONTROL only for keys whose FILENAME
  // changes every write — today that's the QA GLB, which carries a
  // "_<seq>" cache-busting suffix.
  cacheControl?: string;
}): Promise<{ publicUrl: string }> {
  const e = env();
  await client().send(
    new PutObjectCommand({
      Bucket: e.bucket,
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl,
    })
  );
  return { publicUrl: publicUrlFor(opts.key) };
}

// One year, and `immutable` so the browser won't even revalidate.
// Safe ONLY for content-addressed / sequence-suffixed keys.
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// ============================================================
// Server-side fetch — for re-reading objects (e.g. fetching
// the uploaded zip back to extract its contents).
// We could just fetch the public URL since the bucket is
// public, but using a presigned GET keeps us working even
// if a future migration moves to a private bucket.
// ============================================================
export async function fetchAsBuffer(key: string): Promise<Buffer> {
  const e = env();
  const cmd = new GetObjectCommand({ Bucket: e.bucket, Key: key });
  const url = await getSignedUrl(client(), cmd, { expiresIn: 300 });
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`R2 fetch failed for ${key}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Same as fetchAsBuffer but for callers that already have a
// public URL (e.g. body of an API request). We extract the key,
// then go via the bucket. Falls back to a plain HTTPS fetch if
// the URL isn't ours (legacy Cloudinary URLs during migration).
export async function fetchFromUrl(url: string): Promise<Buffer> {
  if (isOurPublicUrl(url)) {
    const e = env();
    const key = url.slice(e.publicUrl.length + 1);
    return fetchAsBuffer(key);
  }
  // Legacy or external URL — straight fetch.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ============================================================
// Key helpers — single source of truth for path layout.
// Match the previous lib/cloudinary.ts helpers so the storage
// layout doesn't change when we swap vendors.
// ============================================================
export function uploadKey(
  clientSlug: string,
  projectSlug: string,
  revision: number,
  filename: string
): string {
  return `${clientSlug}/${projectSlug}/uploads/rev-${revision}/${filename}`;
}

export function feedbackKey(
  clientSlug: string,
  projectSlug: string,
  revision: number,
  filename: string
): string {
  return `${clientSlug}/${projectSlug}/feedback/rev-${revision}/${filename}`;
}

// Client rejection feedback is stored in a sibling folder so that
// admin feedback and client feedback don't get visually intermixed
// when browsing the bucket. The DB also keeps them in separate
// tables (uflow_feedback_images vs uflow_client_feedback_images),
// so this folder mirrors that boundary.
export function clientFeedbackKey(
  clientSlug: string,
  projectSlug: string,
  revision: number,
  filename: string
): string {
  return `${clientSlug}/${projectSlug}/client-feedback/rev-${revision}/${filename}`;
}

export function referenceKey(
  clientSlug: string,
  projectSlug: string,
  filename: string
): string {
  return `${clientSlug}/${projectSlug}/references/${filename}`;
}

export function approvedKey(
  clientSlug: string,
  projectSlug: string,
  filename: string
): string {
  return `${clientSlug}/${projectSlug}/approved/${filename}`;
}

// ============================================================
// Listing + bulk delete
// ============================================================
// Used by the hard-delete ("purge") flow to remove every object
// under a project's key prefix. R2/S3 has no real folders, so
// "delete a folder" = list every key under the prefix (paginated
// via the continuation token) then batch-delete them. DeleteObjects
// accepts up to 1000 keys per call.
// ============================================================
export async function listKeysByPrefix(prefix: string): Promise<string[]> {
  const e = env();
  const keys: string[] = [];
  let continuationToken: string | undefined = undefined;
  do {
    const res: any = await client().send(
      new ListObjectsV2Command({
        Bucket: e.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    // Only follow the cursor while the response says it's truncated,
    // otherwise we'd loop forever on a stale token.
    continuationToken = res.IsTruncated
      ? res.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return keys;
}

// Deletes every object under `prefix`. Returns the count removed.
// Safe on an empty prefix-match (returns 0). Batches in groups of
// 1000 (the S3 DeleteObjects limit).
export async function deleteByPrefix(prefix: string): Promise<number> {
  // Hard guard: never allow an empty / whitespace-only prefix.
  // That would match the ENTIRE bucket and wipe every project's
  // assets. Callers always pass a project-scoped prefix such as
  // "officemate/hola-black/".
  const clean = prefix.replace(/^\/+/, '');
  if (!clean.trim()) {
    throw new Error('deleteByPrefix refused an empty prefix.');
  }
  const e = env();
  const keys = await listKeysByPrefix(clean);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await client().send(
      new DeleteObjectsCommand({
        Bucket: e.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      })
    );
    deleted += batch.length;
  }
  return deleted;
}

// ============================================================
// Delete a specific set of object keys (NOT a whole prefix).
// ============================================================
// Used to prune superseded model files after a cache-busted
// re-upload: the GLB gets a fresh "_N" filename every upload, so
// without this the previous Name_(N-1).glb would linger in the
// bucket forever. Unlike deleteByPrefix this only removes the
// exact keys handed in, so the just-uploaded files are never at
// risk. No-ops on an empty list. Batches in groups of 1000 (the
// S3 DeleteObjects limit).
export async function deleteKeys(keys: string[]): Promise<number> {
  const clean = keys
    .map((k) => k.replace(/^\/+/, ''))
    .filter((k) => k.trim().length > 0);
  if (clean.length === 0) return 0;
  const e = env();
  let deleted = 0;
  for (let i = 0; i < clean.length; i += 1000) {
    const batch = clean.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await client().send(
      new DeleteObjectsCommand({
        Bucket: e.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      })
    );
    deleted += batch.length;
  }
  return deleted;
}
