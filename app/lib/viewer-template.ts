// ============================================================
// Viewer page template
// ============================================================
// Produces the standalone HTML page served at
//   officemate.unntangle.com/<slug>/
// for a published project. The page hosts a <model-viewer>
// pointed at the colocated .glb file plus a standard control
// strip (rotate / reset / zoom / fullscreen).
//
// The template mirrors the original hand-built viewer at
//   public/officemate/jupiter/index.html
// almost line-for-line. The only differences are:
//   - the document <title> and the model alt-text interpolate
//     the project name
//   - the <model-viewer src> and the loader-overlay <img src>
//     interpolate the slug-based asset paths
//   - the logo path stays at /officemate/<slug>/officemate-logo.webp
//     so each published folder is self-contained (the publish
//     step copies the logo in alongside the GLB)
//
// Keeping a single source of truth for the page means future
// styling updates only touch this file, not every published
// folder. Republishing rewrites index.html so old pages catch
// up to the latest template on the next approval.
// ============================================================

export function renderViewerHtml(opts: {
  slug: string;
  projectName: string;
  glbFilename: string;
}): string {
  const { slug, projectName, glbFilename } = opts;

  // Every public path under /officemate/<slug>/ — the host
  // (officemate.unntangle.com) maps its root to this folder via
  // a rewrite, so the model-viewer src is just /<slug>/<file>.
  //
  // We escape the project name for safe interpolation into the
  // <title>, meta description, and alt attribute. The slug is
  // already URL-safe by construction (a-z, 0-9, hyphens) so it
  // doesn't need escaping in URLs.
  const safeName = escapeHtml(projectName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OfficeMate \u2014 ${safeName} 3D Preview</title>
  <meta name="description" content="Interactive 360\u00b0 3D model preview of ${safeName} by OfficeMate">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">

  <!-- Model Viewer -->
  <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>

  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #ffffff;
      overflow: hidden;
      height: 100vh;
      width: 100vw;
    }
    model-viewer {
      width: 100vw;
      height: 100vh;
      background: #ffffff;
      --poster-color: #ffffff;
      outline: none;
    }

    .loading-overlay {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: #ffffff; z-index: 10;
      transition: opacity 0.5s ease;
    }
    .loading-overlay.loaded { opacity: 0; pointer-events: none; }
    .loader-logo {
      width: 56px; height: 56px;
      border-radius: 12px;
      margin-bottom: 24px;
      animation: pulse 1.8s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.95); }
    }
    .progress-track { width: 200px; height: 3px; background: #f0f0f0; border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; width: 0%; background: #333; border-radius: 3px; transition: width 0.3s ease; }
    .loader-text { margin-top: 14px; font-size: 12px; color: #999; letter-spacing: 0.3px; }

    .logo {
      position: fixed; top: 4px; left: 24px;
      z-index: 20;
      height: 72px; width: auto;
      pointer-events: none;
    }

    .controls {
      position: fixed; right: 24px; top: 50%;
      transform: translateY(-50%); z-index: 20;
      display: flex; flex-direction: column;
      align-items: center; gap: 4px;
      padding: 10px 6px;
      background: rgba(255, 255, 255, 0.9);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 14px;
      box-shadow: 0 2px 20px rgba(0, 0, 0, 0.08);
    }
    .ctrl-btn {
      display: flex; align-items: center; justify-content: center;
      width: 38px; height: 38px;
      border: none; background: transparent;
      color: #666;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }
    .ctrl-btn:hover { background: rgba(0, 209, 255, 0.1); color: #00d1ff; }
    .ctrl-btn.active { background: #00d1ff; color: #fff; }
    .ctrl-btn svg { width: 18px; height: 18px; }
    .ctrl-sep { width: 20px; height: 1px; background: #e8e8e8; margin: 0 4px; }
    .ctrl-btn .tip {
      position: absolute; bottom: 46px; left: 50%;
      transform: translateX(-50%) translateY(4px);
      padding: 5px 9px;
      background: #111; color: #fff;
      border-radius: 6px;
      font-size: 11px;
      white-space: nowrap;
      opacity: 0; visibility: hidden;
      transition: all 0.15s ease;
      pointer-events: none;
    }
    .ctrl-btn:hover .tip {
      opacity: 1; visibility: visible;
      transform: translateX(-50%) translateY(0);
    }

    @media (max-width: 640px) {
      .logo { height: 48px; top: 8px; left: 16px; }
      .controls {
        right: auto; top: auto; bottom: 16px;
        left: 50%; transform: translateX(-50%);
        flex-direction: row;
        padding: 6px 10px;
        gap: 4px;
      }
      .ctrl-btn { width: 34px; height: 34px; }
      .ctrl-sep { width: 1px; height: 20px; }
      .ctrl-btn .tip { display: none; }
    }
  </style>
</head>
<body>

  <img src="/${slug}/officemate-logo.webp" alt="OfficeMate" class="logo">

  <model-viewer id="viewer"
    src="/${slug}/${glbFilename}"
    alt="${safeName} 3D Model"
    auto-rotate auto-rotate-delay="0"
    rotation-per-second="30deg"
    camera-controls touch-action="pan-y"
    interaction-prompt="none"
    shadow-intensity="1" shadow-softness="1"
    exposure="1" environment-image="neutral"
    camera-orbit="45deg 75deg auto"
    min-camera-orbit="auto auto 5%"
    max-camera-orbit="auto auto 300%"
    interpolation-decay="100">
    <div class="loading-overlay" slot="poster" id="loadingOverlay">
      <img src="/${slug}/officemate-logo.webp" alt="Loading" class="loader-logo">
      <div class="progress-track">
        <div class="progress-fill" id="progressBar"></div>
      </div>
      <p class="loader-text" id="loaderText">Loading 3D model\u2026</p>
    </div>
  </model-viewer>

  <div class="controls">
    <button class="ctrl-btn active" id="btnRotate" aria-label="Auto rotate">
      <span class="tip">Auto Rotate</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
      </svg>
    </button>
    <div class="ctrl-sep"></div>
    <button class="ctrl-btn" id="btnReset" aria-label="Reset view">
      <span class="tip">Reset View</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
      </svg>
    </button>
    <button class="ctrl-btn" id="btnZoomIn" aria-label="Zoom in">
      <span class="tip">Zoom In</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        <line x1="11" y1="8" x2="11" y2="14"/>
        <line x1="8" y1="11" x2="14" y2="11"/>
      </svg>
    </button>
    <button class="ctrl-btn" id="btnZoomOut" aria-label="Zoom out">
      <span class="tip">Zoom Out</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        <line x1="8" y1="11" x2="14" y2="11"/>
      </svg>
    </button>
    <div class="ctrl-sep"></div>
    <button class="ctrl-btn" id="btnFullscreen" aria-label="Fullscreen">
      <span class="tip">Fullscreen</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 3 21 3 21 9"/>
        <polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/>
        <line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
    </button>
  </div>

  <script>
    const viewer = document.getElementById('viewer');
    const progressBar = document.getElementById('progressBar');
    const loaderText = document.getElementById('loaderText');
    const loadingOverlay = document.getElementById('loadingOverlay');

    viewer.addEventListener('progress', (e) => {
      const pct = Math.round(e.detail.totalProgress * 100);
      progressBar.style.width = pct + '%';
      loaderText.textContent = 'Loading\u2026 ' + pct + '%';
    });
    viewer.addEventListener('load', () => {
      progressBar.style.width = '100%';
      loaderText.textContent = 'Ready';
      setTimeout(() => loadingOverlay.classList.add('loaded'), 300);
    });

    const btnRotate = document.getElementById('btnRotate');
    let rotating = true;
    btnRotate.addEventListener('click', () => {
      rotating = !rotating;
      rotating ? viewer.setAttribute('auto-rotate', '') : viewer.removeAttribute('auto-rotate');
      btnRotate.classList.toggle('active', rotating);
    });

    document.getElementById('btnReset').addEventListener('click', () => {
      viewer.cameraOrbit = '45deg 75deg auto';
      viewer.cameraTarget = 'auto auto auto';
      viewer.fieldOfView = 'auto';
      viewer.jumpCameraToGoal();
    });

    document.getElementById('btnZoomIn').addEventListener('click', () => {
      const o = viewer.getCameraOrbit();
      o.radius *= 0.75;
      viewer.cameraOrbit = o.theta + 'rad ' + o.phi + 'rad ' + o.radius + 'm';
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      const o = viewer.getCameraOrbit();
      o.radius *= 1.3;
      viewer.cameraOrbit = o.theta + 'rad ' + o.phi + 'rad ' + o.radius + 'm';
    });

    const btnFs = document.getElementById('btnFullscreen');
    btnFs.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
        btnFs.classList.add('active');
      } else {
        document.exitFullscreen();
        btnFs.classList.remove('active');
      }
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) btnFs.classList.remove('active');
    });
  </script>
</body>
</html>
`;
}

// Minimal HTML escape for the interpolated text fields. We control
// the slug (URL-safe by construction), but the project name comes
// from user input and could contain quotes or angle brackets.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
