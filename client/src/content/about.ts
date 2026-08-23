/** Canonical public document. `/welcome/` opens this page in the real editor. */
export const ABOUT_DOCUMENT_ID = 'about-marks';

export const ABOUT_DOCUMENT_TITLE = 'Google Docs for Markdown';

export function isAboutDocument(id: string | null | undefined): boolean {
  return id === ABOUT_DOCUMENT_ID;
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

Marks is the same-room writing surface people expect from a document suite, with source you can still read in any text editor.

This page is not a brochure beside the product. It is a Marks document: Markdown on the left, the designed page on the right, the same ribbon every other page uses.

:::info
Edit this page. Switch **Edit**, **Split**, and **Preview**. Format a line from **Home**. The marketing site is the editor.
:::

> A keystroke never waits for a network. Collaborators see the same Markdown. The file stays \`.md\`.

## What you get

| | Google Docs | Typical Markdown | Marks |
| --- | --- | --- | --- |
| Type without a spinner | Yes | Local only | Yes — local replica first |
| Live cursors and presence | Yes | Rare | Yes |
| Per-person undo | Yes | No | Yes — your edits, not theirs |
| Offline, then resync | Partial | Files | Yes |
| Source you can export | No | Yes | Yes — always Markdown |
| Preview of the page | Paginated | Debounced HTML | Dirty blocks only |

## The room

\`\`\`mermaid
flowchart LR
  you[You type Markdown] --> replica[Local replica]
  replica --> preview[Preview paints dirty blocks]
  replica --> room[Authorized room]
  room --> them[Everyone else]
  them --> replica
\`\`\`

No hero timeline. No second website. The diagram above is Markdown, rendered by the same preview that will render yours.

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
