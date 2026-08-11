'use client';

// ============================================================
// ModelViewerPage — full-viewport GLB viewer
// ============================================================
// Renders the model filling the entire browser window. Opened in
// a new tab from the review pages, so there's no app chrome
// (sidebar etc.) — just the model plus a minimal floating header
// with the project name and the controls hint, and a close button.
//
// The ModelViewer component accepts a CSS height string, so we
// hand it '100vh' and let it fill the viewport. A thin gradient
// header floats over the top-left so the title doesn't eat into
// the model's space.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Palette, RotateCcw, Ruler, Sun, X } from 'lucide-react';
import ModelViewer, { type ModelViewerHandle } from '../../../../components/ModelViewer';
import {
  VIEWER_MODES,
  VIEWER_LIGHTING_KEY,
  DEFAULT_LIGHTING,
  EXPOSURE_RANGE,
  SHADOW_INTENSITY_RANGE,
  SHADOW_SOFTNESS_RANGE,
  resolveLighting,
  parseLighting,
  type ViewerLighting,
  type ModeOverride,
} from '../../../../lib/model-viewer-config';

// One colourway as the viewer needs it: enough to label the option
// and to swap the model without going back to the server.
export type ViewerVariant = {
  id: string;
  name: string;
  // The primary colourway stands for the product itself, so its
  // name is the product's name and the title doesn't repeat it.
  isPrimary: boolean;
  glbUrl: string | null;
  revisionCount: number;
};

