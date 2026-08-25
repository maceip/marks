import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_INVENTORY_PATH,
  DEFAULT_ROOT,
  buildDesignSystemInventory,
  validateDesignSystemInventory,
} from './inventory-design-system.mjs';

function valuesAt(inventory, pathParts, key) {
  let value = inventory;
  for (const part of pathParts) value = value?.[part];
  return Array.isArray(value) ? value.map((entry) => typeof entry === 'string' ? entry : entry?.[key]).filter(Boolean) : [];
}

function setDiff(before, after) {
  const afterSet = new Set(after);
  return before.filter((value) => !afterSet.has(value));
}

function changedHashes(before, after, collectionPath, key) {
  let left = before;
  let right = after;
  for (const part of collectionPath) {
    left = left?.[part];
    right = right?.[part];
  }
  if (!Array.isArray(left) || !Array.isArray(right)) return [];
  const current = new Map(right.map((entry) => [entry[key], entry]));
  return left.flatMap((entry) => {
    const match = current.get(entry[key]);
    if (!match) return [];
    const leftHash = entry.sha256 ?? entry.asset?.sha256 ?? entry.fallbackMarkSha256;
    const rightHash = match.sha256 ?? match.asset?.sha256 ?? match.fallbackMarkSha256;
    return leftHash !== rightHash ? [entry[key]] : [];
  });
}

export function compareDesignSystemInventories(committed, current) {
  if (JSON.stringify(committed) === JSON.stringify(current)) return [];
  const messages = [];
  const collections = [
    { label: 'icons', path: ['icons', 'entries'], key: 'name' },
    { label: 'UI primitives', path: ['uiPrimitives', 'modules'], key: 'path' },
    { label: 'components', path: ['components'], key: 'path' },
    { label: 'styles', path: ['styles', 'entries'], key: 'path' },
    { label: 'patterns', path: ['patterns'], key: 'path' },
  ];
  for (const collection of collections) {
    const before = valuesAt(committed, collection.path, collection.key);
    const after = valuesAt(current, collection.path, collection.key);
    const added = setDiff(after, before);
    const removed = setDiff(before, after);
    if (added.length) messages.push(`${collection.label} added: ${added.join(', ')}`);
    if (removed.length) messages.push(`${collection.label} removed: ${removed.join(', ')}`);
  }

  for (const changed of changedHashes(committed, current, ['icons', 'entries'], 'name')) messages.push(`icon changed: ${changed}`);
  for (const changed of changedHashes(committed, current, ['uiPrimitives', 'modules'], 'path')) messages.push(`UI primitive changed: ${changed}`);
  for (const changed of changedHashes(committed, current, ['components'], 'path')) messages.push(`component changed: ${changed}`);
  for (const changed of changedHashes(committed, current, ['styles', 'entries'], 'path')) messages.push(`style changed: ${changed}`);
  for (const changed of changedHashes(committed, current, ['patterns'], 'path')) messages.push(`pattern changed: ${changed}`);
  if (!messages.length) messages.push('design-system metadata or dependency relationships changed');
  return messages;
}

export async function checkDesignSystemContract({ root = DEFAULT_ROOT, inventoryPath = DEFAULT_INVENTORY_PATH } = {}) {
  const current = await buildDesignSystemInventory(root);
  const validationErrors = validateDesignSystemInventory(current);
  let committed;
  try {
    committed = JSON.parse(await readFile(path.resolve(root, inventoryPath), 'utf8'));
  } catch (error) {
    validationErrors.push(`cannot read ${inventoryPath}: ${error instanceof Error ? error.message : error}`);
    return { current, validationErrors, drift: [] };
  }
  return { current, validationErrors, drift: compareDesignSystemInventories(committed, current) };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await checkDesignSystemContract();
  if (result.validationErrors.length || result.drift.length) {
    console.error('Design-system contract check failed.');
    if (result.validationErrors.length) {
      console.error('\nContract violations:');
      result.validationErrors.forEach((error) => console.error(`- ${error}`));
    }
    if (result.drift.length) {
      console.error('\nInventory drift:');
      result.drift.forEach((change) => console.error(`- ${change}`));
      console.error('\nAfter reviewing the change, run: node scripts/inventory-design-system.mjs');
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Design-system contract passed: ${result.current.icons.entries.length} icons, `
      + `${result.current.uiPrimitives.modules.length} primitives, ${result.current.components.length} components, `
      + `${result.current.styles.entries.length} styles, and ${result.current.patterns.length} patterns are registered.`,
    );
  }
}
