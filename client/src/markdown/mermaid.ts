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
  await renderHosts(Array.from(pending));
}

/**
 * Render diagrams as they approach the viewport.
 *
 * Mermaid is the heaviest paint we do. Running it for every off-screen
 * block on first open is what makes a long document feel like it hitch
 * after the markdown itself has already arrived.
 */
export function watchDiagrams(root: HTMLElement): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    void renderDiagrams(root);
    return () => undefined;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const visible: HTMLElement[] = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        visible.push(entry.target as HTMLElement);
      }
      if (visible.length > 0) void renderHosts(visible);
    },
    { rootMargin: '240px 0px', threshold: 0.01 },
  );

  const scan = () => {
    const pending = root.querySelectorAll<HTMLElement>('.marks-mermaid[data-mermaid="pending"]');
    for (const host of pending) observer.observe(host);
  };

  const mutation = new MutationObserver(scan);
  mutation.observe(root, { childList: true, subtree: true });
  scan();

  return () => {
    observer.disconnect();
    mutation.disconnect();
  };
}

async function renderHosts(hosts: HTMLElement[]): Promise<void> {
  const pending = hosts.filter((host) => host.dataset.mermaid === 'pending');
  if (pending.length === 0) return;

  const mermaid = await getMermaid();

  await Promise.all(
    pending.map(async (host) => {
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
