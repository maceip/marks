/**
 * Canonical editable introduction. `/welcome` opens the built-in copy, while
 * an anonymous visit to `/` clones this Markdown into an ordinary public page.
 */
export const ABOUT_DOCUMENT = `# Google Docs for Markdown

Marks is the document suite people already know how to use, except the file stays Markdown.

This page is not a brochure beside the product. It is a Marks document: Markdown in the editor, the designed page in preview, the same ribbon every other page uses.

:::info
This is your page now. Delete this entire introduction, switch between **Editor** and **Preview**, or keep any part that is useful. The marketing site is the editor.
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

- [x] Open this editable introduction at its unique public URL
- [ ] Switch to Editor and change the heading
- [ ] Insert a table or a callout from the ribbon
:::

## Log in without a signup wall

First paint has no registration form. A new tab opens a saved public page immediately.

| Path | What you do | What Marks keeps |
| --- | --- | --- |
| No login | Just start typing | A saved public page with its own URL |
| Log In | On a laptop, choose Log In and scan the QR code with your phone | Your account on both devices |
| Return visit | Open Marks again | Your account pages and public links |

After that, this browser can restore your login securely on return visits. No password or passkey ceremony.

:::note
Public pages work without an account. Logging in keeps account controls and makes your account pages available on the devices you approve.
:::

## The machinery

**Replica.** ESBT orders characters by weighted identifiers. Deletes remove state. Your keystroke lands here first.

**Preview.** Markdown parses in a Web Worker. Only blocks whose source hash changed come back as HTML. Off-screen blocks use \`content-visibility\`.

**Glass.** Liquid glass stays on chrome — ribbon, drawers, sheets. The scrolling document stays opaque.

Optional renderers — highlight.js, KaTeX, Mermaid — load when the document asks. The home catalog does not pay for the editor. The editor does not pay for the benchmark. The public welcome URL does not pay for a second website; it opens this page.

## Make it yours

Select everything and replace it, keep a useful section, or choose Start from template. This is an ordinary public Marks page, not protected marketing chrome.
`;
