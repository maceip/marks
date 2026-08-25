export type IconActivationLayer = 'action' | 'halo' | 'beam' | 'particle';

interface IconMotionTrack {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

interface IconParticleMotionTrack extends IconMotionTrack {
  staggerMs: number;
}

interface IconActivationMotionRecipe {
  full: {
    action: IconMotionTrack;
    halo: IconMotionTrack;
    beam: IconMotionTrack;
    particle: IconParticleMotionTrack;
  };
  reduced: {
    halo: IconMotionTrack;
    beam: IconMotionTrack;
  };
}

export interface IconActivationStep extends IconMotionTrack {
  layer: IconActivationLayer;
  particleIndex?: number;
}

const EMPHASIZED_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';
const SWIFT_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/**
 * The single animation recipe used by every interactive Marks icon. Keeping
 * the keyframes and timing together makes motion changes catalog-wide rather
 * than renderer-specific.
 */
export const ICON_ACTIVATION_MOTION: IconActivationMotionRecipe = {
  full: {
    action: {
      keyframes: [
        { transform: 'translate3d(0, 0, 0) scale(1)' },
        { transform: 'translate3d(0, 1px, 0) scale(0.93)', offset: 0.2 },
        { transform: 'translate3d(0, -1px, 0) scale(1.06)', offset: 0.56 },
        { transform: 'translate3d(0, 0, 0) scale(0.985)', offset: 0.78 },
        { transform: 'translate3d(0, 0, 0) scale(1)' },
      ],
      options: { duration: 300, easing: EMPHASIZED_EASING },
    },
    halo: {
      keyframes: [
        { opacity: 0, transform: 'scale(0.64)' },
        { opacity: 0.72, transform: 'scale(0.9)', offset: 0.24 },
        { opacity: 0, transform: 'scale(1.28)' },
      ],
      options: { duration: 360, easing: EMPHASIZED_EASING },
    },
    beam: {
      keyframes: [
        { opacity: 0, transform: 'translate3d(-155%, 12%, 0) rotate(-24deg) scaleY(0.78)' },
        { opacity: 0.94, transform: 'translate3d(-82%, 5%, 0) rotate(-24deg) scaleY(1)', offset: 0.22 },
        { opacity: 0.62, transform: 'translate3d(74%, -5%, 0) rotate(-24deg) scaleY(1.08)', offset: 0.72 },
        { opacity: 0, transform: 'translate3d(155%, -12%, 0) rotate(-24deg) scaleY(0.84)' },
      ],
      options: { duration: 330, easing: SWIFT_EASING },
    },
    particle: {
      keyframes: [
        { opacity: 0, transform: 'translate3d(0, 0, 0) scale(0.3)' },
        { opacity: 0.96, offset: 0.18 },
        { opacity: 0, transform: 'translate3d(var(--icon-particle-x), var(--icon-particle-y), 0) scale(0.15)' },
      ],
      options: { duration: 320, easing: SWIFT_EASING },
      staggerMs: 18,
    },
  },
  reduced: {
    halo: {
      keyframes: [{ opacity: 0 }, { opacity: 0.62, offset: 0.42 }, { opacity: 0 }],
      options: { duration: 180, easing: 'ease-out' },
    },
    beam: {
      keyframes: [{ opacity: 0 }, { opacity: 0.68, offset: 0.46 }, { opacity: 0 }],
      options: { duration: 180, easing: 'ease-out' },
    },
  },
};

function step(layer: IconActivationLayer, track: IconMotionTrack): IconActivationStep {
  return { layer, keyframes: track.keyframes, options: { ...track.options } };
}

/** Produces the runtime animation workload without requiring DOM access. */
export function createIconActivationPlan(reduced: boolean, particleCount: number): IconActivationStep[] {
  if (!Number.isSafeInteger(particleCount) || particleCount < 0) {
    throw new RangeError('particleCount must be a non-negative integer');
  }

  if (reduced) {
    return [
      step('halo', ICON_ACTIVATION_MOTION.reduced.halo),
      step('beam', ICON_ACTIVATION_MOTION.reduced.beam),
    ];
  }

  const { action, halo, beam, particle } = ICON_ACTIVATION_MOTION.full;
  return [
    step('action', action),
    step('halo', halo),
    step('beam', beam),
    ...Array.from({ length: particleCount }, (_, particleIndex): IconActivationStep => ({
      layer: 'particle',
      particleIndex,
      keyframes: particle.keyframes,
      options: {
        ...particle.options,
        delay: particleIndex * particle.staggerMs,
      },
    })),
  ];
}
