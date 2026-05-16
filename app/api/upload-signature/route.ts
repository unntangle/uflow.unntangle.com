// ============================================================
// LEGACY stub. Superseded by /api/projects/:id/upload-sign which
// derives the folder + revision from project state and so cannot
// be misused to write into another project's namespace.
// ============================================================

import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

export async function POST() {
  return NextResponse.json(
    {
      error:
        'This endpoint is retired. Use /api/projects/:id/upload-sign instead.',
    },
    { status: 410 }
  );
}
