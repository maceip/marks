import { useEffect, useRef } from 'react';
import type { SurfaceMaterialOptions, SurfaceMaterialVariant } from '../surface/renderer';

interface SurfaceMaterialProps {
  variant?: SurfaceMaterialVariant;
  intensity?: number;
}

/** CSS paints the complete material immediately; the shader enhances it after
 * the first responsive frame and stays out of the critical app path. */
export function SurfaceMaterial({
  variant = 'panel',
  intensity = 1,
}: SurfaceMaterialProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host || document.documentElement.dataset.surfaceEngine === 'css') return;

    let disposed = false;
    let detach: (() => void) | undefined;
    let timer = 0;
    let idleHandle: number | undefined;
    const options: SurfaceMaterialOptions = { variant, intensity };

    const start = () => {
      void import('../surface/renderer').then(({ attachSurfaceMaterial }) => {
        if (disposed) return;
        detach = attachSurfaceMaterial(canvas, host, options);
      });
    };

    if ('requestIdleCallback' in window) {
      idleHandle = window.requestIdleCallback(start, { timeout: 420 });
    } else {
      timer = setTimeout(start, 48);
    }

    return () => {
      disposed = true;
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
      if (timer) window.clearTimeout(timer);
      detach?.();
    };
  }, [intensity, variant]);

  return (
    <canvas
      ref={canvasRef}
      className={`surface-material-canvas surface-material-${variant}`}
      aria-hidden="true"
    />
  );
}
