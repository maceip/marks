import { useEffect, useRef, type CSSProperties } from 'react';
import { materialVariables, type MaterialModifier } from '../../design-system/materials';
import type { SurfaceMaterialOptions, SurfaceMaterialVariant } from '../../surface/renderer';

interface SurfaceMaterialProps {
  variant?: SurfaceMaterialVariant;
  modifier?: MaterialModifier;
}

/** CSS paints the complete material immediately; the shader enhances it after
 * the first responsive frame and stays out of the critical app path. */
export function SurfaceMaterial({
  variant = 'panel',
  modifier = 'standard',
}: SurfaceMaterialProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host || document.documentElement.dataset.surfaceEngine === 'css') return;

    const variables = materialVariables(variant, modifier);
    host.dataset.material = variant;
    for (const [property, value] of Object.entries(variables)) host.style.setProperty(property, value);

    let disposed = false;
    let detach: (() => void) | undefined;
    let timer = 0;
    let idleHandle: number | undefined;
    const options: SurfaceMaterialOptions = { variant, modifier };

    const start = () => {
      void import('../../surface/renderer').then(({ attachSurfaceMaterial }) => {
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
      delete host.dataset.material;
      for (const property of Object.keys(variables)) host.style.removeProperty(property);
    };
  }, [modifier, variant]);

  return (
    <canvas
      ref={canvasRef}
      className={`surface-material-canvas surface-material-${variant}`}
      aria-hidden="true"
      data-material={variant}
      style={materialVariables(variant, modifier) as CSSProperties}
    />
  );
}
