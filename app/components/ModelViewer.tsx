'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

// ============================================================
// Wraps Google's <model-viewer> web component for GLB preview.
// We create the element imperatively (via the DOM API) rather
// than as JSX so TypeScript never needs to resolve the custom
// element type — the build error goes away completely.
// ============================================================

type Props = {
  src: string;
  alt?: string;
  // Height of the viewer. A number is treated as pixels; a string
  // is used verbatim as a CSS length, so callers can pass
  // viewport-relative values like 'min(640px, 60vh)' to make the
  // viewer fit the screen vertically on large displays.
  height?: number | string;
  // When true, overlay a bounding-box dimension cage (W×H×D labels)
  // plus an XYZ axis gizmo anchored at the model's centre pivot.
  showDimensions?: boolean;
};

// Minimal shape of the <model-viewer> custom element for the camera
// methods the reset button drives. These members aren't on the base
// HTMLElement type, so we declare just the few we use rather than
// pulling in model-viewer's full type package.
type ModelViewerEl = HTMLElement & {
  getCameraOrbit: () => { theta: number; phi: number; radius: number };
  cameraOrbit: string;
  cameraTarget: string;
  fieldOfView: string;
  jumpCameraToGoal: () => void;
  getDimensions: () => { x: number; y: number; z: number };
  getBoundingBoxCenter: () => { x: number; y: number; z: number };
  updateHotspot: (config: { name: string; position?: string; normal?: string }) => void;
  queryHotspot: (
    name: string
  ) => { canvasPosition: { x: number; y: number; z: number }; facingCamera: boolean } | null;
};

// Imperative handle exposed to the parent (the full-screen page) so
// its header "Reset view" button can drive the camera that lives
// inside this component.
export type ModelViewerHandle = {
  resetView: () => void;
};

// Injects the overlay stylesheet once per document. Class names are
// prefixed crm- so they don't collide with app styles. model-viewer
// positions each hotspot's slot wrapper; the -50% transforms here are
// relative to that wrapper and just centre the dot / tip / label on
// its anchor point.
function injectDimStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('crm-dim-style')) return;
  const st = document.createElement('style');
  st.id = 'crm-dim-style';
  st.textContent = `
.crm-dim-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.crm-dim-line { stroke: #0a0a0a; stroke-width: 1.4; stroke-dasharray: 4 3; opacity: 0.6; }
.crm-axis-line { stroke-width: 2.4; }
.crm-axis-line-x { stroke: #e5484d; }
.crm-axis-line-y { stroke: #30a46c; }
.crm-axis-line-z { stroke: #0091ff; }
.crm-dim-dot { position: absolute; width: 1px; height: 1px; opacity: 0; padding: 0; margin: 0; border: 0; background: transparent; pointer-events: none; }
.crm-axis-dot { width: 9px; height: 9px; border-radius: 50%; background: #0a0a0a; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.25); transform: translate(-50%, -50%); padding: 0; pointer-events: none; }
.crm-axis-tip { font: 600 11px Inter, system-ui, sans-serif; color: #fff; border: 0; padding: 3px 8px; border-radius: 6px; white-space: nowrap; transform: translate(-50%, -50%); pointer-events: none; box-shadow: 0 1px 4px rgba(0,0,0,0.18); }
.crm-axis-tip-x { background: #e5484d; }
.crm-axis-tip-y { background: #30a46c; }
.crm-axis-tip-z { background: #0091ff; }
.crm-dim-label { font: 600 12px Inter, system-ui, sans-serif; color: #0a0a0a; background: rgba(255,255,255,0.92); border: 1px solid #d4d4d4; border-radius: 6px; padding: 2px 8px; white-space: nowrap; transform: translate(-50%, -50%); box-shadow: 0 1px 5px rgba(0,0,0,0.12); pointer-events: none; }
`;
  document.head.appendChild(st);
}

