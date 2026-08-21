/**
 * Ambient declarations for markdown-it plugins that ship without types.
 *
 * markdown-it v15 provides its own types but no longer exports the
 * `PluginSimple`/`PluginWithOptions` helpers, so each shim spells out the
 * plugin signature that `MarkdownIt.use()` expects.
 */
declare module 'markdown-it-abbr' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-container' {
  import type { MarkdownIt, Token } from 'markdown-it';
  const plugin: (
    md: MarkdownIt,
    name: string,
    options?: {
      validate?: (params: string) => boolean;
      render?: (tokens: Token[], index: number) => string;
      marker?: string;
    },
  ) => void;
  export default plugin;
}

declare module 'markdown-it-deflist' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it';
  type EmojiPlugin = (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export const full: EmojiPlugin;
  export const light: EmojiPlugin;
  export const bare: EmojiPlugin;
}

declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-ins' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-mark' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-sub' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-sup' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module 'markdown-it-multimd-table' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (
    md: MarkdownIt,
    options?: {
      multiline?: boolean;
      rowspan?: boolean;
      headerless?: boolean;
      multibody?: boolean;
      autolabel?: boolean;
    },
  ) => void;
  export default plugin;
}

declare module '@vscode/markdown-it-katex' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (
    md: MarkdownIt,
    options?: { throwOnError?: boolean; errorColor?: string; enableFencedBlocks?: boolean },
  ) => void;
  export default plugin;
}
