import { EsbtDoc } from '@marks/esbt';
import { createDocument, documentExists, listDocuments, saveState } from './store.js';
import { deriveTitle } from './title.js';

const WELCOME = `# Welcome to marks

A collaborative markdown editor that stays responsive at any document size.
Open this page in a second tab and start typing — edits converge instantly.

## Why it feels fast

- **Local-first CRDT.** Every keystroke applies to a local replica first, so
  input latency never depends on the network.
- **Incremental preview.** Only the markdown blocks you touched are re-parsed
  and repainted, off the main thread.
- **Snapshot cold opens.** Documents load from a single snapshot instead of a
  replay of their edit history.

Press \`Ctrl\`/\`Cmd\` + \`\\\` to toggle the preview, or open **Benchmark** in the
sidebar to measure the CRDT engines yourself.

## Everything markdown

| Feature | Syntax | Renders |
| --- | --- | :-: |
| Bold | \`**bold**\` | **bold** |
| Strikethrough | \`~~gone~~\` | ~~gone~~ |
| Highlight | \`==marked==\` | ==marked== |
| Footnote | \`[^1]\` | [^1] |

Task lists track themselves:

- [x] Conflict-free merging
- [x] Presence and remote cursors
- [ ] Your first edit

Math renders inline — $e^{i\\pi} + 1 = 0$ — and as display blocks:

$$
\\operatorname{lat}_{p95} = \\underbrace{t_{apply}}_{CRDT} + \\underbrace{t_{parse}}_{worker} + \\underbrace{t_{paint}}_{dirty\\ blocks}
$$

Diagrams are just fenced code:

\`\`\`mermaid
flowchart LR
  K[Keystroke] --> C[CRDT apply]
  C --> E[Editor paint]
  C --> W[Worker parse]
  W --> D[Dirty blocks only]
  D --> P[Preview paint]
\`\`\`

\`\`\`ts
// Syntax highlighting comes from highlight.js
export const latency = (samples: number[]) =>
  samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];
\`\`\`

:::info
Callout blocks use \`:::info\`, \`:::warning\`, \`:::danger\` and \`:::success\`.
:::

[^1]: Footnotes land down here, numbered automatically.
`;

/** Create a starter document the first time the server runs. */
export function seedIfEmpty(): void {
  if (listDocuments().length > 0) return;
  if (documentExists('welcome')) return;

  createDocument({ id: 'welcome', engine: 'esbt', title: 'Welcome to marks' });
  const doc = new EsbtDoc({ siteId: 'marks-server:welcome' });
  doc.setText(WELCOME);
  saveState('welcome', doc.export({ mode: 'snapshot' }), deriveTitle(WELCOME), WELCOME.length);
  console.log('[marks] seeded welcome document');
}
