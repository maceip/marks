import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  DESIGN_SYSTEM_ENTRY_POINTS,
  DESIGN_SYSTEM_EXCEPTIONS,
  DESIGN_SYSTEM_FOUNDATIONS,
  DESIGN_SYSTEM_PATTERNS,
  DESIGN_SYSTEM_PRIMITIVES,
  DESIGN_SYSTEM_RULES,
} from './contract.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

function assertUniqueIds(label: string, items: readonly { id: string }[]) {
  const ids = items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, `${label} ids must be unique`);
}

test('the one-stop contract has unique, resolvable owners and entry points', () => {
  assertUniqueIds('entry point', DESIGN_SYSTEM_ENTRY_POINTS);
  assertUniqueIds('foundation', DESIGN_SYSTEM_FOUNDATIONS);
  assertUniqueIds('primitive', DESIGN_SYSTEM_PRIMITIVES);
  assertUniqueIds('pattern', DESIGN_SYSTEM_PATTERNS);
  assertUniqueIds('rule', DESIGN_SYSTEM_RULES);
  assertUniqueIds('exception', DESIGN_SYSTEM_EXCEPTIONS);

  const repositoryLocations = [
    ...DESIGN_SYSTEM_ENTRY_POINTS.map((item) => item.location).filter((item) => !item.startsWith('/')),
    ...[...DESIGN_SYSTEM_FOUNDATIONS, ...DESIGN_SYSTEM_PRIMITIVES, ...DESIGN_SYSTEM_PATTERNS]
      .flatMap((owner) => [owner.source, ...(owner.styles ?? []), ...(owner.documentation ? [owner.documentation] : [])]),
    ...DESIGN_SYSTEM_RULES.flatMap((rule) => rule.enforcedBy),
  ];
  for (const location of repositoryLocations) {
    assert.equal(existsSync(path.join(repositoryRoot, location)), true, `missing design-system owner ${location}`);
  }
});

test('every first-party stylesheet has exactly one conceptual owner', () => {
  const owned = [...DESIGN_SYSTEM_FOUNDATIONS, ...DESIGN_SYSTEM_PRIMITIVES, ...DESIGN_SYSTEM_PATTERNS]
    .flatMap((owner) => [owner.source, ...(owner.styles ?? [])])
    .filter((file) => file.endsWith('.css'));
  assert.equal(new Set(owned).size, owned.length, 'a stylesheet is listed under more than one design-system owner');

  const styleRoot = path.join(repositoryRoot, 'client/src');
  const actual: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.css')) actual.push(path.relative(repositoryRoot, target));
    }
  };
  visit(styleRoot);
  assert.deepEqual([...owned].sort(), actual.sort());
});

test('every public React UI primitive is exported by the canonical barrel', () => {
  const uiRoot = path.join(repositoryRoot, 'client/src/components/ui');
  const modules = readdirSync(uiRoot)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => name.slice(0, -4))
    .sort();
  const barrel = readFileSync(path.join(uiRoot, 'index.ts'), 'utf8');
  for (const name of modules) {
    assert.match(barrel, new RegExp(`export \\* from ['\"]\\./${name}['\"]`), `${name} must be exported from components/ui/index.ts`);
  }
});

test('exceptions are narrow and name an existing design-system owner', () => {
  const owners = new Set([...DESIGN_SYSTEM_FOUNDATIONS, ...DESIGN_SYSTEM_PRIMITIVES, ...DESIGN_SYSTEM_PATTERNS].map((owner) => owner.id));
  for (const exception of DESIGN_SYSTEM_EXCEPTIONS) {
    assert.equal(owners.has(exception.owner), true, `${exception.id} names unknown owner ${exception.owner}`);
    assert.ok(exception.scope.length >= 12);
    assert.ok(exception.reason.length >= 24);
  }
});
