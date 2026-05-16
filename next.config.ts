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
      // (A) Subdomain routing for the public viewer (production).
      // Maps officemate.unntangle.com/<slug>/ → /officemate/<slug>/
      // so the customer-facing URL doesn't need to include the
      // /officemate/ prefix that's used internally on disk.
      // The host guard scopes this so the main domain (where the
      // CRM app lives) is unaffected.
      // ----------------------------------------------------------
      {
        source: '/:path*',
        destination: '/officemate/:path*',
        has: [
          {
            type: 'host',
            value: 'officemate.unntangle.com',
          },
        ],
      },

      // ----------------------------------------------------------
      // (B) Clean URLs for the viewer pages — local dev + prod.
      // Next's static file handler doesn't auto-resolve a path
      // like /officemate/jupiter to /officemate/jupiter/index.html
      // (no implicit directory index). Without these rewrites you
      // get a 404 unless the user types the trailing slash AND
      // /index.html. We rewrite both shapes so the URL stays
      // friendly. The (.*\\..+) negative-style hint isn't needed
      // — the rewrite target only matches when index.html exists,
      // so /officemate/<slug>/<file>.glb still serves the GLB
      // directly (the static handler wins for actual files).
      // ----------------------------------------------------------
      {
        source: '/officemate/:slug',
        destination: '/officemate/:slug/index.html',
      },
      {
        source: '/officemate/:slug/',
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
