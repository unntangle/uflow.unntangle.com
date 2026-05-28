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

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import ModelViewer from '../../../../components/ModelViewer';

export default function ModelViewerPage({
  name,
  clientName,
  revisionCount,
  glbUrl,
}: {
  name: string;
  clientName: string;
  revisionCount: number;
  glbUrl: string | null;
}) {
  // Esc closes the tab (best-effort — window.close() only works on
  // tabs the script opened, which is the case here since the review
  // page opens this via target="_blank"/window.open). We fall back
  // to history.back() for tabs the browser won't let us close.
  const [canClose, setCanClose] = useState(false);
  useEffect(() => {
    // window.opener is set when this tab was opened by another tab,
    // which is the path we expect ("View model" link). Only then is
    // window.close() reliably allowed.
    setCanClose(typeof window !== 'undefined' && !!window.opener);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeTab();
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
        background: 'linear-gradient(180deg, #fafafa, #ededed)',
        overflow: 'hidden',
      }}
    >
      {/* Floating header — name + revision on the left, close on
          the right. Sits over the model with a subtle backdrop so
          text stays legible against light model backgrounds. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '14px 18px',
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0))',
          pointerEvents: 'none',
        }}
      >
        <div style={{ minWidth: 0, pointerEvents: 'auto' }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: '#0a0a0a',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </div>
          <div style={{ fontSize: 12, color: '#525252', marginTop: 2 }}>
            {clientName ? `${clientName} · ` : ''}Revision {revisionCount}
          </div>
        </div>

        <button
          type="button"
          onClick={closeTab}
          title={canClose ? 'Close (Esc)' : 'Back (Esc)'}
          aria-label="Close viewer"
          style={{
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid #d4d4d4',
            borderRadius: 8,
            color: '#0a0a0a',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>Close</span>
        </button>
      </div>

      {/* The model itself, filling the whole viewport. ModelViewer
          takes a CSS height string, so '100vh' makes it fill the
          window; its own background gradient matches the wrapper. */}
      {glbUrl ? (
        <ModelViewer src={glbUrl} alt={`${name} 3D model`} height="100vh" />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#525252',
            textAlign: 'center',
            padding: 24,
          }}
        >
          <h3 style={{ color: '#0a0a0a', margin: '0 0 8px', fontSize: 16 }}>
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
            color: '#737373',
            pointerEvents: 'none',
          }}
        >
          Drag to rotate · scroll to zoom · right-click to pan
        </div>
      )}
    </div>
  );
}
