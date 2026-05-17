import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
  },

  // ============================================================
  // Subdomain routing for the public viewer
  // ============================================================
  // The OfficeMate viewer pages live on disk at
  //   public/officemate/<slug>/index.html
  // and are written there by the publish step on approval.
  //
  // We want two URLs to reach the same file:
  //   1. The CRM-app URL:       /officemate/<slug>/
  //                             (works on any host; used by
  //                             local dev and as a fallback)
  //   2. The branded subdomain: officemate.unntangle.com/<slug>/
  //                             (the public-facing customer URL)
  //
  // (1) works out of the box — Next serves /public at the app
  // root. (2) needs a rewrite that strips the host-implicit
  // /officemate/ prefix when the request comes in via the
  // subdomain, so a hit on /jupiter/ resolves to the file at
  // public/officemate/jupiter/index.html.
  //
  // The `has: [{ type: 'host', value: 'officemate.unntangle.com' }]`
  // guard scopes the rewrite to the subdomain so the CRM-app
  // routes on the main domain are untouched. In local dev there
  // is no such subdomain, so this rule simply doesn't match
  // and you keep using the explicit /officemate/<slug>/ URL.
  // ============================================================
  async rewrites() {
    return [
      // ----------------------------------------------------------
      // Clean URLs for the viewer pages — local dev fallback.
      // If the user visits localhost:3000/officemate/jupiter
      // directly (without the subdomain), this appends index.html.
      // Subdomain routing is now handled by middleware.ts
      // ----------------------------------------------------------
      {
        source: '/officemate/:slug([^.]+)',
        destination: '/officemate/:slug/index.html',
      },
      {
        source: '/officemate/:slug([^.]+)/',
        destination: '/officemate/:slug/index.html',
      },
    ];
  },

  async headers() {
    return [
      {
        // Long-term cache for OfficeMate 3D models & assets
        source: '/officemate/:path*\\.(glb|webp)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
