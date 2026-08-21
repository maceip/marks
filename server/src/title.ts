const MAX_TITLE = 120;

/**
 * Derive a document title from its markdown source.
 *
 * The server owns titles so that every client agrees on them without an extra
 * round of coordination: whoever persists the document also recomputes it.
 */
export function deriveTitle(markdown: string): string {
  const lines = markdown.split('\n', 400);

  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) return clean(heading[1]);
  }
  for (const line of lines) {
    if (line.trim()) return clean(line);
  }
  return 'Untitled';
}

function clean(raw: string): string {
  const text = raw
    .replace(/^#+\s*/, '')
    .replace(/[*_`~]/g, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  if (!text) return 'Untitled';
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text;
}
