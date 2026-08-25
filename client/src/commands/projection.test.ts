import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandDefinition, CommandEnvironment } from './types.ts';
import {
  commandAvailability,
  commandInvocationAvailability,
  composeRibbon,
  projectCommands,
  ribbonSurfaceForShell,
  toAgentTools,
} from './projection.ts';
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
    }), { surface: 'foldable' });
    const preview = composeRibbon(environment({
      mode: 'preview',
      activePane: 'preview',
      shell,
    }), { surface: 'foldable' });
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

test('login approval appears only after login and not for anonymous or local-only documents', () => {
  const session = projectCommands(environment({ workspaceKind: 'session' }), 'phone');
  const scratch = projectCommands(environment({
    workspaceKind: 'scratch',
    capabilities: { role: 'scratch', edit: true, comment: false, saveVersion: false, manageShares: false },
  }), 'phone');
  const local = projectCommands(environment({
    workspaceKind: 'local',
    capabilities: { role: 'local', edit: true, comment: true, saveVersion: true, manageShares: true },
  }), 'phone');
  assert.equal(session.some((command) => command.id === 'identity.pairing'), true);
  assert.equal(scratch.some((command) => command.id === 'identity.pairing'), false);
  assert.equal(local.some((command) => command.id === 'identity.pairing'), false);
});

test('new-user composition is narrower and agent relevance can raise a command', () => {
  const compact = composeRibbon(environment());
  const expanded = composeRibbon(environment(), { expanded: true });
  assert.ok(compact.flatMap((tab) => tab.groups).flatMap((group) => group.commands).length < expanded.flatMap((tab) => tab.groups).flatMap((group) => group.commands).length);
  const raised = composeRibbon(environment(), { agentRaised: new Set(['tools.draft']) });
  assert.equal(raised.find((tab) => tab.id === 'tools')?.agentRaised, true);
});

test('anonymous ribbon starts with templates and a direct login control', () => {
  for (const shell of ['desktop', 'phone', 'fold-book'] as const) {
    const ribbon = composeRibbon(environment({
      shell,
      workspaceKind: 'scratch',
      capabilities: { role: 'scratch', edit: true, comment: false, saveVersion: false, manageShares: false },
    }), { surface: ribbonSurfaceForShell(shell) });
    assert.equal(ribbon[0]?.id, 'import', shell);
    assert.equal(ribbon[0]?.label, 'Start from template', shell);
    assert.equal(ribbon[1]?.id, 'login', shell);
    assert.equal(ribbon[1]?.label, 'Log In', shell);
    assert.deepEqual(
      ribbon[1]?.groups.flatMap((group) => group.commands).map((command) => command.id),
      ['identity.keep'],
      shell,
    );
    const commands = ribbon[0]?.groups.flatMap((group) => group.commands).map((command) => command.id) ?? [];
    assert.ok(commands.includes('import.notes-app'), shell);
    assert.ok(commands.includes('import.meeting'), shell);
    assert.ok(commands.includes('import.github-readme'), shell);
    assert.ok(commands.includes('import.url'), shell);
    assert.ok(commands.includes('document.import'), shell);
    assert.equal(
      ribbon.find((tab) => tab.id === 'file')?.groups
        .flatMap((group) => group.commands)
        .some((command) => command.id === 'identity.keep'),
      false,
      shell,
    );
  }
});

test('phone ribbon requests its true surface projection, including contextual and agent-raised tasks', () => {
  const phone = composeRibbon(environment({ shell: 'phone', context: 'image' }), {
    surface: 'phone',
    expanded: true,
    agentRaised: new Set(['review.document-health']),
  });
  assert.equal(phone.some((tab) => tab.id === 'home'), true);
  assert.equal(phone.some((tab) => tab.id === 'insert'), true);
  assert.equal(phone.some((tab) => tab.id === 'review' && tab.agentRaised), true);
  assert.equal(phone.some((tab) => tab.id === 'picture' && tab.contextual), true);
  assert.equal(phone.flatMap((tab) => tab.groups).flatMap((group) => group.commands).some((command) => command.id === 'picture.medium'), true);
});

test('phone essentials keep one curated Office-mobile deck and expose the full library on demand', () => {
  const phone = environment({ shell: 'phone', mode: 'edit', activePane: 'editor' });
  const essential = composeRibbon(phone, { surface: 'phone' });
  const expanded = composeRibbon(phone, { surface: 'phone', expanded: true });
  const essentialIds = essential.flatMap((tab) => tab.groups.flatMap((group) => group.commands.map((command) => command.id)));
  const expandedIds = expanded.flatMap((tab) => tab.groups.flatMap((group) => group.commands.map((command) => command.id)));

  for (const commandId of [
    'format.bold',
    'paragraph.tasks',
    'insert.link',
    'review.comments',
    'view.ghost-overlay',
  ]) {
    assert.equal(essentialIds.includes(commandId), true, `${commandId} remains in the focused phone ribbon`);
  }
  for (const commandId of ['edit.paste', 'format.highlight', 'insert.picture-url', 'review.render-diagnostics']) {
    assert.equal(essentialIds.includes(commandId), false, `${commandId} stays out of the focused phone ribbon`);
    assert.equal(expandedIds.includes(commandId), true, `${commandId} remains reachable from Show all categories`);
  }

  assert.deepEqual(
    essential.find((tab) => tab.id === 'home')?.groups.map((group) => group.label),
    ['Font', 'Styles', 'Paragraph', 'Editing'],
  );
  assert.deepEqual(
    essential.find((tab) => tab.id === 'insert')?.groups.map((group) => group.label),
    ['Links', 'Illustrations', 'Table', 'Blocks'],
  );
});