export default function ModelViewerPage({
  projectName,
  clientName,
  variants,
  activeVariantId,
  fallbackGlbUrl,
  fallbackRevision,
}: {
  projectName: string;
  clientName: string;
  variants: ViewerVariant[];
  activeVariantId: string | null;
  fallbackGlbUrl: string | null;
  fallbackRevision: number;
}) {
  // Which colourway is on screen. Switching is entirely client-side
  // — every variant's GLB url is already in hand — so flipping
  // between them is instant apart from the model download itself.
  const [activeId, setActiveId] = useState<string | null>(activeVariantId);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Mirror of menuOpen readable from the (mount-once) key handler
  // without making it re-subscribe on every toggle.
  const menuOpenRef = useRef(false);
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  const active = variants.find((v) => v.id === activeId) ?? null;

  // Fall back to the product's own asset when there are no variant
  // rows at all (pre-migration data), so this route keeps working
  // exactly as it did before colourways existed.
  const glbUrl = active ? active.glbUrl : fallbackGlbUrl;
  const revisionCount = active ? active.revisionCount : fallbackRevision;
  // Only a non-primary colourway earns a suffix — the primary one
  // already carries the product's name, so appending it would read
  // as "Zenpro Grey · Zenpro Grey".
  const name =
    active && !active.isPrimary
      ? `${projectName} \u00b7 ${active.name}`
      : projectName;

  // Keep the URL in step with the visible colourway so a refresh,
  // bookmark, or copied link lands on the same model. replaceState
  // rather than a router push: this is a view toggle, not a
  // navigation, and it shouldn't stack history entries.
  function selectVariant(id: string) {
    setActiveId(id);
    setMenuOpen(false);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', id);
    window.history.replaceState(null, '', url.toString());
  }

  // Close the switcher on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Esc closes the tab (best-effort — window.close() only works on
  // tabs the script opened, which is the case here since the review
  // page opens this via target="_blank"/window.open). We fall back
  // to history.back() for tabs the browser won't let us close.
  const [canClose, setCanClose] = useState(false);
  // Handle to the viewer so the header's "Reset view" button can
  // snap the camera back to the model's initial framing.
  const viewerRef = useRef<ModelViewerHandle>(null);
  // Dimensions + axis-gizmo overlay toggle. On by default.
  const [showDims, setShowDims] = useState(true);

  // ---- Lighting ----
  // Always starts at the default so the server-rendered HTML and
  // the first client render agree; the stored setup is read in an
  // effect below. Initialising straight from localStorage would be
  // a hydration mismatch (the server has no way to know it).
  const [lighting, setLighting] = useState<ViewerLighting>(DEFAULT_LIGHTING);
  const [lightOpen, setLightOpen] = useState(false);
  const lightRef = useRef<HTMLDivElement>(null);
  const resolved = resolveLighting(lighting);
  // Chrome flips to light-on-dark whenever the backdrop is dark.
  const onDark = resolved.dark;

  useEffect(() => {
    try {
      setLighting(parseLighting(window.localStorage.getItem(VIEWER_LIGHTING_KEY)));
    } catch {
      // Private mode / storage disabled. The default is a perfectly
      // good fallback, so there's nothing to recover from.
    }
  }, []);

  // One writer for every control, so persistence can't be forgotten
  // on a control added later.
  function persist(next: ViewerLighting) {
    try {
      window.localStorage.setItem(VIEWER_LIGHTING_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal: the change still applies for this session.
    }
    return next;
  }

  // Adjustments are stored PER MODE. A brightness set while judging
  // metal would be wrong in the soft view, and resetting it on every
  // switch would throw away a setup the reviewer just dialled in —
  // so each mode keeps its own, and switching back restores it.
  function adjust(patch: ModeOverride) {
    setLighting((prev) =>
      persist({
        ...prev,
        overrides: {
          ...prev.overrides,
          [prev.modeId]: { ...(prev.overrides[prev.modeId] ?? {}), ...patch },
        },
      })
    );
  }

  function selectMode(modeId: string) {
    setLighting((prev) => persist({ ...prev, modeId }));
  }

  // Clears only the ACTIVE mode's adjustments, back to its designed
  // starting point. Deliberately not a global reset: wiping the
  // other mode's setup is never what "reset" means to someone
  // looking at one mode.
  function resetMode() {
    setLighting((prev) => {
      const next = { ...prev, overrides: { ...prev.overrides } };
      delete next.overrides[prev.modeId];
      return persist(next);
    });
  }

  // Close the lighting panel on an outside click, same as the
  // colourway switcher.
  useEffect(() => {
    if (!lightOpen) return;
    function onDown(e: MouseEvent) {
      if (!lightRef.current?.contains(e.target as Node)) setLightOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [lightOpen]);

  useEffect(() => {
    // window.opener is set when this tab was opened by another tab,
    // which is the path we expect ("View model" link). Only then is
    // window.close() reliably allowed.
    setCanClose(typeof window !== 'undefined' && !!window.opener);
    function onKey(e: KeyboardEvent) {
      // Esc closes the open switcher first, then the tab — so a
      // stray Esc while browsing colourways doesn't bounce the
      // reviewer out of the viewer entirely.
      if (e.key !== 'Escape') return;
      if (menuOpenRef.current) setMenuOpen(false);
      else closeTab();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function closeTab() {
    if (typeof window === 'undefined') return;
    // Try to close the tab; if the browser blocks it (no opener),
    // navigate back as a fallback.
    window.close();
    // window.close() is a no-op when not allowed; give it a tick,
    // then fall back to history if we're still here.
    setTimeout(() => {
      if (!window.closed) window.history.back();
    }, 120);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: resolved.backdrop,
        overflow: 'hidden',
        // Cross-fade rather than snap: a hard cut between light and
        // dark backdrops is jarring at full-viewport size.
        transition: 'background 0.25s ease',
      }}
    >
      {/* Floating title — name + revision, top-left. Sits over the
          model with a subtle backdrop so text stays legible against
          light model backgrounds. The controls live in their own
          vertical rail on the right (below). */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          padding: '14px 18px',
          paddingRight: 76,
          // The scrim fades from the backdrop's own colour, so the
          // title stays legible whichever preset is active.
          background: onDark
            ? 'linear-gradient(180deg, rgba(13,13,15,0.92), rgba(13,13,15,0))'
            : 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0))',
          pointerEvents: 'none',
        }}
      >
        <div style={{ minWidth: 0, pointerEvents: 'auto' }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: onDark ? '#fafafa' : '#0a0a0a',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </div>
          <div style={{ fontSize: 12, color: onDark ? '#a3a3a3' : '#525252', marginTop: 2 }}>
            {clientName ? `${clientName} · ` : ''}Revision {revisionCount}
          </div>
        </div>
      </div>

      {/* Control rail — pinned to the right edge. The colourway
          switcher and Close share the top row; the view controls
          stack vertically beneath, collapsed to icons that reveal
          their label on hover so they don't cover the model. */}
      <div className="crm-viewer-rail">
        {/* Top row: the colourway switcher sits as a full labelled
            pill (you need to read which colourway you're on without
            hovering), with Close beside it in red. */}
        <div className="crm-viewer-rail-row">
          {/* Only worth showing when there's more than one — a
              single-variant product would just be a dropdown with
              one option in it. */}
          {variants.length > 1 && (
            <div ref={menuRef} className="crm-viewer-rail-item">
              <button
                type="button"
                className={`crm-viewer-rail-select${menuOpen ? ' is-open' : ''}`}
                onClick={() => setMenuOpen((v) => !v)}
                title="Switch colourway"
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
              >
                <Palette size={15} strokeWidth={1.75} aria-hidden="true" />
                <span className="crm-viewer-rail-select-label">
                  {active?.name ?? 'Colourway'}
                </span>
                <ChevronDown
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="crm-viewer-rail-chevron"
                />
              </button>

              {menuOpen && (
                <div
                  className="crm-viewer-rail-menu"
                  role="listbox"
                  aria-label="Colourways"
                >
                  {variants.map((v) => {
                    const isActive = v.id === activeId;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onClick={() => selectVariant(v.id)}
                        className={`crm-viewer-rail-option${
                          isActive ? ' is-active' : ''
                        }`}
                      >
                        <span style={{ minWidth: 0 }}>
                          <span
                            style={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {v.name}
                          </span>
                          <span style={{ fontSize: 11, color: '#737373' }}>
                            {v.glbUrl
                              ? `Revision ${v.revisionCount}`
                              : 'No model yet'}
                          </span>
                        </span>
                        {isActive && (
                          <Check
                            size={14}
                            strokeWidth={2}
                            aria-hidden="true"
                            style={{ flexShrink: 0 }}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className="crm-viewer-rail-btn is-danger"
            onClick={closeTab}
            title={canClose ? 'Close (Esc)' : 'Back (Esc)'}
            aria-label="Close viewer"
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
            <span className="crm-viewer-rail-label">
              {canClose ? 'Close' : 'Back'}
            </span>
          </button>
        </div>

        {glbUrl && (
          <button
            type="button"
            className={`crm-viewer-rail-btn${showDims ? ' is-active' : ''}`}
            onClick={() => setShowDims((v) => !v)}
            title="Toggle dimensions & axis gizmo"
            aria-pressed={showDims}
          >
            <Ruler size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="crm-viewer-rail-label">Dimensions</span>
          </button>
        )}

        {glbUrl && (
          <div ref={lightRef} className="crm-viewer-rail-item">
            <button
              type="button"
              className={`crm-viewer-rail-btn${lightOpen ? ' is-active' : ''}`}
              onClick={() => setLightOpen((v) => !v)}
              title="Lighting"
              aria-haspopup="dialog"
              aria-expanded={lightOpen}
            >
              <Sun size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="crm-viewer-rail-label">{resolved.mode.label}</span>
            </button>

            {lightOpen && (
              <div
                className="crm-viewer-rail-menu"
                role="dialog"
                aria-label="Lighting controls"
                style={{ width: 268, padding: 12 }}
              >
                {/* ---- Review mode ---- */}
                {/* The two modes differ in their environment map,
                    which is what actually re-lights the model — the
                    map supplies both the diffuse light and every
                    specular reflection. See model-viewer-config. */}
                <div style={panelLabelStyle}>Mode</div>
                <div style={{ display: 'grid', gap: 2, marginBottom: 14 }}>
                  {VIEWER_MODES.map((m) => {
                    const isActive = m.id === resolved.mode.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => selectMode(m.id)}
                        className={`crm-viewer-rail-option${
                          isActive ? ' is-active' : ''
                        }`}
                        title={m.hint}
                      >
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block' }}>{m.label}</span>
                          <span
                            style={{
                              fontSize: 11,
                              color: '#737373',
                              display: 'block',
                              whiteSpace: 'normal',
                              lineHeight: 1.3,
                            }}
                          >
                            {m.hint}
                          </span>
                        </span>
                        {isActive && (
                          <Check
                            size={14}
                            strokeWidth={2}
                            aria-hidden="true"
                            style={{ flexShrink: 0 }}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* ---- Adjustments ---- */}
                {/* Sliders rather than more presets: "a bit less
                    blown out" is the actual note a reviewer has, and
                    no fixed preset lands on it. Each is remembered
                    against the mode it was set in. */}
                <div style={panelLabelStyle}>Adjustments</div>
                <SliderRow
                  label="Light intensity"
                  hint="How strongly the environment lights the model — soft fill and reflected highlights together."
                  value={resolved.exposure}
                  range={EXPOSURE_RANGE}
                  onChange={(v) => adjust({ exposure: v })}
                />
                <SliderRow
                  label="Shadow"
                  hint="Darkness of the contact shadow under the model."
                  value={resolved.shadowIntensity}
                  range={SHADOW_INTENSITY_RANGE}
                  onChange={(v) => adjust({ shadowIntensity: v })}
                />
                <SliderRow
                  label="Shadow blur"
                  hint="0 is a hard edge, 1 fully diffuse."
                  value={resolved.shadowSoftness}
                  range={SHADOW_SOFTNESS_RANGE}
                  onChange={(v) => adjust({ shadowSoftness: v })}
                />

                <div style={{ ...panelLabelStyle, marginTop: 12 }}>Backdrop</div>
                <label style={checkRowStyle}>
                  <input
                    type="checkbox"
                    checked={resolved.dark}
                    onChange={(e) => adjust({ dark: e.target.checked })}
                  />
                  <span>Dark background</span>
                </label>
                {/* Only offered where there's a photographic
                    environment to show — the built-in probe is
                    procedural and would render a flat grey void. */}
                {resolved.mode.allowSkybox && (
                  <label
                    style={checkRowStyle}
                    title="Show the environment behind the model, so you can see what the glossy surfaces are reflecting."
                  >
                    <input
                      type="checkbox"
                      checked={resolved.skybox}
                      onChange={(e) => adjust({ skybox: e.target.checked })}
                    />
                    <span>Show environment</span>
                  </label>
                )}

                <button
                  type="button"
                  onClick={resetMode}
                  disabled={!resolved.modified}
                  title={
                    resolved.modified
                      ? `Return ${resolved.mode.label} to its default settings`
                      : 'Nothing adjusted on this mode'
                  }
                  style={{
                    marginTop: 12,
                    width: '100%',
                    background: 'none',
                    border: '1px solid #e5e5e5',
                    borderRadius: 8,
                    padding: '6px 8px',
                    font: 'inherit',
                    fontSize: 12,
                    color: resolved.modified ? '#525252' : '#a3a3a3',
                    cursor: resolved.modified ? 'pointer' : 'default',
                  }}
                >
                  {resolved.modified
                    ? `Reset ${resolved.mode.label}`
                    : 'Default settings'}
                </button>
              </div>
            )}
          </div>
        )}

        {glbUrl && (
          <button
            type="button"
            className="crm-viewer-rail-btn"
            onClick={() => viewerRef.current?.resetView()}
            title="Reset view"
            aria-label="Reset view"
          >
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="crm-viewer-rail-label">Reset view</span>
          </button>
        )}
      </div>

      {/* The model itself, filling the whole viewport. ModelViewer
          takes a CSS height string, so '100vh' makes it fill the
          window; its own background gradient matches the wrapper. */}
      {glbUrl ? (
        <ModelViewer ref={viewerRef} src={glbUrl} alt={`${name} 3D model`} height="100vh" showDimensions={showDims} lighting={lighting} />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: onDark ? '#a3a3a3' : '#525252',
            textAlign: 'center',
            padding: 24,
          }}
        >
          <h3 style={{ color: onDark ? '#fafafa' : '#0a0a0a', margin: '0 0 8px', fontSize: 16 }}>
            No GLB uploaded
          </h3>
          <p style={{ margin: 0 }}>
            The artist hasn&apos;t uploaded a model for this project yet.
          </p>
        </div>
      )}

      {/* Controls hint — floating at the bottom center. */}
      {glbUrl && (
        <div
          style={{
            position: 'absolute',
            bottom: 14,
            left: 0,
            right: 0,
            textAlign: 'center',
            fontSize: 12,
            color: onDark ? '#a3a3a3' : '#737373',
            pointerEvents: 'none',
          }}
        >
          Drag to rotate · scroll to zoom · right-click to pan
        </div>
      )}
    </div>
  );
}

// ============================================================
// Lighting panel bits
// ============================================================
const panelLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#737373',
  marginBottom: 6,
};

const checkRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  padding: '4px 2px',
  cursor: 'pointer',
};

// A labelled slider with its live value. React's onChange on a
// range input fires on every drag tick, which is what makes the
// model re-light as the handle moves rather than only on release.
function SliderRow({
  label,
  hint,
  value,
  range,
  onChange,
  format,
}: {
  label: string;
  hint?: string;
  value: number;
  range: { min: number; max: number; step: number };
  onChange: (v: number) => void;
  // Overrides the readout. Used by Reflections, where a bare
  // "0.00" reads as "no reflections" rather than "unmodified".
  format?: (v: number) => string;
}) {
  return (
    <div style={{ marginBottom: 10 }} title={hint}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 12,
          color: '#525252',
          marginBottom: 2,
        }}
      >
        <span>{label}</span>
        <span style={{ color: '#a3a3a3', fontVariantNumeric: 'tabular-nums' }}>
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        style={{ width: '100%', display: 'block', accentColor: '#0a0a0a' }}
      />
    </div>
  );
}
