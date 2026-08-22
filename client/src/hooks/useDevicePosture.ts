import { useEffect, useState } from 'react';
import {
  classifyPosture,
  isShell,
  postureCssVars,
  type Posture,
  type ViewportSegment,
} from '../lib/posture';

interface ViewportSegmentsRoot {
  viewport?: { segments?: ArrayLike<ViewportSegment> };
}

interface DevicePostureRoot {
  devicePosture?: { type?: string; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void };
}

function readOverride(): Posture['shell'] | null {
  try {
    const query = new URLSearchParams(location.search).get('marks-posture');
    if (isShell(query)) {
      sessionStorage.setItem('marks:posture-override', query);
      return query;
    }
    const stored = sessionStorage.getItem('marks:posture-override');
    return isShell(stored) ? stored : null;
  } catch {
    return null;
  }
}

function readSegments(): ViewportSegment[] | undefined {
  const viewport = (window as Window & ViewportSegmentsRoot).viewport;
  const segments = viewport?.segments;
  if (!segments || segments.length === 0) return undefined;
  return Array.from(segments, (segment) => ({
    x: segment.x,
    y: segment.y,
    width: segment.width,
    height: segment.height,
  }));
}

function readFoldState(): 'continuous' | 'folded' | undefined {
  const type = (navigator as Navigator & DevicePostureRoot).devicePosture?.type;
  return type === 'folded' || type === 'continuous' ? type : undefined;
}

function media(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

export function readDevicePosture(): Posture {
  return classifyPosture({
    width: innerWidth,
    height: innerHeight,
    coarse: media('(pointer: coarse)'),
    segments: readSegments(),
    devicePosture: readFoldState(),
    visualViewportHeight: visualViewport?.height ?? innerHeight,
    spanningHorizontal:
      media('(horizontal-viewport-segments: 2)') || media('(spanning: single-fold-vertical)'),
    spanningVertical:
      media('(vertical-viewport-segments: 2)') || media('(spanning: single-fold-horizontal)'),
    override: readOverride(),
  });
}

export function useDevicePosture(): Posture {
  const [posture, setPosture] = useState(readDevicePosture);

  useEffect(() => {
    const update = () => setPosture(readDevicePosture());
    const queries = [
      matchMedia('(pointer: coarse)'),
      matchMedia('(horizontal-viewport-segments: 2)'),
      matchMedia('(vertical-viewport-segments: 2)'),
      matchMedia('(max-width: 720px)'),
      matchMedia('(max-width: 1099px)'),
      matchMedia('(max-height: 560px)'),
    ];

    window.addEventListener('resize', update);
    visualViewport?.addEventListener('resize', update);
    visualViewport?.addEventListener('scroll', update);
    const postureApi = (navigator as Navigator & DevicePostureRoot).devicePosture;
    postureApi?.addEventListener?.('change', update);
    for (const query of queries) query.addEventListener('change', update);
    update();

    return () => {
      window.removeEventListener('resize', update);
      visualViewport?.removeEventListener('resize', update);
      visualViewport?.removeEventListener('scroll', update);
      postureApi?.removeEventListener?.('change', update);
      for (const query of queries) query.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.shell = posture.shell;
    root.dataset.hinge = posture.hinge;
    root.dataset.keyboard = posture.keyboardOpen ? 'open' : 'closed';
    for (const [name, value] of Object.entries(postureCssVars(posture))) {
      root.style.setProperty(name, value);
    }
  }, [posture]);

  return posture;
}
