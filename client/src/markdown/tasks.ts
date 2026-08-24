const TASK_LINE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/u;

export interface TaskMarker {
  from: number;
  checked: boolean;
}

/** Locate a rendered task's marker inside the renderer's exact source span. */
export function taskMarkerAt(
  source: string,
  sourceStart: number,
  sourceEnd: number,
  ordinal: number,
): TaskMarker | null {
  if (
    !Number.isSafeInteger(sourceStart) ||
    !Number.isSafeInteger(sourceEnd) ||
    !Number.isSafeInteger(ordinal) ||
    sourceStart < 0 ||
    sourceEnd < sourceStart ||
    sourceEnd > source.length ||
    ordinal < 0
  ) {
    return null;
  }

  let lineOffset = 0;
  let seen = 0;
  for (const line of source.slice(sourceStart, sourceEnd).split('\n')) {
    const match = TASK_LINE.exec(line);
    if (match) {
      if (seen === ordinal) {
        return {
          from: sourceStart + lineOffset + match[1].length + 1,
          checked: match[2] !== ' ',
        };
      }
      seen += 1;
    }
    lineOffset += line.length + 1;
  }
  return null;
}
