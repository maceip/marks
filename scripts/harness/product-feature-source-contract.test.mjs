import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PRODUCT_FEATURE_CATALOG } from '../../config/product-variants.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clientRoot = join(root, 'client');
const knownFeatureKeys = new Set(Object.keys(PRODUCT_FEATURE_CATALOG));

function clientSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'dist' || entry.name === 'dist-variants' || entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return clientSourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?|d\.ts)$/u.test(entry.name) ? [path] : [];
  });
}

function featureAccessViolations(source, fileName) {
  const scriptKind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const normalized = relative(root, fileName).replaceAll('\\', '/');
  const violations = [];

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === '__MARKS_FEATURES__') {
      const parent = node.parent;
      const directKnownProperty = ts.isPropertyAccessExpression(parent)
        && parent.expression === node
        && parent.questionDotToken === undefined
        && knownFeatureKeys.has(parent.name.text);
      const ambientDeclaration = normalized === 'client/src/types/build-flags.d.ts'
        && ts.isVariableDeclaration(parent)
        && parent.name === node;
      if (!directKnownProperty && !ambientDeclaration) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(
          `${normalized}:${position.line + 1}:${position.character + 1} `
          + 'must use a direct known __MARKS_FEATURES__.<key> property',
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

test('production client feature access is direct, literal, and catalog-known', () => {
  const violations = clientSourceFiles(clientRoot).flatMap((path) =>
    featureAccessViolations(readFileSync(path, 'utf8'), path));
  assert.deepEqual(violations, []);

  const viteConfig = readFileSync(join(clientRoot, 'vite.config.ts'), 'utf8');
  assert.equal(
    viteConfig.match(/`__MARKS_FEATURES__\.\$\{key\}`/gu)?.length ?? 0,
    1,
    'Vite must continue defining each catalog feature as a property-level literal',
  );
  assert.doesNotMatch(
    viteConfig,
    /(?:^|[,{}]\s*)(?:__MARKS_FEATURES__|['"]__MARKS_FEATURES__['"])\s*:/mu,
    'Vite must not add a whole-object feature define',
  );
});

test('the global command-state integration is owned by the agent-chat cut', () => {
  const commandProvider = readFileSync(join(clientRoot, 'src/commands/react.tsx'), 'utf8');
  assert.match(
    commandProvider,
    /if \(!__MARKS_FEATURES__\.agentChat\) return;\s*window\.dispatchEvent\(new CustomEvent\('marks:command-state'/u,
    'the global command-state event must stay behind the direct agent-chat build guard',
  );
  assert.ok(
    PRODUCT_FEATURE_CATALOG.agentChat.client?.javascriptMarkers.includes('marks:command-state'),
    'the stable artifact scan must reject the global command-state event',
  );
});

test('feature-owned selectors stay in gated stylesheets', () => {
  const agentStyles = readFileSync(join(clientRoot, 'src/styles/agent.css'), 'utf8');
  const agentChatStyles = readFileSync(join(clientRoot, 'src/components/agent/agent-chat.css'), 'utf8');
  const practicalStyles = readFileSync(join(clientRoot, 'src/styles/practical.css'), 'utf8');
  const wildStyles = readFileSync(join(clientRoot, 'src/styles/wild.css'), 'utf8');
  const designSystemStyles = readFileSync(join(clientRoot, 'src/design-system/design-system.css'), 'utf8');
  const app = readFileSync(join(clientRoot, 'src/App.tsx'), 'utf8');
  const agentOwnedStyles = `${agentStyles}\n${agentChatStyles}`;

  for (const marker of PRODUCT_FEATURE_CATALOG.agentChat.client?.stylesheetMarkers ?? []) {
    assert.ok(agentOwnedStyles.includes(marker), `${marker} must be agent-owned`);
  }
  assert.doesNotMatch(practicalStyles, /\.exposure-agent|\.agent-pill/u);
  assert.doesNotMatch(wildStyles, /\.agent-pill/u);
  assert.doesNotMatch(designSystemStyles, /\.ds-agent/u);
  assert.doesNotMatch(app, /wild-open/u);
});

test('source contract ignores comments and rejects indirect, computed, optional, or unknown access', () => {
  const valid = `
    // A comment may explain __MARKS_FEATURES__[key] without becoming code.
    const label = '__MARKS_FEATURES__ is compile-time only';
    const agent = __MARKS_FEATURES__.agentChat;
    const wild = __MARKS_FEATURES__.ribbonWild;
  `;
  assert.deepEqual(featureAccessViolations(valid, join(root, 'client/src/valid.ts')), []);

  const invalid = [
    'const flags = __MARKS_FEATURES__;',
    "const enabled = __MARKS_FEATURES__['agentChat'];",
    'const enabled = __MARKS_FEATURES__[featureKey];',
    'const { agentChat } = __MARKS_FEATURES__;',
    'const enabled = __MARKS_FEATURES__?.agentChat;',
    'const enabled = __MARKS_FEATURES__.futureFeature;',
  ];
  for (const [index, source] of invalid.entries()) {
    const violations = featureAccessViolations(source, join(root, `client/src/invalid-${index}.ts`));
    assert.equal(violations.length, 1, source);
    assert.match(violations[0], /must use a direct known __MARKS_FEATURES__\.<key> property/u);
  }
});
