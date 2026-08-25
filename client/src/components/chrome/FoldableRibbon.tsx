import type { Posture } from '../../lib/posture';
import { DesktopRibbon, type DesktopRibbonProps } from './DesktopRibbon';

interface FoldableRibbonProps extends DesktopRibbonProps {
  posture: Posture;
}

/**
 * Foldable presentation boundary for the shared desktop command implementation.
 *
 * Book posture measures DesktopRibbon inside the primary viewport segment so
 * its tabs, groups, overflow decisions, and command hit targets stop before the
 * physical hinge. The empty companion and hinge tracks make that geometry
 * explicit without cloning the registry projection or command runtime.
 */
export function FoldableRibbon({ posture, ...props }: FoldableRibbonProps) {
  return (
    <div
      className="foldable-ribbon"
      data-fold-shell={posture.shell}
      data-fold-hinge={posture.hinge}
    >
      <div className="foldable-ribbon-primary">
        <DesktopRibbon {...props} />
      </div>
      <div className="foldable-ribbon-hinge" aria-hidden="true" />
      <div className="foldable-ribbon-companion" aria-hidden="true" />
    </div>
  );
}
