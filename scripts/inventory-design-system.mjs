import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = new URL('../', import.meta.url).pathname;
async function files(dir, extension) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name), extension)
    : entry.name.endsWith(extension) ? [path.join(dir, entry.name)] : []));
  return nested.flat();
}
const cssFiles = await files('client/src/styles', '.css');
const componentFiles = [...await files('client/src/components', '.tsx'), ...await files('client/src/pages', '.tsx')];
const selectors = new Set();
const literals = new Set();
const hosts = [];
for (const file of cssFiles) {
  const source = await readFile(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/(^|})\s*([^@}][^{]+)\{/gm)) match[2].split(',').forEach((value) => selectors.add(value.trim()));
  for (const match of source.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|\b\d+(?:\.\d+)?(?:px|ms)\b/gi)) literals.add(match[0]);
}
for (const file of componentFiles) {
  const source = await readFile(path.join(root, file), 'utf8');
  if (source.includes('surface-material-host') || source.includes('<SurfaceMaterial')) hosts.push(file);
}
const inventory = {
  generatedBy: 'npm run inventory:design-system',
  frozenAt: '2026-08-23',
  themes: ['light', 'dark'],
  postures: ['phone', 'studio', 'desktop', 'fold-book', 'fold-laptop'],
  states: ['default', 'hover', 'active', 'focus-visible', 'disabled', 'pressed', 'loading', 'offline'],
  selectors: [...selectors].sort(), literals: [...literals].sort(), materialHosts: hosts.sort(),
};
await writeFile(path.join(root, 'docs/design-system-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Inventoried ${inventory.selectors.length} selectors, ${inventory.literals.length} literals, and ${hosts.length} material hosts.`);
