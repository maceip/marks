import { ABOUT_DOCUMENT, ABOUT_DOCUMENT_ID, ABOUT_DOCUMENT_TITLE } from '../content/about';
import type { DocumentMeta } from '../lib/api';

export { ABOUT_DOCUMENT_ID, ABOUT_DOCUMENT_TITLE };

export type TemplateId = 'blank' | 'brief' | 'meeting' | 'launch';

export interface DocumentTemplate {
  id: TemplateId;
  name: string;
  description: string;
  accent: 'navy' | 'blue' | 'amber' | 'green';
  content: string;
}

export interface LocalDocumentDraft {
  title?: string;
  content?: string;
  templateId?: TemplateId;
}

const WORKSPACE_KEY = 'marks:ui-workspace:v1';
const WORKSPACE_READY_KEY = 'marks:ui-workspace-ready:v1';
const TEXT_PREFIX = 'marks:ui-document:v1:';
export const WORKSPACE_EVENT = 'marks:workspace-change';

export const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  {
    id: 'blank',
    name: 'Blank page',
    description: 'A quiet page with nothing in your way.',
    accent: 'navy',
    content: '',
  },
  {
    id: 'brief',
    name: 'Product brief',
    description: 'Problem, principles, scope, and success measures.',
    accent: 'blue',
    content: `# Product brief

## The opportunity

Describe the change you want to create and why it matters now.

## Principles

- Fast enough to stay out of the way
- Clear enough to make decisions from
- Small enough to ship and learn from

## Scope

### Now

- [ ] Define the smallest complete experience
- [ ] Name the proof we need

### Later

- Ideas that deserve their own iteration

## Success

| Signal | Target |
| --- | --- |
| Time to value | Under one minute |
| Return use | Weekly |
`,
  },
  {
    id: 'meeting',
    name: 'Working session',
    description: 'Decisions, open questions, and owners without ceremony.',
    accent: 'green',
    content: `# Working session

**Date:** ${new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date())}

## Desired outcome

What should be different when this session ends?

## Notes

- 

## Decisions

1. 

## Actions

- [ ] Owner — next step
`,
  },
  {
    id: 'launch',
    name: 'Launch plan',
    description: 'A compact launch room for message, moments, and risks.',
    accent: 'amber',
    content: `# Launch plan

## The one-line story

Write the sentence people should repeat after seeing the launch.

## Moments

| Moment | Audience | Owner |
| --- | --- | --- |
| Preview | Early collaborators | — |
| Release | Everyone | — |

## Readiness

- [ ] Product path exercised end to end
- [ ] Message and visuals are final
- [ ] Support and rollback paths are clear

## Risks

> Name the uncomfortable thing while there is still time to change it.
`,
  },
];

const LAUNCH_DOCUMENT = `# August surface launch

## North star

Make a browser writing app feel as immediate as a native text field and as capable as a desktop document suite.

## This week

- [x] Make About a real document in the editor
- [x] Build the adaptive ribbon
- [ ] Exercise every modal and menu
- [ ] Record the mobile and foldable receipts

## Notes

The UI prototype is deliberately local-first. No button should lead to a service error while the lower layers are moving.
`;

const FIELD_GUIDE_DOCUMENT = `# Field guide: interaction quality

## Every action answers three questions

1. What just happened?
2. Can I reverse it?
3. Where should my attention go next?

## Motion

Use motion to preserve context. Panels travel from their origin, dialogs settle into focus, and view changes crossfade without moving the document beneath the reader.

## Accessibility

- [x] Visible focus
- [x] Escape closes transient surfaces
- [x] Focus returns to the trigger
- [x] Reduced motion and transparency have real fallbacks
`;

function textKey(id: string): string {
  return `${TEXT_PREFIX}${id}`;
}

function emitWorkspaceChange(): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT));
}

function saveDocuments(documents: DocumentMeta[]): void {
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(documents));
  localStorage.setItem(WORKSPACE_READY_KEY, '1');
  emitWorkspaceChange();
}

function seedWorkspace(): DocumentMeta[] {
  const now = Date.now();
  const seeds: Array<{ id: string; title: string; content: string; minutesAgo: number }> = [
    {
      id: ABOUT_DOCUMENT_ID,
      title: ABOUT_DOCUMENT_TITLE,
      content: ABOUT_DOCUMENT,
      minutesAgo: 2,
    },
    {
      id: 'surface-launch',
      title: 'August surface launch',
      content: LAUNCH_DOCUMENT,
      minutesAgo: 42,
    },
    {
      id: 'interaction-field-guide',
      title: 'Field guide: interaction quality',
      content: FIELD_GUIDE_DOCUMENT,
      minutesAgo: 180,
    },
  ];

  const documents = seeds.map(({ id, title, content, minutesAgo }, index) => {
    localStorage.setItem(textKey(id), content);
    const updated = now - minutesAgo * 60_000;
    return {
      id,
      title,
      engine: 'esbt',
      chars: content.length,
      created_at: updated - (index + 1) * 86_400_000,
      updated_at: updated,
    };
  });
  saveDocuments(documents);
  return documents;
}