const ModelViewer = forwardRef<ModelViewerHandle, Props>(function ModelViewer(
  { src, alt, height = 380, showDimensions = true },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Loading feedback: `loaded` flips true on the model-viewer
  // 'load' event (overlay fades out then unmounts); `progress`
  // (0-100) is driven by model-viewer's 'progress' event so the
  // user sees a determinate bar while the GLB downloads instead
  // of a blank viewport.
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  // Live handle to the created <model-viewer> element so the reset
  // button (a React sibling) can drive its camera imperatively.
  const mvRef = useRef<ModelViewerEl | null>(null);
  // Lets a later effect toggle the dimensions/axis overlay without
  // tearing down and rebuilding the whole viewer. setVisible is wired
  // up once the overlay is built (after the model loads).
  const overlayRef = useRef<{ setVisible: (v: boolean) => void } | null>(null);
  // Latest showDimensions value, readable from inside the (stable)
  // load handler without adding it to the main effect's deps.
  const showDimsRef = useRef(showDimensions);
  // Camera orbit captured the first time the model frames itself on
  // load. "Reset view" returns here so it matches exactly how the
  // model first appeared. Recaptured per src (a different model gets
  // its own home position).
  const homeOrbitRef = useRef<string | null>(null);

  // Normalise the height prop to a CSS length string once, so both
  // the inner <model-viewer> element and the wrapper div use the
  // same value. Numbers become 'Npx'; strings pass through.
  const cssHeight = typeof height === 'number' ? `${height}px` : height;

  // Restore the camera to its initial framed position. Mirrors the
  // reset control in the published viewer template: snap the orbit
  // back to the captured home (falling back to model-viewer's
  // default front framing), re-centre the target, clear any
  // zoom-driven field-of-view change, then jump straight there.
  function resetView() {
    const el = mvRef.current;
    if (!el) return;
    el.cameraOrbit = homeOrbitRef.current ?? '45deg 75deg 120%';
    el.cameraTarget = 'auto auto auto';
    el.fieldOfView = 'auto';
    el.jumpCameraToGoal();
  }

  // Expose just resetView to the parent via its ref. resetView only
  // touches refs (stable across renders), so an empty dep list is safe.
  useImperativeHandle(ref, () => ({ resetView }), []);

  // Toggle the dimensions/axis overlay in place when the prop flips,
  // without rebuilding the viewer. No-op until the overlay is built.
  useEffect(() => {
    showDimsRef.current = showDimensions;
    overlayRef.current?.setVisible(showDimensions);
  }, [showDimensions]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // New mount or new src: forget any previously captured home so
    // the reset target is recaptured for the model we're about to show.
    homeOrbitRef.current = null;

    // New src means a fresh download: show the loading overlay again
    // from 0 until this model's 'load' fires.
    setLoaded(false);
    setProgress(0);

    // Inject the model-viewer script once per page.
    if (!document.querySelector('script[data-model-viewer]')) {
      const s = document.createElement('script');
      s.type = 'module';
      s.src =
        'https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';
      s.setAttribute('data-model-viewer', '');
      document.head.appendChild(s);
    }

    // Create the custom element imperatively — no JSX typing needed.
    const mv = document.createElement('model-viewer') as HTMLElement;
    mv.setAttribute('src', src);
    mv.setAttribute('alt', alt || '3D model preview');
    mv.setAttribute('camera-controls', '');
    // Start fetching the GLB immediately rather than waiting for the
    // element to be considered "in viewport" — this viewer always
    // fills the screen, so eager loading shaves the lazy-load delay.
    mv.setAttribute('loading', 'eager');
    // Default to a three-quarter view (instead of model-viewer's
    // straight-on front) so all three dimension axes are separated
    // and their W/H/L tooltips are visible on load. Slightly zoomed
    // out (120%) so the labels clear the viewport edges + header.
    mv.setAttribute('camera-orbit', '45deg 75deg 120%');
    mv.setAttribute('shadow-intensity', '1');
    mv.setAttribute('exposure', '1');
    // Camera-orbit bounds, given as "theta phi radius":
    //   phi 0deg..180deg — full vertical tilt so the underside (and
    //     top) of the model can be inspected. model-viewer's default
    //     "auto" clamps phi short of the poles, which is what blocked
    //     the full bottom view.
    //   radius 25%..200% — zoom range relative to the auto-framing
    //     distance (100% = default framed view): 25% closest in,
    //     200% furthest out.
    //   theta is left unbounded (auto) for a full 360° horizontal spin.
    // Tweak any of these to loosen/tighten that axis.
    mv.setAttribute('min-camera-orbit', 'auto 0deg 25%');
    mv.setAttribute('max-camera-orbit', 'auto 180deg 200%');
    mv.className = 'crm-model-viewer';
    mv.style.width = '100%';
    mv.style.height = cssHeight;
    mv.style.display = 'block';
    mvRef.current = mv as ModelViewerEl;

    // Inject high-visibility custom cursors inside the model-viewer shadow DOM
    // to bypass the internal canvas styling of the Web Component inside the CRM.
    function injectShadowStyle() {
      if (mv && mv.shadowRoot) {
        if (mv.shadowRoot.querySelector('#high-vis-cursor-style')) return;
        const shadowStyle = document.createElement('style');
        shadowStyle.id = 'high-vis-cursor-style';
        shadowStyle.textContent = "* { cursor: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJibGFjayIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIxLjUiPjxwYXRoIGQ9Ik00LjUgM3YxNS4yNWw0LjUtNC41IDIuNzUgNS41IDIuNS0xLjI1LTIuNzUtNS41IDUuMjUuMjVMNC41IDN6Ii8+PC9zdmc+'), default !important; }";
        mv.shadowRoot.appendChild(shadowStyle);
      }
    }

    injectShadowStyle();
    mv.addEventListener('load', injectShadowStyle);

    // Drive the loading overlay. 'progress' fires repeatedly with
    // totalProgress 0..1 as the GLB downloads + parses; 'load' fires
    // once when it's ready to render. We clamp to 100 on load so the
    // bar always completes even if the last progress tick was <1.
    mv.addEventListener('progress', (e) => {
      const detail = (e as unknown as CustomEvent<{ totalProgress?: number }>).detail;
      const pct = Math.round((detail?.totalProgress ?? 0) * 100);
      setProgress(pct);
    });
    mv.addEventListener('load', () => {
      setProgress(100);
      setLoaded(true);
    });

    // Capture the framed camera position the first time the model
    // loads; "Reset view" returns here. Stored in rad/m for an exact
    // round-trip with no auto re-framing surprises.
    mv.addEventListener('load', () => {
      if (homeOrbitRef.current) return;
      const o = (mv as ModelViewerEl).getCameraOrbit();
      homeOrbitRef.current = `${o.theta}rad ${o.phi}rad ${o.radius}m`;
    });
    let attempts = 0;
    const intervalId = setInterval(() => {
      injectShadowStyle();
      if (++attempts > 10 || (mv && mv.shadowRoot && mv.shadowRoot.querySelector('#high-vis-cursor-style'))) {
        clearInterval(intervalId);
      }
    }, 100);

    container.innerHTML = '';
    container.appendChild(mv);

    // --------------------------------------------------------------
    // Centre-pivot axis gizmo + dimension readouts
    // --------------------------------------------------------------
    // A small origin hotspot sits at the model's bottom centre with
    // three axis-tip hotspots (W/H/L). An SVG layer (unnamed slot, so
    // it floats above the canvas) draws the coloured axis lines
    // between their projected screen positions, redrawn on every
    // camera-change so the gizmo tracks the model. The W/H/L values
    // read straight from the GLB's bounding box.
    injectDimStyle();

    const SVGNS = 'http://www.w3.org/2000/svg';
    // Elements the toggle shows/hides. Corner anchors are excluded:
    // they stay in the DOM (invisible) so model-viewer keeps tracking
    // them for the line endpoints regardless of the toggle state.
    const toggleEls: HTMLElement[] = [];

    function makeHotspot(slot: string, cls: string, toggle: boolean, text?: string) {
      const b = document.createElement('button');
      b.setAttribute('slot', slot);
      b.className = cls;
      b.tabIndex = -1;
      if (text !== undefined) b.textContent = text;
      mv.appendChild(b);
      if (toggle) toggleEls.push(b);
      return b;
    }

    // The three axis tips double as the dimension readouts: each one
    // sits at the end of its coloured axis and shows that axis's size.
    makeHotspot('hotspot-ax-o', 'crm-axis-dot', true);
    const tipX = makeHotspot('hotspot-ax-x', 'crm-axis-tip crm-axis-tip-x', true);
    const tipY = makeHotspot('hotspot-ax-y', 'crm-axis-tip crm-axis-tip-y', true);
    const tipZ = makeHotspot('hotspot-ax-z', 'crm-axis-tip crm-axis-tip-z', true);

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'crm-dim-svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    mv.appendChild(svg);
    toggleEls.push(svg as unknown as HTMLElement);

    const axisLines = (['x', 'y', 'z'] as const).map((a) => {
      const l = document.createElementNS(SVGNS, 'line');
      l.setAttribute('class', `crm-axis-line crm-axis-line-${a}`);
      svg.appendChild(l);
      return l;
    });

    const fmt = (v: number) =>
      v < 2.5 ? `${(v * 100).toFixed(0)} cm` : `${v.toFixed(2)} m`;

    function setOverlayVisible(v: boolean) {
      toggleEls.forEach((el) => {
        el.style.display = v ? 'block' : 'none';
      });
    }
    overlayRef.current = { setVisible: setOverlayVisible };

    function setupDimensions() {
      const t = mv as ModelViewerEl;
      const c = t.getBoundingBoxCenter();
      const s = t.getDimensions();
      const y2 = s.y / 2;

      // Axis gizmo origin at the BOTTOM centre of the bounding box
      // (centred in X/Z, on the floor in Y) rather than the geometric
      // centre, so the tripod sits where the model rests. Each axis
      // tip carries that axis's dimension as its label.
      const ox = c.x;
      const oy = c.y - y2;
      const oz = c.z;
      const axisLen = Math.max(s.x, s.y, s.z) * 0.6 || 0.1;
      // Height label sits just above the very top of the model; W and
      // L sit a fixed distance out from the origin along their axes.
      const topY = c.y + y2 + Math.max(s.x, s.y, s.z) * 0.12;
      t.updateHotspot({ name: 'hotspot-ax-o', position: `${ox} ${oy} ${oz}` });
      t.updateHotspot({ name: 'hotspot-ax-x', position: `${ox + axisLen} ${oy} ${oz}` });
      t.updateHotspot({ name: 'hotspot-ax-y', position: `${ox} ${topY} ${oz}` });
      t.updateHotspot({ name: 'hotspot-ax-z', position: `${ox} ${oy} ${oz + axisLen}` });
      tipX.textContent = `W · ${fmt(s.x)}`;
      tipY.textContent = `H · ${fmt(s.y)}`;
      tipZ.textContent = `L · ${fmt(s.z)}`;

      setOverlayVisible(showDimsRef.current);
      renderOverlay();
    }

    // Draw each axis as a ray that extends to infinity in its
    // dimension-facing (positive) direction only. A straight 3D line
    // projects to a straight 2D line, so we take the origin and the
    // (near) tip screen points, derive the 2D direction, and shoot
    // the ray from the origin far past the viewport that way. Working
    // in screen space keeps it stable at every camera angle.
    const AXIS_EXTENT = 10000;
    function drawAxis(line: SVGLineElement, tipName: string) {
      const t = mv as ModelViewerEl;
      const o = t.queryHotspot('hotspot-ax-o');
      const tip = t.queryHotspot(tipName);
      if (!o || !tip) return;
      const x0 = o.canvasPosition.x;
      const y0 = o.canvasPosition.y;
      let dx = tip.canvasPosition.x - x0;
      let dy = tip.canvasPosition.y - y0;
      const len = Math.hypot(dx, dy);
      if (len < 0.0001) return;
      dx /= len;
      dy /= len;
      line.setAttribute('x1', String(x0));
      line.setAttribute('y1', String(y0));
      line.setAttribute('x2', String(x0 + dx * AXIS_EXTENT));
      line.setAttribute('y2', String(y0 + dy * AXIS_EXTENT));
    }

    function renderOverlay() {
      drawAxis(axisLines[0], 'hotspot-ax-x');
      drawAxis(axisLines[1], 'hotspot-ax-y');
      drawAxis(axisLines[2], 'hotspot-ax-z');
    }

    mv.addEventListener('load', setupDimensions);
    mv.addEventListener('camera-change', renderOverlay);
    // Handle a model that was already cached/loaded before this ran.
    if ((mv as unknown as { loaded?: boolean }).loaded) {
      setupDimensions();
      setProgress(100);
      setLoaded(true);
    }

    return () => {
      container.innerHTML = '';
      if (intervalId) clearInterval(intervalId);
      mvRef.current = null;
      overlayRef.current = null;
    };
  }, [src, alt, cssHeight]);

  return (
    <div style={{ position: 'relative', height: cssHeight }}>
      <div ref={containerRef} style={{ height: cssHeight }} />

      {/* Loading overlay. Visible until the model's 'load' event,
          then fades out. Kept mounted during the fade (opacity
          transition) and removed once fully loaded so it never
          intercepts pointer events on the live model. The bar is
          determinate while progress climbs, then completes on load. */}
      {!loaded && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: 'linear-gradient(180deg, #fafafa, #ededed)',
            pointerEvents: 'none',
            transition: 'opacity 0.4s ease',
            opacity: progress >= 100 ? 0 : 1,
          }}
        >
          <div style={{ width: 200, height: 4, background: '#e0e0e0', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: '#0a0a0a',
                borderRadius: 4,
                transition: 'width 0.2s ease',
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: '#737373', letterSpacing: '0.02em' }}>
            Loading 3D model… {progress}%
          </div>
        </div>
      )}
    </div>
  );
});

export default ModelViewer;
