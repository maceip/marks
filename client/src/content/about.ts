/** Canonical public document. `/welcome/` opens this page in the real editor. */
export const ABOUT_DOCUMENT_ID = 'about-marks';

export const ABOUT_DOCUMENT_TITLE = 'About Marks';

export const ABOUT_DOCUMENT = `# About Marks

Marks is collaborative Markdown at thought speed. The page you are reading is not a brochure beside the product. It is a Marks document: source on one side, the designed page on the other, the same ribbon and preview every other page uses.

The promise is simple. A keystroke never waits for a network. The source stays portable. The interface feels like a quiet desktop suite that happens to live in the browser.

:::info
This workspace is local to your browser until you choose to keep it. You can edit this page. Duplicate it if you want a copy that will not be refreshed.
:::

## Built around the work

Fast is not a mode. It is the rule every feature has to survive.

1. **Immediate by design.** Your local replica accepts the edit first. Collaboration, persistence, and preview follow without blocking the cursor.
2. **Rich without the weight.** Math, diagrams, syntax, comments, and history arrive when the document asks for them — not before the first paint.
3. **Made for every posture.** A full ribbon on desktop, a focused composer on phones, and real two-pane editing on unfolded devices.

| Receipt | Meaning |
| --- | --- |
| 0 | Network waits on a keystroke |
| 1 | Dirty block repainted for a typical edit |
| .md | The source stays portable and yours |

## What you are looking at

A Marks document is ordinary Markdown with a few careful extensions: callouts, tables, task lists, footnotes, math, and diagrams. The editor is the source of truth. The preview paints only the blocks that changed.

Try the surface while you read:

- Switch **Edit**, **Split**, and **Preview** from the View ribbon or the phone composer
- Format a line from **Home**
- Insert a shape from **Draw**
- Open **AI** and outline this page
- Press **⌘⇧P** for the command palette

The ribbon borrows the parts of a classic Word ribbon that still earn their keep in Markdown: Quick Access undo/redo, a heading gallery, clipboard and format painter, contextual Picture / Table / Shape tabs, and Insert for images, figures, and structure. It is not a clone. It is the useful mechanics, rebuilt for source that you can still read in any text editor.

## Accounts, without a signup wall

First paint has no registration form. A new tab is a temporary scratch workspace. You can write immediately.

To keep the workspace and use it on other devices, Marks offers two promotion rails. They create the same kind of account. They are not different products.

| Path | What you do | What Marks keeps |
| --- | --- | --- |
| Scratch | Just start typing | A temporary capability on this tab |
| Phone | Scan a QR link | A durable principal plus a silent device key for this browser |
| Email | Redeem a verified-email token where that rail is enabled | The same principal, with the email reduced to a server locator |

After that, ordinary return visits use a rotating HTTP-only session cookie. If the cookie is gone but this browser is still enrolled, Marks signs a one-use challenge with the device key and continues. There is no passkey ceremony and no “are you still there?” prompt on a normal login.

A few rules stay honest:

- A scratch workspace is not a person. It is temporary authority over one local room.
- Your durable identity is a random server-issued principal, not your email, phone, or IP.
- Each device has its own key. Two laptops you own do not share a collaboration site.
- The phone can enroll or revoke devices. A linked laptop cannot enroll another laptop.
- Marks never automatically merges two existing principals.

Collaboration rooms receive only a validated principal, a role, and a one-use room ticket. The editing engine never sees an email, a cookie, or a display name.

:::note
Local prototype mode on this build persists documents in the browser so the whole product can be used before a service is attached. Share stages access in the UI. It does not claim to have sent an invitation.
:::

## The machinery under the page

Three systems stay out of each other’s way.

**The replica.** Documents are sequences in ESBT, a CRDT that orders characters by weighted identifiers. Deletes remove state instead of leaving tombstones. Your keystroke lands in the local replica first. Sync is a later conversation.

**The preview.** Markdown parses in a Web Worker. The worker returns HTML only for blocks whose source hash changed. A one-word edit in a long document ships a few hundred bytes, not a new page. Off-screen blocks use \`content-visibility\`, so a thousand-block note stays as cheap to repaint as a short one.

**The glass.** Liquid glass belongs to chrome: the ribbon, drawers, sheets, and inspectors. It scales from a CSS frost to optional WebGL caustics from what the device can do without jank. The scrolling document stays opaque. A virtual keyboard pauses the shader.

\`\`\`mermaid
flowchart LR
  keystroke[Keystroke] --> replica[Local ESBT replica]
  replica --> editor[CodeMirror]
  replica --> worker[Markdown worker]
  worker --> preview[Dirty-block preview]
  replica -.->|later| room[Authorized room]
\`\`\`

Optional renderers — syntax colors, KaTeX, Mermaid — load when the document asks for them. The home catalog does not pay for the editor. The editor does not pay for the benchmark. The public welcome URL does not pay for a second website; it opens this page.

## Open a page of your own

The workspace catalog is one click behind the mark. Templates give you a brief, a working session, or a launch room. Everything you create here stays on this device until a document service is wired behind the same interfaces.

If you came from the welcome link, you are already in the product. Keep writing.
`;
