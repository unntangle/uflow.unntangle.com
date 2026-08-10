// ============================================================
// <model-viewer> loading configuration — single source of truth
// ============================================================
// The GLB viewer has two costs on first paint:
//
//   1. The model-viewer bundle (~300 KB gzipped, three.js inside)
//   2. The GLB itself (usually the far bigger of the two)
//
// Previously these were STRICTLY SERIAL: the page shipped, React
// hydrated, a useEffect appended the <script>, the browser fetched
// and parsed it, the custom element upgraded, and only THEN did the
// GLB download start. On a 20 MB model over a normal connection the
// first ~1-2s of the progress bar was pure waterfall, not transfer.
//
// The fix is to declare both fetches in the server-rendered <head>
// so they start together, in parallel, before any JS runs:
//
//   <link rel="preconnect">   — DNS + TLS to the R2 host up front
//   <link rel="preload" as="fetch" crossorigin>  — the GLB
//   <link rel="modulepreload"> + <script type="module" async>
//
// `crossOrigin="anonymous"` on the GLB preload is REQUIRED, not
// cosmetic: model-viewer fetches the model as a CORS request with
// credentials mode "same-origin". A preload whose mode doesn't
// match is ignored and the file is downloaded TWICE. Anonymous is
// the mode that matches — don't drop it.
// ============================================================

export const MODEL_VIEWER_SCRIPT_URL =
  'https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';

// Origin of the model-viewer CDN, for preconnect.
export const MODEL_VIEWER_ORIGIN = 'https://ajax.googleapis.com';

// Returns the scheme+host of a URL, or null if it isn't parseable.
// Used to preconnect to whichever host the GLB lives on (R2 public
// bucket today, a Cloudflare custom domain tomorrow) without having
// to hardcode it or read env on the client.
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
