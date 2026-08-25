import { runWithTimeout } from '../browser/network.ts';

type MermaidApi = typeof import('mermaid').default;

const MAX_DIAGRAM_BYTES = 4_096;
const MAX_DIAGRAM_LINES = 80;
const MAX_DIAGRAM_TOKENS = 320;
const MAX_DIAGRAM_STRUCTURE = 160;
const MAX_DIAGRAMS_PER_BATCH = 8;
const MAX_CACHED_DIAGRAMS = 32;
const MERMAID_LOAD_TIMEOUT_MS = 15_000;
const MERMAID_RENDER_TIMEOUT_MS = 8_000;

let mermaidPromise: Promise<MermaidApi> | null = null;
let currentTheme: 'light' | 'dark' = 'light';
let counter = 0;
let renderQueue: Promise<void> = Promise.resolve();
let renderCircuitError: string | null = null;

/** Rendered SVG by diagram source, so re-mounting a block never re-runs mermaid. */
const svgCache = new Map<string, string>();

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    // Mermaid is by far the heaviest renderer we ship; it stays out of the
    // initial bundle and only loads for documents that actually contain a diagram.
    mermaidPromise = runWithTimeout(
      () => import('mermaid').then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          maxTextSize: MAX_DIAGRAM_BYTES,
          maxEdges: 64,
          theme: currentTheme === 'dark' ? 'dark' : 'default',
          // Mermaid measures label text to size each node, so it needs a
          // concrete font stack: `inherit` leaves it measuring against the wrong
          // metrics and the labels end up clipped.
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        });
        return mermaid;
      }),
      MERMAID_LOAD_TIMEOUT_MS,
      null,
      new DOMException('Diagram renderer took too long to load.', 'TimeoutError'),
    ).catch((error) => {
      mermaidPromise = null;
      throw error;
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
  await enqueueRenderHosts(Array.from(pending));
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
      if (visible.length > 0) void enqueueRenderHosts(visible);
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

function enqueueRenderHosts(hosts: HTMLElement[]): Promise<void> {
  const next = renderQueue.then(() => renderHosts(hosts));
  renderQueue = next.catch(() => undefined);
  return next;
}

async function renderHosts(hosts: HTMLElement[]): Promise<void> {
  const pending = hosts.filter((host) => host.dataset.mermaid === 'pending');
  if (pending.length === 0) return;

  const eligible: Array<{ host: HTMLElement; output: HTMLElement; source: string }> = [];
  for (const host of pending) {
    const source = host.querySelector('.marks-mermaid-src')?.textContent ?? '';
    const output = host.querySelector<HTMLElement>('.marks-mermaid-out');
    if (!output || !source.trim()) continue;
    const invalid = validateMermaidSource(source);
    if (invalid) {
      showDiagramError(host, output, invalid);
    } else if (eligible.length >= MAX_DIAGRAMS_PER_BATCH) {
      showDiagramError(host, output, 'Too many diagrams became visible at once. Edit the page to retry.');
    } else {
      eligible.push({ host, output, source });
    }
  }
  if (eligible.length === 0) return;

  if (renderCircuitError) {
    for (const { host, output, source } of eligible) {
      const cached = svgCache.get(source);
      if (cached) {
        output.innerHTML = cached;
        host.dataset.mermaid = 'done';
      } else {
        showDiagramError(host, output, renderCircuitError);
      }
    }
    return;
  }

  let mermaid: MermaidApi;
  try {
    mermaid = await getMermaid();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Diagram renderer failed to load';
    for (const { host, output } of eligible) showDiagramError(host, output, message);
    return;
  }

  // Mermaid owns shared DOM/config state. Serialize bounded diagrams so one
  // public page cannot fan out synchronous graph layout on the main thread.
  for (let index = 0; index < eligible.length; index += 1) {
    const { host, output, source } = eligible[index];
    const cached = svgCache.get(source);
    if (cached) {
      output.innerHTML = cached;
      host.dataset.mermaid = 'done';
      continue;
    }
    try {
      counter += 1;
      const { svg } = await runWithTimeout(
        () => mermaid.render(`marks-diagram-${counter}`, source),
        MERMAID_RENDER_TIMEOUT_MS,
        null,
        new DOMException('Diagram rendering took too long.', 'TimeoutError'),
      );
      if (svgCache.size >= MAX_CACHED_DIAGRAMS) {
        const oldest = svgCache.keys().next().value;
        if (oldest !== undefined) svgCache.delete(oldest);
      }
      svgCache.set(source, svg);
      output.innerHTML = svg;
      host.dataset.mermaid = 'done';
    } catch (error) {
      if (isMermaidRenderTimeout(error)) {
        renderCircuitError =
          'Diagram rendering timed out. Reload this page before trying diagrams again.';
        for (const remaining of eligible.slice(index)) {
          showDiagramError(remaining.host, remaining.output, renderCircuitError);
        }
        return;
      }
      showDiagramError(
        host,
        output,
        error instanceof Error ? error.message : 'Diagram failed to render',
      );
    }
  }
}

export function isMermaidRenderTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

export function validateMermaidSource(source: string): string | null {
  if (new TextEncoder().encode(source).byteLength > MAX_DIAGRAM_BYTES) {
    return 'Diagram source is larger than the safe rendering limit.';
  }
  if (source.split(/\r?\n/u).length > MAX_DIAGRAM_LINES) {
    return 'Diagram has too many lines to render safely.';
  }
  if ((source.match(/\S+/gu) ?? []).length > MAX_DIAGRAM_TOKENS) {
    return 'Diagram has too many tokens to render safely.';
  }
  if ((source.match(/-->|---|==>|-\.->|->|<-|[,;\[\]{}()]/gu) ?? []).length > MAX_DIAGRAM_STRUCTURE) {
    return 'Diagram graph is too complex to render safely.';
  }
  return null;
}

function showDiagramError(host: HTMLElement, output: HTMLElement, message: string): void {
  host.dataset.mermaid = 'error';
  output.innerHTML = `<pre class="marks-diagram-error">${escapeText(message)}</pre>`;
}

function escapeText(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
