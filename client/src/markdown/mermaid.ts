type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let currentTheme: 'light' | 'dark' = 'light';
let counter = 0;

/** Rendered SVG by diagram source, so re-mounting a block never re-runs mermaid. */
const svgCache = new Map<string, string>();

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    // Mermaid is by far the heaviest renderer we ship; it stays out of the
    // initial bundle and only loads for documents that actually contain a diagram.
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: currentTheme === 'dark' ? 'dark' : 'default',
        // Mermaid measures label text to size each node, so it needs a
        // concrete font stack: `inherit` leaves it measuring against the wrong
        // metrics and the labels end up clipped.
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

export function setMermaidTheme(theme: 'light' | 'dark'): void {
  if (theme === currentTheme) return;
  currentTheme = theme;
  mermaidPromise = null;
  svgCache.clear();
}

/** Render every pending diagram inside `root`. */
export async function renderDiagrams(root: ParentNode): Promise<void> {
  const pending = root.querySelectorAll<HTMLElement>('.marks-mermaid[data-mermaid="pending"]');
  if (pending.length === 0) return;

  const mermaid = await getMermaid();

  await Promise.all(
    Array.from(pending).map(async (host) => {
      const source = host.querySelector('.marks-mermaid-src')?.textContent ?? '';
      const output = host.querySelector<HTMLElement>('.marks-mermaid-out');
      if (!output || !source.trim()) return;

      const cached = svgCache.get(source);
      if (cached) {
        output.innerHTML = cached;
        host.dataset.mermaid = 'done';
        return;
      }

      try {
        counter += 1;
        const { svg } = await mermaid.render(`marks-diagram-${counter}`, source);
        svgCache.set(source, svg);
        output.innerHTML = svg;
        host.dataset.mermaid = 'done';
      } catch (error) {
        host.dataset.mermaid = 'error';
        output.innerHTML = `<pre class="marks-diagram-error">${
          error instanceof Error ? escapeText(error.message) : 'Diagram failed to render'
        }</pre>`;
      }
    }),
  );
}

function escapeText(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
