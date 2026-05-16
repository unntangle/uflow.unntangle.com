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
}): Promise<{ publicUrl: string }> {
  const e = env();
  await client().send(
    new PutObjectCommand({
      Bucket: e.bucket,
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType,
    })
  );
  return { publicUrl: publicUrlFor(opts.key) };
}

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
