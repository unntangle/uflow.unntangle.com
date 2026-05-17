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
    mv.setAttribute('shadow-intensity', '1');
    mv.setAttribute('exposure', '1');
    mv.className = 'crm-model-viewer';
    mv.style.width = '100%';
    mv.style.height = `${height}px`;
    mv.style.display = 'block';

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
    let attempts = 0;
    const intervalId = setInterval(() => {
      injectShadowStyle();
      if (++attempts > 10 || (mv && mv.shadowRoot && mv.shadowRoot.querySelector('#high-vis-cursor-style'))) {
        clearInterval(intervalId);
      }
    }, 100);

    container.innerHTML = '';
    container.appendChild(mv);

    return () => {
      container.innerHTML = '';
      if (intervalId) clearInterval(intervalId);
    };
  }, [src, alt, height]);

  return <div ref={containerRef} style={{ height }} />;
}
