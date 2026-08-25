import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ABOUT_DOCUMENT_CHAR_COUNT,
  ABOUT_DOCUMENT_ID,
  ABOUT_DOCUMENT_TITLE,
  aboutMarkdownNeedsRefresh,
  isAboutDocument,
} from './about.ts';
import { ABOUT_DOCUMENT } from './marketing-markdown.ts';

describe('about document', () => {
  it('is a crafted Marks page, not a second website', () => {
    assert.equal(ABOUT_DOCUMENT_ID, 'about-marks');
    assert.equal(ABOUT_DOCUMENT_TITLE, 'Google Docs for Markdown');
    assert.equal(ABOUT_DOCUMENT_CHAR_COUNT, ABOUT_DOCUMENT.length);
    assert.equal(isAboutDocument(ABOUT_DOCUMENT_ID), true);
    assert.match(ABOUT_DOCUMENT, /^# Google Docs for Markdown/m);
    assert.match(ABOUT_DOCUMENT, /This page is not a brochure/);
    assert.match(ABOUT_DOCUMENT, /The marketing site is the editor/);
    assert.match(ABOUT_DOCUMENT, /Delete this entire introduction/);
    assert.match(ABOUT_DOCUMENT, /ordinary public Marks page/);
  });

  it('refreshes empty or retired About Marks copy', () => {
    assert.equal(aboutMarkdownNeedsRefresh(''), true);
    assert.equal(aboutMarkdownNeedsRefresh('# About Marks\n\nOld copy.'), true);
    assert.equal(aboutMarkdownNeedsRefresh('```mermaid\ntimeline\n    title Old hero\n```'), true);
    assert.equal(aboutMarkdownNeedsRefresh(ABOUT_DOCUMENT), false);
    assert.equal(aboutMarkdownNeedsRefresh('# Google Docs for Markdown\n\nEdited locally.'), false);
  });

  it('writes every marketing section in Markdown', () => {
    assert.doesNotMatch(ABOUT_DOCUMENT, /<(?:div|section|img|picture|video)\b/i);
    assert.doesNotMatch(ABOUT_DOCUMENT, /```mermaid\s+timeline/);
    assert.match(ABOUT_DOCUMENT, /Google Docs/);
    assert.match(ABOUT_DOCUMENT, /Typical Markdown/);
    assert.match(ABOUT_DOCUMENT, /```mermaid\s+flowchart LR/);
    assert.match(ABOUT_DOCUMENT, /:::info/);
    assert.match(ABOUT_DOCUMENT, /:::success/);
    assert.match(ABOUT_DOCUMENT, /- \[x\] Open this editable introduction/);
    assert.match(ABOUT_DOCUMENT, /\$\$/);
  });

  it('explains the product, accounts, and the machinery', () => {
    assert.match(ABOUT_DOCUMENT, /saved public page/i);
    assert.match(ABOUT_DOCUMENT, /scan the QR code/i);
    assert.match(ABOUT_DOCUMENT, /restore your login securely/i);
    assert.match(ABOUT_DOCUMENT, /ESBT/);
    assert.match(ABOUT_DOCUMENT, /Web Worker/);
    assert.match(ABOUT_DOCUMENT, /Liquid glass/);
  });
});
