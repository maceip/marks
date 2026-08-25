import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandEnvironment } from './types.ts';
import { commandAvailability, composeRibbon, projectCommands, toAgentTools } from './projection.ts';
import { LEGACY_ACTION_TO_COMMAND, requireCommand } from './registry.ts';
import { UI_ACTIONS } from '../lib/ui-actions.ts';

function environment(patch: Partial<CommandEnvironment> = {}): CommandEnvironment {
  return {
    hasDocument: true,
    hydrated: true,
    capabilities: { role: 'owner', edit: true, comment: true, saveVersion: true, manageShares: true },
    workspaceKind: 'session',
    mode: 'split',
    activePane: 'editor',
    shell: 'desktop',
    context: 'text',
    selectionLength: 0,
    selectionFrom: 0,
    selectionTo: 0,
    voiceSupported: true,
    voiceActive: false,
    theme: 'light',
    outlineOpen: false,
    hudOpen: false,
    ribbonCollapsed: false,
    reviewOpen: null,
    formatPainterArmed: false,
    ...patch,
  };
}

test('preview projection removes mutation controls but preserves reading controls', () => {
  const commands = projectCommands(environment({ mode: 'preview' }), 'ribbon');
  assert.equal(commands.some((command) => command.id === 'format.bold'), false);
  assert.equal(commands.some((command) => command.id === 'view.editor'), true);
  assert.equal(commands.some((command) => command.id === 'review.comments'), true);
  assert.equal(commands.some((command) => command.id === 'document.print'), true);
});

test('desktop split inspects the rendered pane without leaving split mode', () => {
  const inspect = composeRibbon(environment({ mode: 'split', activePane: 'preview' }));
  const compose = composeRibbon(environment({ mode: 'split', activePane: 'editor' }));
  const inspectCommands = inspect.flatMap((tab) => tab.groups.flatMap((group) => group.commands));
  const composeCommands = compose.flatMap((tab) => tab.groups.flatMap((group) => group.commands));
  assert.equal(inspectCommands.some((command) => command.id === 'format.bold'), false);
  assert.equal(inspectCommands.some((command) => command.id === 'review.comments'), true);
  assert.equal(composeCommands.some((command) => command.id === 'format.bold'), true);
  assert.equal(inspect.some((tab) => tab.id === 'view'), true);
});

test('foldable split keeps the compose ribbon until the app rail changes the view', () => {
  for (const shell of ['fold-book', 'fold-laptop'] as const) {
    const split = composeRibbon(environment({
      mode: 'split',
      activePane: 'preview',
      shell,
    }));
    const preview = composeRibbon(environment({
      mode: 'preview',
      activePane: 'preview',
      shell,
    }));
    assert.equal(split.flatMap((tab) => tab.groups.flatMap((group) => group.commands)).some((command) => command.id === 'format.bold'), true, shell);
    assert.equal(preview.flatMap((tab) => tab.groups.flatMap((group) => group.commands)).some((command) => command.id === 'format.bold'), false, shell);
  }
});

test('role and identity gates are explicit and do not rely on button handlers', () => {
  const viewer = environment({
    capabilities: { role: 'viewer', edit: false, comment: false, saveVersion: false, manageShares: false },
  });
  const bold = commandAvailability(requireCommand('format.bold'), viewer, 'palette');
  const share = commandAvailability(requireCommand('document.share'), viewer, 'palette');
  assert.equal(bold.enabled, false);
  assert.match(bold.reason ?? '', /cannot edit/i);
  assert.equal(share.enabled, false);
  assert.match(share.reason ?? '', /owner/i);

  const scratch = environment({ workspaceKind: 'scratch', capabilities: { role: 'scratch', edit: true, comment: false, saveVersion: false, manageShares: false } });
  assert.equal(commandAvailability(requireCommand('identity.keep'), scratch, 'palette').enabled, true);
  assert.equal(commandAvailability(requireCommand('review.comments'), scratch, 'palette').enabled, false);
});

test('contextual task tabs exist only for the selected object', () => {
  const textTabs = composeRibbon(environment(), { expanded: true });
  const imageTabs = composeRibbon(environment({ context: 'image' }), { expanded: true });
  assert.equal(textTabs.some((tab) => tab.id === 'picture'), false);
  assert.equal(imageTabs.some((tab) => tab.id === 'picture'), true);
  assert.equal(imageTabs.find((tab) => tab.id === 'picture')?.contextual, true);
});

test('foldables still project a dedicated command surface for the view rail', () => {
  const book = projectCommands(environment({ shell: 'fold-book', context: 'image' }), 'foldable');
  assert.equal(book.some((command) => command.id === 'format.bold'), true);
  assert.equal(book.some((command) => command.id === 'picture.medium' && command.contextual), true);

  const renderedLaptop = projectCommands(environment({ shell: 'fold-laptop', mode: 'preview' }), 'foldable');
  assert.equal(renderedLaptop.some((command) => command.id === 'format.bold'), false);
  assert.equal(renderedLaptop.some((command) => command.id === 'view.editor'), true);
  assert.equal(renderedLaptop.some((command) => command.id === 'review.comments'), true);
});

test('phone confirmation appears for service workspaces and not local-only documents', () => {
  const session = projectCommands(environment({ workspaceKind: 'session' }), 'phone');
  const local = projectCommands(environment({
    workspaceKind: 'local',
    capabilities: { role: 'local', edit: true, comment: true, saveVersion: true, manageShares: true },
  }), 'phone');
  assert.equal(session.some((command) => command.id === 'identity.pairing'), true);
  assert.equal(local.some((command) => command.id === 'identity.pairing'), false);
});

test('new-user composition is narrower and agent relevance can raise a command', () => {
  const compact = composeRibbon(environment());
  const expanded = composeRibbon(environment(), { expanded: true });
  assert.ok(compact.flatMap((tab) => tab.groups).flatMap((group) => group.commands).length < expanded.flatMap((tab) => tab.groups).flatMap((group) => group.commands).length);
  const raised = composeRibbon(environment(), { agentRaised: new Set(['tools.draft']) });
  assert.equal(raised.find((tab) => tab.id === 'tools')?.agentRaised, true);
});

test('phone ribbon consumes the desktop tab projection, including contextual and agent-raised tasks', () => {
  const phone = composeRibbon(environment({ shell: 'phone', context: 'image' }), {
    expanded: true,
    agentRaised: new Set(['review.document-health']),
  });
  assert.equal(phone.some((tab) => tab.id === 'home'), true);
  assert.equal(phone.some((tab) => tab.id === 'insert'), true);
  assert.equal(phone.some((tab) => tab.id === 'review' && tab.agentRaised), true);
  assert.equal(phone.some((tab) => tab.id === 'picture' && tab.contextual), true);
  assert.equal(phone.flatMap((tab) => tab.groups).flatMap((group) => group.commands).some((command) => command.id === 'picture.medium'), true);
});

test('agent tools are generated from the same registry and expose availability', () => {
  const tools = toAgentTools(environment({ mode: 'preview' }));
  const bold = tools.find((tool) => tool.commandId === 'format.bold');
  assert.ok(bold);
  assert.match(bold?.description ?? '', /currently unavailable/i);
  assert.equal(tools.some((tool) => tool.commandId === 'insert.picture-file'), false);
});

test('every legacy application action has exactly one semantic command mapping', () => {
  for (const action of UI_ACTIONS) {
    const commandId = LEGACY_ACTION_TO_COMMAND[action.id];
    assert.ok(commandId, `${action.id} must map to a semantic command`);
    assert.ok(requireCommand(commandId));
  }
});
