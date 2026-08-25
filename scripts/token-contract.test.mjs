import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const tokenOwnerFiles = new Set([
  'client/src/styles/tokens.css',
  'client/src/styles/foundation-tokens.css',
  'client/src/styles/document-tokens.css',
]);
const thirdPartyStyleFiles = new Set(['client/src/styles/katex.css']);
const styleFiles = globSync('client/src/**/*.css')
  .filter((file) => !tokenOwnerFiles.has(file) && !thirdPartyStyleFiles.has(file))
  .sort();

const deprecatedVariables = [
  '--bg', '--surface', '--surface-raised', '--surface-sunken',
  '--text', '--text-muted', '--text-faint', '--border', '--border-strong',
  '--accent', '--accent-hover', '--accent-soft', '--danger', '--success',
  '--warning', '--info', '--shadow-sm', '--shadow-md', '--shadow-lg',
  '--radius-sm', '--radius-lg', '--radius-xl',
  '--glass', '--glass-strong', '--glass-border', '--glass-shadow',
];

const disallowedLiterals = [
  ['raw white', /#(?:fff|ffffff)\b/gi],
  ['raw full radius', /\b999px\b/g],
  ['raw shared duration', /\b(?:120|220|420)ms\b/g],
  ['raw small elevation', /0 1px 2px\b/g],
];

test('component CSS honors the semantic token contract', async () => {
  const violations = [];
  for (const file of styleFiles) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const variable of deprecatedVariables) {
      if (source.includes(`var(${variable})`)) violations.push(`${file}: deprecated ${variable}`);
    }
    if (/var\(--primitive-/.test(source)) violations.push(`${file}: primitive palette consumption`);
    for (const [label, pattern] of disallowedLiterals) {
      if (pattern.test(source)) violations.push(`${file}: ${label}`);
      pattern.lastIndex = 0;
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

const requiredSharedTokens = [
  '--color-primary', '--color-secondary', '--color-tertiary', '--color-destructive',
  '--color-success', '--color-warning', '--color-info', '--color-focus-ring',
  '--elevation-xs', '--elevation-xl', '--elevation-overlay',
  '--radius-tight', '--radius-sheet',
  '--interact-press-translate', '--interact-icon-tilt',
  '--color-reader-page', '--color-reader-text', '--color-reader-border', '--color-reader-muted',
  '--surface-quality', '--material-shader-mix', '--glass-blur-chrome',
];

const requiredAgentTokens = [
  '--motion-agent-shell-enter', '--motion-agent-content-delay',
  '--motion-agent-status-pulse', '--motion-agent-highlight',
];

test('tokens.css publishes the August 2026 intent, elevation, radius, and material set', async () => {
  const tokens = await readFile(new URL('../client/src/styles/tokens.css', import.meta.url), 'utf8');
  const foundation = await readFile(new URL('../client/src/styles/foundation-tokens.css', import.meta.url), 'utf8');
  const source = `${tokens}\n${foundation}`;
  const missing = requiredSharedTokens.filter((token) => !source.includes(`${token}:`));
  assert.deepEqual(missing, [], `missing tokens: ${missing.join(', ')}`);
});

test('agent-only motion tokens remain in the lazy agent stylesheet', async () => {
  const sharedTokens = await readFile(new URL('../client/src/styles/tokens.css', import.meta.url), 'utf8');
  const agentStyles = await readFile(new URL('../client/src/components/agent/agent-chat.css', import.meta.url), 'utf8');
  const missing = requiredAgentTokens.filter((token) => !agentStyles.includes(`${token}:`));
  const leaked = requiredAgentTokens.filter((token) => sharedTokens.includes(`${token}:`));
  assert.deepEqual(missing, [], `missing agent-owned tokens: ${missing.join(', ')}`);
  assert.deepEqual(leaked, [], `agent-only tokens leaked into shared CSS: ${leaked.join(', ')}`);
});