test('phone categories stay stable in Preview while editing commands become disabled', () => {
  const phone = environment({
    shell: 'phone',
    mode: 'preview',
    activePane: 'preview',
    workspaceKind: 'scratch',
    capabilities: { role: 'scratch', edit: true, comment: true, saveVersion: false, manageShares: false },
  });
  const essential = composeRibbon(phone, { surface: 'phone' });

  assert.deepEqual(
    essential.map((tab) => tab.id),
    ['import', 'login', 'file', 'home', 'insert', 'review', 'view'],
  );
  const bold = essential
    .flatMap((tab) => tab.groups)
    .flatMap((group) => group.commands)
    .find((command) => command.id === 'format.bold');
  assert.equal(bold?.enabled, false);
  assert.match(bold?.unavailableReason ?? '', /Switch to Editor or Split/u);
});

test('ghost overlay is an essential phone-only presentation with human-only invocation', () => {
  const ghost = requireCommand('view.ghost-overlay');
  const phone = environment({ shell: 'phone', mode: 'edit', activePane: 'editor' });

  assert.deepEqual(ghost.surfaces, ['phone']);
  assert.deepEqual(ghost.invocationSources, ['human']);
  assert.equal(commandAvailability(ghost, phone, 'phone').enabled, true);
  for (const surface of ['ribbon', 'foldable', 'palette', 'agent'] as const) {
    assert.equal(commandAvailability(ghost, phone, surface).visible, false, surface);
  }
  assert.equal(commandInvocationAvailability(ghost, phone, 'human').enabled, true);
  assert.equal(commandInvocationAvailability(ghost, phone, 'agent').enabled, false);
  assert.equal(commandInvocationAvailability(ghost, phone, 'bridge').enabled, false);
  assert.equal(toAgentTools(phone).some((tool) => tool.commandId === ghost.id), false);

  const phoneView = composeRibbon(phone, { surface: 'phone' }).find((tab) => tab.id === 'view');
  assert.deepEqual(
    phoneView?.groups.find((group) => group.label === 'Layout')?.commands.map((command) => command.id),
    ['view.ghost-overlay'],
  );
});

test('shell routing selects distinct desktop, phone, and foldable ribbon surfaces', () => {
  assert.equal(ribbonSurfaceForShell('phone'), 'phone');
  assert.equal(ribbonSurfaceForShell('fold-book'), 'foldable');
  assert.equal(ribbonSurfaceForShell('fold-laptop'), 'foldable');
  assert.equal(ribbonSurfaceForShell('studio'), 'ribbon');
  assert.equal(ribbonSurfaceForShell('desktop'), 'ribbon');

  const phoneEnvironment = environment({ shell: 'phone', mode: 'edit' });
  const phone = composeRibbon(phoneEnvironment, { surface: 'phone', expanded: true });
  const desktop = composeRibbon(phoneEnvironment, { surface: 'ribbon', expanded: true });
  const phoneIds = phone.flatMap((tab) => tab.groups.flatMap((group) => group.commands.map((command) => command.id)));
  const desktopIds = desktop.flatMap((tab) => tab.groups.flatMap((group) => group.commands.map((command) => command.id)));
  assert.equal(phoneIds.includes('view.hud'), false);
  assert.equal(phoneIds.includes('view.ribbon'), false);
  assert.equal(desktopIds.includes('view.hud'), true);
  assert.equal(desktopIds.includes('view.ribbon'), true);
});

test('invocation admission is independent from presentation and keeps capability gates', () => {
  const phoneOnly: CommandDefinition = {
    ...requireCommand('format.bold'),
    surfaces: ['phone'],
    invocationSources: ['human'],
  };
  const phone = environment({ shell: 'phone', mode: 'edit' });
  assert.equal(commandAvailability(phoneOnly, phone, 'phone').enabled, true);
  assert.equal(commandAvailability(phoneOnly, phone, 'ribbon').visible, false);
  assert.equal(commandInvocationAvailability(phoneOnly, phone, 'human').enabled, true);
  assert.equal(commandInvocationAvailability(phoneOnly, phone, 'agent').enabled, false);

  const viewer = environment({
    shell: 'phone',
    mode: 'edit',
    capabilities: { role: 'viewer', edit: false, comment: false, saveVersion: false, manageShares: false },
  });
  const denied = commandInvocationAvailability(phoneOnly, viewer, 'human');
  assert.equal(denied.enabled, false);
  assert.match(denied.reason ?? '', /cannot edit/i);
});

test('registry invocation-source metadata preserves palette and bridge boundaries', () => {
  assert.deepEqual(requireCommand('workspace.command-palette').invocationSources, ['human']);
  assert.deepEqual(requireCommand('workspace.about').invocationSources, ['keyboard', 'palette', 'agent', 'bridge']);
  assert.deepEqual(requireCommand('format.bold').invocationSources, ['human', 'keyboard', 'palette', 'agent', 'bridge']);
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
