export interface KeyTipTarget {
  id: string;
  label: string;
  preferred?: string;
}

export function assignKeyTips(targets: readonly KeyTipTarget[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const target of targets) {
    const candidates = candidatesFor(target);
    let tip = candidates.find((candidate) => !used.has(candidate));
    if (!tip) {
      const stem = candidates[0] ?? 'X';
      let suffix = 2;
      while (used.has(`${stem}${suffix}`)) suffix += 1;
      tip = `${stem}${suffix}`;
    }
    used.add(tip);
    assigned.set(target.id, tip);
  }
  return assigned;
}

function candidatesFor(target: KeyTipTarget): string[] {
  const preferred = target.preferred?.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const words = target.label.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const letters = words.join('');
  const candidates = [
    preferred,
    ...words.map((word) => word[0]),
    ...letters.split(''),
    ...words.flatMap((word) => [...word].map((letter) => `${word[0]}${letter}`)),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}