/** Write the canonical marketing Markdown without seeding the local catalog. */
export function seedAboutDocumentText(): void {
  localStorage.setItem(textKey(ABOUT_DOCUMENT_ID), ABOUT_DOCUMENT);
}

function ensureAboutDocument(documents: DocumentMeta[]): DocumentMeta[] {
  seedAboutDocumentText();
  const existing = documents.find((document) => document.id === ABOUT_DOCUMENT_ID);
  if (existing) {
    if (existing.title === ABOUT_DOCUMENT_TITLE && existing.chars === ABOUT_DOCUMENT.length) {
      return documents;
    }
    const next = documents.map((document) =>
      document.id === ABOUT_DOCUMENT_ID
        ? { ...document, title: ABOUT_DOCUMENT_TITLE, chars: ABOUT_DOCUMENT.length }
        : document,
    );
    saveDocuments(next);
    return next;
  }
  const now = Date.now();
  const about: DocumentMeta = {
    id: ABOUT_DOCUMENT_ID,
    title: ABOUT_DOCUMENT_TITLE,
    engine: 'esbt',
    chars: ABOUT_DOCUMENT.length,
    created_at: now,
    updated_at: now,
  };
  const next = [about, ...documents];
  saveDocuments(next);
  return next;
}

export function loadLocalDocuments(): DocumentMeta[] {
  const stored = localStorage.getItem(WORKSPACE_KEY);
  if (stored) {
    try {
      const documents = JSON.parse(stored) as DocumentMeta[];
      return ensureAboutDocument(documents).sort((a, b) => b.updated_at - a.updated_at);
    } catch {
      localStorage.removeItem(WORKSPACE_KEY);
    }
  }

  if (localStorage.getItem(WORKSPACE_READY_KEY)) return ensureAboutDocument([]);
  return seedWorkspace();
}

export function getLocalDocument(id: string): DocumentMeta | null {
  return loadLocalDocuments().find((document) => document.id === id) ?? null;
}

export function readLocalDocumentText(id: string): string {
  return localStorage.getItem(textKey(id)) ?? '';
}

function deriveTitle(markdown: string, fallback: string): string {
  const heading = markdown
    .split('\n')
    .map((line) => /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim())
    .find(Boolean);
  return heading?.slice(0, 90) || fallback;
}

export function writeLocalDocumentText(id: string, markdown: string): void {
  localStorage.setItem(textKey(id), markdown);
  const documents = loadLocalDocuments();
  const index = documents.findIndex((document) => document.id === id);
  if (index < 0) return;
  const current = documents[index];
  documents[index] = {
    ...current,
    title: deriveTitle(markdown, current.title),
    chars: markdown.length,
    updated_at: Date.now(),
  };
  saveDocuments(documents);
}

export function createLocalDocument(draft: LocalDocumentDraft = {}): DocumentMeta {
  const template = DOCUMENT_TEMPLATES.find((item) => item.id === draft.templateId);
  const content = draft.content ?? template?.content ?? '';
  const now = Date.now();
  const id = `local-${crypto.randomUUID()}`;
  const document: DocumentMeta = {
    id,
    title: draft.title?.trim() || deriveTitle(content, template?.name ?? 'Untitled'),
    engine: 'esbt',
    chars: content.length,
    created_at: now,
    updated_at: now,
  };
  localStorage.setItem(textKey(id), content);
  saveDocuments([document, ...loadLocalDocuments()]);
  return document;
}

export function renameLocalDocument(id: string, title: string): DocumentMeta | null {
  const nextTitle = title.trim();
  if (!nextTitle) return null;
  const documents = loadLocalDocuments();
  const index = documents.findIndex((document) => document.id === id);
  if (index < 0) return null;
  documents[index] = { ...documents[index], title: nextTitle, updated_at: Date.now() };
  saveDocuments(documents);
  return documents[index];
}

export function duplicateLocalDocument(id: string, markdown?: string): DocumentMeta | null {
  const source = getLocalDocument(id);
  if (!source) return null;
  return createLocalDocument({
    title: `${source.title} copy`,
    content: markdown ?? readLocalDocumentText(id),
  });
}

export function deleteLocalDocument(id: string): void {
  saveDocuments(loadLocalDocuments().filter((document) => document.id !== id));
  localStorage.removeItem(textKey(id));
}

export function resetLocalWorkspace(): DocumentMeta[] {
  for (const document of loadLocalDocuments()) localStorage.removeItem(textKey(document.id));
  localStorage.removeItem(WORKSPACE_KEY);
  localStorage.removeItem(WORKSPACE_READY_KEY);
  return seedWorkspace();
}
