// ============================================================
// LEGACY — kept as a stub.
//
// This endpoint used to accept a FormData upload with the zip as
// the body. That hit Vercel's 4.5 MB inbound limit immediately,
// so we replaced it with the direct-to-Cloudinary flow:
//
//   1. POST /api/projects/:id/upload-sign   → mints a Cloudinary signature
//   2. Browser uploads zip directly to Cloudinary
//   3. POST /api/projects/:id/finalize-upload  → extracts the zip
//
// This stub is kept only so any stale link or bookmark gets a
// clear 410 instead of a confusing 404 or runtime error.
// ============================================================

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST() {
  return NextResponse.json(
    {
      error:
        'This endpoint is retired. Use /api/projects/:id/upload-sign + /api/projects/:id/finalize-upload instead.',
    },
    { status: 410 }
  );
}
