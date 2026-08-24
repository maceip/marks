import assert from 'node:assert/strict';
import test from 'node:test';
import { agentChatAnnouncement, agentChatHost, recoveryAction, shouldRestoreLauncherFocus, shouldSubmitPrompt } from './agent-chat-model.ts';

test('keyboard submission accepts Enter but not Shift+Enter or composition', () => {
  assert.equal(shouldSubmitPrompt('Enter', false, false), true);
  assert.equal(shouldSubmitPrompt('Enter', true, false), false);
  assert.equal(shouldSubmitPrompt('Enter', false, true), false);
});

test('working, result, and recoverable errors have polite announcement copy', () => {
  assert.equal(agentChatAnnouncement('working'), 'Assistant is working');
  assert.equal(agentChatAnnouncement('result'), 'Assistant response available');
  assert.match(agentChatAnnouncement('error', 'Network unavailable'), /Network unavailable/);
});

test('responsive shells select a non-obstructive host', () => {
  assert.equal(agentChatHost('desktop'), 'floating');
  assert.equal(agentChatHost('studio'), 'anchored-panel');
  assert.equal(agentChatHost('phone'), 'phone-tools-sheet');
  assert.equal(agentChatHost('fold-book'), 'companion-stage');
});

test('active work offers cancellation and a recoverable error offers retry', () => {
  assert.equal(recoveryAction('submitting'), 'cancel');
  assert.equal(recoveryAction('working'), 'cancel');
  assert.equal(recoveryAction('error'), 'retry');
});

test('focus is restored only when an open pill closes', () => {
  assert.equal(shouldRestoreLauncherFocus('result', 'collapsed'), true);
  assert.equal(shouldRestoreLauncherFocus('working', 'result'), false);
  assert.equal(shouldRestoreLauncherFocus('collapsed', 'collapsed'), false);
});
