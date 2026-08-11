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

// ============================================================
// Review lighting modes
// ============================================================
// WHAT ACTUALLY LIGHTS THE MODEL
//
// <model-viewer> lights a scene almost entirely from an image-
// based light (IBL) — an environment map that surrounds the model
// and supplies both the diffuse light and every specular
// reflection. So the control that changes "the light falling on
// the model" is `environment-image`, NOT exposure and NOT the page
// background:
//
//   environment-image — WHICH lights exist, from where, what
//     colour, and what glossy surfaces reflect. This is the one
//     that visibly re-lights a model.
//   exposure          — a single brightness multiplier over the
//     final render. Brighter/darker, same light directions.
//   shadow-intensity  — the synthetic contact shadow on the
//     ground plane only. Nothing to do with scene lighting.
//
// model-viewer ships exactly two built-in environments ('neutral'
// and 'legacy'), so anything beyond those is a real .hdr fetched
// over the network.
//
// THE TWO MODES
//
//   soft  — "does this model read correctly?" Even, soft light
//           from the built-in neutral probe. No network fetch, and
//           no strong directional bias to hide or exaggerate
//           surface detail. The default.
//
//   metal — "are the metal and gloss values right?" Metal has
//           almost no diffuse colour of its own: it is ENTIRELY
//           reflection. Under the neutral probe a metal part
//           renders as flat grey mush, which is why judging it
//           needs a real photographic HDR with distinct bright
//           shapes to reflect. Roughness then reads as how blurred
//           those reflections become.
//
// (A third "base colour / unlit" mode was tried and removed. It
// needed rewiring every material's emissive channel to its own
// albedo, since model-viewer has no unlit toggle and exposure 0
// just renders black. The material API in the pinned 3.5 build
// didn't support it reliably, and a half-working colour check is
// worse than none — a reviewer would trust a reading that isn't
// true albedo. Revisit if model-viewer is upgraded to 4.x.)
//
// HOSTING NOTE — READ BEFORE PRODUCTION
// The metal mode's HDR points at modelviewer.dev's shared assets.
// Those are Google's official demo assets, CORS-enabled and
// stable, but it is a DOCS SITE, not a CDN anyone has promised you
// uptime on. Re-host that one file in the R2 bucket (alongside the
// logo under `officemate/_assets/`) and change METAL_HDR below —
// a one-line change that removes the third-party dependency.
// ============================================================

const HDR_BASE = 'https://modelviewer.dev/shared-assets/environments';

// Overhead industrial lamps + large soft windows: bright, clearly
// shaped sources, which is exactly what a metal surface needs in
// order to show anything at all.
export const METAL_HDR = `${HDR_BASE}/aircraft_workshop_01_1k.hdr`;

// Origin the HDR comes from, so the viewer route can preconnect.
export const HDR_ORIGIN = originOf(METAL_HDR);

export type ViewerMode = {
  id: string;
  label: string;
  // Shown under the option so a reviewer picks by question, not
  // by jargon.
  hint: string;
  // '' removes the attribute (model-viewer's own default probe).
  environmentImage: string;
  // Starting points for the sliders. Every one of these can be
  // overridden per mode and the override is remembered.
  exposure: number;
  shadowIntensity: number;
  shadowSoftness: number;
  // Render the environment map as the backdrop. Only meaningful
  // for a real HDR — the built-in probe is procedural and would
  // show a flat grey void that reads as a bug.
  allowSkybox: boolean;
  // Default backdrop for the mode. Metal defaults dark because
  // reflections read far better against one.
  dark: boolean;
};

export const VIEWER_MODES: ViewerMode[] = [
  {
    id: 'soft',
    label: 'Soft studio',
    hint: 'General quality check. Even, soft light with no strong direction.',
    environmentImage: 'neutral',
    exposure: 1,
    shadowIntensity: 0.9,
    shadowSoftness: 1,
    allowSkybox: false,
    dark: false,
  },
  {
    id: 'metal',
    label: 'Metal & gloss',
    hint: 'Photographic light with hard sources, so reflections and roughness show.',
    environmentImage: METAL_HDR,
    // Slightly hot: metal reads dark under its own reflections, and
    // this pulls the highlights up where they can be judged.
    exposure: 1.15,
    shadowIntensity: 0.55,
    shadowSoftness: 0.75,
    allowSkybox: true,
    dark: true,
  },
];

export const DEFAULT_MODE = VIEWER_MODES[0];

export function modeById(id: string | null | undefined): ViewerMode {
  return VIEWER_MODES.find((m) => m.id === id) ?? DEFAULT_MODE;
}

