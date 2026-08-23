/** Canonical public document. `/welcome/` opens this page in the real editor. */
export const ABOUT_DOCUMENT_ID = 'about-marks';

export const ABOUT_DOCUMENT_TITLE = 'Google Docs for Markdown';

export function isAboutDocument(id: string | null | undefined): boolean {
  return id === ABOUT_DOCUMENT_ID;
}

/** True when the stored replica is empty or still the old About Marks copy. */
export function aboutMarkdownNeedsRefresh(text: string | null | undefined): boolean {
  const value = text?.trim() ?? '';
  if (value.length === 0) return true;
  if (value.includes(ABOUT_DOCUMENT_TITLE)) return false;
  return /^# About Marks\b/m.test(value) || /```mermaid\s+timeline/.test(value);
}

export function aboutDocumentMeta(now = Date.now()): {
  id: string;
  title: string;
  engine: 'esbt';
  chars: number;
  created_at: number;
  updated_at: number;
} {
  return {
    id: ABOUT_DOCUMENT_ID,
    title: ABOUT_DOCUMENT_TITLE,
    engine: 'esbt',
    chars: ABOUT_DOCUMENT.length,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Marketing page. Every section is Markdown — headings, callouts, tables,
 * task lists, math, and diagrams — and `/welcome` opens it in the real editor.
 */
export const ABOUT_DOCUMENT = `# Google Docs for Markdown

Marks is the document suite people already know how to use, except the file stays Markdown.

This page is not a brochure beside the product. It is a Marks document: Markdown in the editor, the designed page in preview, the same ribbon every other page uses.

:::info
Edit this page. Switch **Edit**, **Split**, and **Preview**. Format a line from **Home**. The marketing site is the editor.
:::

> Type without a spinner. See the same source as everyone else. Take a \`.md\` file with you.

## What you get

| | Google Docs | Typical Markdown | Marks |
| --- | --- | --- | --- |
| Type without a spinner | Yes | Local only | Yes — local replica first |
| Live cursors and presence | Yes | Rare | Yes |
| Per-person undo | Yes | No | Yes — your edits, not theirs |
| Offline, then resync | Partial | Files | Yes |
| Source you can export | No | Yes | Yes — always Markdown |
| Preview of the page | Paginated | Debounced HTML | Dirty blocks only |

## How a page moves

\`\`\`mermaid
flowchart LR
  md[Markdown source] --> suite[Document suite]
  suite --> you[You]
  suite --> them[Everyone in the room]
  md --> file[Still a .md file]
\`\`\`

The diagram is Markdown. So is the table above. So is every section on this page.

## Built around the work

1. **Immediate.** The replica accepts the edit first. Sync is a later conversation.
2. **Rich without the weight.** Math, diagrams, and syntax color load when this page asks for them — not before first paint.

$$
\\mathrm{edit}\\rightarrow\\mathrm{preview}\\quad p_{50}\\approx 55\\,\\mathrm{ms}
$$

3. **Every posture.** A full ribbon on desktop, a focused composer on phones, two panes on a fold.

:::success
Try a task while you read. Checking a box in the preview writes the source.

- [x] Open this page from \`/welcome\`
- [ ] Switch to Split and edit the heading
- [ ] Insert a table or a callout from the ribbon
:::

## Accounts, without a signup wall

First paint has no registration form. A new tab is a scratch workspace.

| Path | What you do | What Marks keeps |
| --- | --- | --- |
| Scratch | Just start typing | Temporary capability on this tab |
| Phone | Scan a QR link | A durable principal plus a silent device key |
| Email | Redeem a verified-email token where enabled | The same principal, email reduced to a locator |

After that, return visits use a rotating HTTP-only session cookie. If the cookie is gone but this browser is still enrolled, Marks signs a one-use challenge with the device key. No passkey ceremony.

:::note
A scratch workspace is not a person. Your durable identity is a random principal, not your email. Collaboration rooms receive a role and a one-use ticket — never a cookie or a display name.
:::

## The machinery

**Replica.** ESBT orders characters by weighted identifiers. Deletes remove state. Your keystroke lands here first.

**Preview.** Markdown parses in a Web Worker. Only blocks whose source hash changed come back as HTML. Off-screen blocks use \`content-visibility\`.

**Glass.** Liquid glass stays on chrome — ribbon, drawers, sheets. The scrolling document stays opaque.

Optional renderers — highlight.js, KaTeX, Mermaid — load when the document asks. The home catalog does not pay for the editor. The editor does not pay for the benchmark. The public welcome URL does not pay for a second website; it opens this page.

## Open a page of your own

The workspace catalog is one click behind the mark. Templates give you a brief, a working session, or a launch room.

If you came from \`/welcome\`, you are already in the product. Keep writing.
`;
