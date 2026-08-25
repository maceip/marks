export const DOCUMENT_ANALYSIS_TIMEOUT_MS = 15_000;

export interface AnalysisDeadline {
  arm(): void;
  clear(): void;
}

/** A resettable hard deadline for one outstanding worker analysis. */
export function createAnalysisDeadline(
  onTimeout: () => void,
  timeoutMs = DOCUMENT_ANALYSIS_TIMEOUT_MS,
): AnalysisDeadline {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    arm(): void {
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => {
        timer = null;
        onTimeout();
      }, timeoutMs);
    },
    clear(): void {
      if (timer === null) return;
      globalThis.clearTimeout(timer);
      timer = null;
    },
  };
}
