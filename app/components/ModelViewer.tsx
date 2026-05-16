'use client';

import { useEffect, useRef } from 'react';

// ============================================================
// Wraps Google's <model-viewer> web component for GLB preview.
// We create the element imperatively (via the DOM API) rather
// than as JSX so TypeScript never needs to resolve the custom
// element type — the build error goes away completely.
// ============================================================

type Props = {
  src: string;
  alt?: string;
  height?: number;
};

export default function ModelViewer({ src, alt, height = 380 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
    mv.setAttribute('auto-rotate', '');
    mv.setAttribute('shadow-intensity', '1');
    mv.setAttribute('exposure', '1');
    mv.className = 'crm-model-viewer';
    mv.style.width = '100%';
    mv.style.height = `${height}px`;
    mv.style.display = 'block';

    container.innerHTML = '';
    container.appendChild(mv);

    return () => {
      container.innerHTML = '';
    };
  }, [src, alt, height]);

  return <div ref={containerRef} style={{ height }} />;
}
