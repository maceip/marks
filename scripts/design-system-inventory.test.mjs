import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDesignSystemInventory,
  validateDesignSystemInventory,
} from './inventory-design-system.mjs';
import { compareDesignSystemInventories } from './check-design-system-contract.mjs';

test('inventory covers canonical icons, nested styles, components, and pattern documentation', async () => {
  const inventory = await buildDesignSystemInventory();
  assert.equal('selectors' in inventory, false, 'inventory must not return to brittle selector scraping');
  assert.equal('literals' in inventory, false, 'inventory must describe semantic contracts instead of raw CSS literals');
  const iconNames = inventory.icons.entries.map((entry) => entry.name);
  for (const name of ['startTemplate', 'githubReadme', 'meetingNotes', 'importWebsite', 'ghostOverlay']) {
    assert.ok(iconNames.includes(name), `missing ${name}`);
  }
  assert.ok(inventory.styles.entries.some((entry) => entry.path === 'client/src/styles/components/ribbon.css'));
  assert.ok(inventory.styles.entries.some((entry) => entry.path === 'client/src/components/agent/agent-chat.css'));
  assert.ok(inventory.components.some((entry) => entry.path === 'client/src/components/chrome/FoldableRibbon.tsx'));
  assert.ok(inventory.patterns.some((entry) => entry.path === 'client/src/design-system/patterns/ribbon.md'));
  assert.ok(inventory.materialHosts.some((entry) => entry.path === 'client/src/components/chrome/PhoneComposer.tsx'));
  const ribbonOwner = inventory.styles.ownership.find((entry) => entry.family === 'ribbon');
  assert.equal(ribbonOwner.owner, 'client/src/styles/components/ribbon.css');
  assert.ok(ribbonOwner.ownedClasses.includes('ribbon-command'));
});

test('PNG icon assets carry enforceable dimensions, alpha, and content identities', async () => {
  const inventory = await buildDesignSystemInventory();
  const pngs = inventory.icons.entries.filter((entry) => entry.source === 'png');
  assert.ok(pngs.length > 0);
  for (const entry of pngs) {
    assert.equal(entry.asset.present, true, entry.name);
    assert.equal(entry.asset.valid, true, entry.name);
    assert.equal(entry.asset.width, 104, entry.name);
    assert.equal(entry.asset.height, 104, entry.name);
    assert.equal(entry.asset.bitDepth, 8, entry.name);
    assert.equal(entry.asset.colorType, 6, entry.name);
    assert.equal(entry.asset.alpha, true, entry.name);
    assert.match(entry.asset.sha256, /^[a-f0-9]{64}$/u);
  }
});

test('current source satisfies every generated design-system contract', async () => {
  const inventory = await buildDesignSystemInventory();
  assert.deepEqual(validateDesignSystemInventory(inventory), []);
});

test('validation rejects missing assets, unregistered machinery, and undocumented exceptions', async () => {
  const inventory = await buildDesignSystemInventory();
  const broken = structuredClone(inventory);
  const png = broken.icons.entries.find((entry) => entry.source === 'png');
  png.asset.present = false;
  broken.icons.unregisteredAssets.push('client/public/icons/isometric/unknown.png');
  broken.exceptions.externalStyles[0].reason = null;
  broken.uiPrimitives.missingFromBarrel.push('client/src/components/ui/Unknown.tsx');
  broken.contracts.canonicalUiImports.violations.push({
    consumer: 'client/src/components/example/Unknown.tsx',
    line: 1,
    specifier: '../ui/Button',
    resolved: 'client/src/components/ui/Button.tsx',
    imported: ['Button'],
  });
  broken.styles.ownership[0].violations.push({ file: 'client/src/styles/unknown.css', line: 1, className: 'ribbon-command' });
  const errors = validateDesignSystemInventory(broken).join('\n');
  assert.match(errors, /is missing/u);
  assert.match(errors, /unregistered icon asset/u);
  assert.match(errors, /needs a reason/u);
  assert.match(errors, /missing from the canonical barrel/u);
  assert.match(errors, /import from the canonical components\/ui barrel/u);
  assert.match(errors, /exclusively owns the ribbon class family/u);
});

test('snapshot comparison identifies additions and content drift', async () => {
  const inventory = await buildDesignSystemInventory();
  assert.deepEqual(compareDesignSystemInventories(inventory, structuredClone(inventory)), []);
  const changed = structuredClone(inventory);
  changed.components[0].sha256 = 'changed';
  changed.styles.entries.push({ path: 'client/src/styles/unknown.css', sha256: 'new' });
  const drift = compareDesignSystemInventories(inventory, changed).join('\n');
  assert.match(drift, /styles added: client\/src\/styles\/unknown\.css/u);
  assert.match(drift, /component changed:/u);
});
