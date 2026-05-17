import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const hostname = req.headers.get('host') || '';

  // If we are on the viewer subdomain
  if (hostname.startsWith('officemate.')) {
    const path = url.pathname;
    
    // Check if it's an asset (has a file extension)
    // Next.js static files typically have extensions.
    // The slug itself should not contain a dot.
    const isAsset = path.substring(path.lastIndexOf('/') + 1).includes('.');
    
    if (path !== '/' && !isAsset) {
      // It's a viewer page route like /jupiter
      const slug = path.replace(/\/$/, '');
      return NextResponse.rewrite(new URL(`/officemate${slug}/index.html`, req.url));
    } else {
      // It's an asset like /jupiter/Jupiter6.glb
      return NextResponse.rewrite(new URL(`/officemate${path}`, req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and API routes
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
