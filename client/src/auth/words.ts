const WORD_PATTERN = /^[a-z]+(?:\s+[a-z]+){3}$/u;

/** Canonical four-word pairing phrase. Rejects counts other than four. */
export function normalizePairingWords(input: string): string | null {
  const words = input
    .split(/[^A-Za-z]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length !== 4) return null;
  const canonical = words.join(' ');
  return WORD_PATTERN.test(canonical) ? canonical : null;
}
