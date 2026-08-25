import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeDocumentDraft } from '../demo/workspace.ts';

test('service document drafts carry the selected template Markdown atomically', () => {
  const notes = materializeDocumentDraft({ templateId: 'notes' });
  assert.equal(notes.title, 'Notes');
  assert.match(notes.content, /^# Notes\n/u);

  const meeting = materializeDocumentDraft({ templateId: 'meeting' });
  assert.equal(meeting.title, 'Meeting');
  assert.match(meeting.content, /^# Meeting\n/u);

  const readme = materializeDocumentDraft({ templateId: 'github-readme' });
  assert.equal(readme.title, 'Project name');
  assert.match(readme.content, /^# Project name\n/u);
});