// ------------------------------------------------------------
// Adjustments
// ------------------------------------------------------------
// Sliders rather than more presets: "a bit less blown out" is the
// actual note a reviewer has, and no fixed preset lands on it.
//
// Ranges are clamped so the whole travel of each slider is useful.
// Exposure above ~2.5 is blown out on nearly every asset and below
// 0.2 is unreadable, so a 0-10 slider would waste most of its
// length on values nobody wants.
// ------------------------------------------------------------
// Light intensity — and what it can and can't isolate
// ------------------------------------------------------------
// `exposure` is the control for how much light falls on the
// model. The environment map decides the DIRECTION and COLOUR of
// the light and what glossy surfaces reflect; exposure scales how
// strong all of it lands. Turning it up brightens both the soft
// fill and the specular highlights — which is what "more light on
// the model" means visually.
//
// WHAT IT CANNOT DO, in the pinned model-viewer 3.5:
// separate the reflections from the rest. There is no
// environment-intensity attribute, so reflections can't be dialled
// up while the diffuse light stays put. Exposure moves them
// together.
//
// The rejected alternative: material roughness. Shifting roughness
// does change reflections alone — but it changes GLOSSINESS, i.e.
// the artist's material, not the light. That was implemented and
// removed: a QA viewer must never quietly alter the asset being
// judged.
//
// If reflections genuinely need to move independently of overall
// brightness, that needs model-viewer 4.x, where three.js exposes
// scene.environmentIntensity. That's a dependency upgrade, not a
// setting.
export const EXPOSURE_RANGE = { min: 0.2, max: 2.5, step: 0.05 };
export const SHADOW_INTENSITY_RANGE = { min: 0, max: 2, step: 0.05 };
export const SHADOW_SOFTNESS_RANGE = { min: 0, max: 1, step: 0.05 };

// Per-mode overrides. Held separately for each mode so a tweak
// made while judging metal doesn't follow you into the soft view,
// where it would be wrong — and so coming BACK to metal restores
// the setup you had, rather than resetting it.
export type ModeOverride = {
  exposure?: number;
  shadowIntensity?: number;
  shadowSoftness?: number;
  dark?: boolean;
  skybox?: boolean;
};

export type ViewerLighting = {
  modeId: string;
  overrides: Record<string, ModeOverride>;
};

export const DEFAULT_LIGHTING: ViewerLighting = {
  modeId: DEFAULT_MODE.id,
  overrides: {},
};

export const LIGHT_BACKDROP = 'linear-gradient(180deg, #fafafa, #ededed)';
export const DARK_BACKDROP = 'linear-gradient(180deg, #232326, #0d0d0f)';

// ------------------------------------------------------------
// Resolved values — what the viewer actually applies.
// ------------------------------------------------------------
// One place that folds a mode's defaults together with the user's
// overrides, so no caller has to remember the precedence. Also
// reports whether anything is currently overridden, which is what
// lets the panel show a "modified" state on its Reset button.
export type ResolvedLighting = {
  mode: ViewerMode;
  environmentImage: string;
  exposure: number;
  shadowIntensity: number;
  shadowSoftness: number;
  skybox: boolean;
  dark: boolean;
  backdrop: string;
  modified: boolean;
};

export function resolveLighting(l: ViewerLighting): ResolvedLighting {
  const mode = modeById(l.modeId);
  const o = l.overrides?.[mode.id] ?? {};
  const skybox = (o.skybox ?? false) && mode.allowSkybox && !!mode.environmentImage;
  const dark = o.dark ?? mode.dark;
  return {
    mode,
    environmentImage: mode.environmentImage,
    exposure: o.exposure ?? mode.exposure,
    shadowIntensity: o.shadowIntensity ?? mode.shadowIntensity,
    shadowSoftness: o.shadowSoftness ?? mode.shadowSoftness,
    skybox,
    dark,
    // With the skybox on, the environment IS the backdrop; the
    // wrapper only shows during load, so a neutral grey avoids a
    // white flash before the HDR resolves.
    backdrop: skybox ? '#3a3a3d' : dark ? DARK_BACKDROP : LIGHT_BACKDROP,
    modified: Object.keys(o).length > 0,
  };
}

// localStorage key for the reviewer's setup. Persisting it means
// someone working in one mode isn't rebuilding it on every model.
export const VIEWER_LIGHTING_KEY = 'uflow.viewer.lighting';

const clamp = (
  v: unknown,
  range: { min: number; max: number }
): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(range.max, Math.max(range.min, v))
    : undefined;

// Parse a persisted blob back into a valid state. Anything missing
// or out of range is dropped rather than trusted — a stored value
// from an older build (or hand-edited storage) must never be able
// to put the viewer into a state it can't render. Undefined keys
// are stripped so `modified` doesn't report true for an override
// object full of nothing.
export function parseLighting(raw: string | null): ViewerLighting {
  if (!raw) return DEFAULT_LIGHTING;
  try {
    const p = JSON.parse(raw) as Partial<ViewerLighting>;
    const overrides: Record<string, ModeOverride> = {};

    for (const mode of VIEWER_MODES) {
      const src = p.overrides?.[mode.id];
      if (!src || typeof src !== 'object') continue;
      const next: ModeOverride = {};
      const exposure = clamp(src.exposure, EXPOSURE_RANGE);
      if (exposure !== undefined) next.exposure = exposure;
      const si = clamp(src.shadowIntensity, SHADOW_INTENSITY_RANGE);
      if (si !== undefined) next.shadowIntensity = si;
      const ss = clamp(src.shadowSoftness, SHADOW_SOFTNESS_RANGE);
      if (ss !== undefined) next.shadowSoftness = ss;
      if (typeof src.dark === 'boolean') next.dark = src.dark;
      if (typeof src.skybox === 'boolean') next.skybox = src.skybox;
      if (Object.keys(next).length > 0) overrides[mode.id] = next;
    }

    return { modeId: modeById(p.modeId).id, overrides };
  } catch {
    return DEFAULT_LIGHTING;
  }
}
