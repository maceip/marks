import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (name: string) => readFileSync(new URL(`${name}.tsx`, import.meta.url), 'utf8');
const css = readFileSync(new URL('../../styles/components.css', import.meta.url), 'utf8');

test('buttons retain native semantics, accessible state, refs, and disabled loading behavior', () => {
  const button = source('Button');
  assert.match(button, /forwardRef<HTMLButtonElement/);
  assert.match(button, /ButtonHTMLAttributes<HTMLButtonElement>/);
  assert.match(button, /disabled=\{disabled \|\| loading\}/);
  assert.match(button, /aria-busy=\{loading \|\| undefined\}/);
  assert.match(button, /button-spinner/);
  assert.match(button, /leadingIcon &&/);
  assert.match(source('IconButton'), /aria-label=\{label\}/);
  assert.match(source('IconButton'), /icon-button-face/);
});

test('loading keeps control geometry and overlays a spinner', () => {
  assert.match(css, /data-loading='true'] > :not\(\.button-spinner\)/);
  assert.match(css, /visibility: hidden/);
  assert.match(css, /\.button-spinner/);
  assert.match(css, /ui-control\[data-loading='true'\] \{ cursor: wait/);
});

test('tabs expose tab semantics and implement keyboard activation/navigation', () => {
  const tabs = source('Tabs');
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tab"/);
  assert.match(tabs, /aria-selected=/);
  assert.match(tabs, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(tabs, /\.focus\(\); onChange/);
});

test('shared states include focus-visible, selected, disabled, loading and coarse targets', () => {
  assert.match(css, /\.ui-control:focus-visible/);
  assert.match(css, /aria-selected='true'/);
  assert.match(css, /\.ui-control:disabled/);
  assert.match(css, /data-loading='true'/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: var\(--control-height-touch\)/);
});
