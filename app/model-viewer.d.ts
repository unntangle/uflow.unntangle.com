import * as React from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          'camera-controls'?: boolean;
          'auto-rotate'?: boolean;
          'shadow-intensity'?: string | number;
          exposure?: string | number;
          ar?: boolean;
          poster?: string;
          'rotation-per-second'?: string;
          'auto-rotate-delay'?: string | number;
          'touch-action'?: string;
          'interaction-prompt'?: string;
          'shadow-softness'?: string | number;
          'environment-image'?: string;
          'camera-orbit'?: string;
          'min-camera-orbit'?: string;
          'max-camera-orbit'?: string;
          'interpolation-decay'?: string | number;
        },
        HTMLElement
      >;
    }
  }
}
