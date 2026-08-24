#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [sourceDir, marksRoot, engineRevision, dirtyText, sourceSha256, profileSha256, compiler] =
  process.argv.slice(2);
if (!compiler || !/^[0-9a-f]{40}$/u.test(engineRevision ?? '')) {
  throw new Error('usage: sync-esbt-component <source> <marks> <revision> <dirty> <source-sha> <profile-sha> <compiler>');
}

const sourceGenerated = path.join(sourceDir, 'web/generated');
const sourceRelease = path.join(sourceDir, 'target/wasm32-unknown-unknown/release');
const publicDir = path.join(marksRoot, 'client/public');
const generatedDir = path.join(marksRoot, 'client/src/collab/wasm/generated');
await rm(generatedDir, { force: true, recursive: true });
const interfaceDir = path.join(generatedDir, 'interfaces');
await Promise.all([mkdir(publicDir, { recursive: true }), mkdir(interfaceDir, { recursive: true })]);

const coreNames = (await readdir(sourceGenerated))
  .filter((name) => /^esbt(?:\.core\d*)?\.wasm$/u.test(name))
  .sort();
if (coreNames.length === 0) throw new Error('ESBT build emitted no Jco core modules');

const retainedCoreNames = new Set(coreNames);
for (const name of await readdir(publicDir)) {
  if (
    ['esbt.wasm', 'esbt.wasm.manifest.json', 'esbt.wasm.rev'].includes(name)
    || (/^esbt\.core\d*\.wasm$/u.test(name) && !retainedCoreNames.has(name))
  ) {
    await rm(path.join(publicDir, name), { force: true });
  }
}

await Promise.all([
  copyFile(path.join(sourceRelease, 'esbt.component.wasm'), path.join(publicDir, 'esbt.component.wasm')),
  copyFile(path.join(sourceDir, 'wit/esbt.wit'), path.join(publicDir, 'esbt.wit')),
  copyFile(path.join(sourceGenerated, 'esbt.js'), path.join(generatedDir, 'esbt.js')),
  copyFile(path.join(sourceGenerated, 'esbt.d.ts'), path.join(generatedDir, 'esbt.d.ts')),
  ...coreNames.map((name) => copyFile(path.join(sourceGenerated, name), path.join(publicDir, name))),
]);

for (const name of await readdir(path.join(sourceGenerated, 'interfaces'))) {
  await copyFile(path.join(sourceGenerated, 'interfaces', name), path.join(interfaceDir, name));
}

const packageJson = JSON.parse(await readFile(path.join(sourceDir, 'package.json'), 'utf8'));
const transpilerPackage = '@bytecodealliance/jco-transpile';
const transpilerVersion = packageJson.devDependencies?.[transpilerPackage];
if (!/^\d+\.\d+\.\d+$/u.test(transpilerVersion ?? '')) {
  throw new Error('ESBT does not pin the component transpiler exactly');
}

const describe = async (filePath, publicPath) => {
  const bytes = await readFile(filePath);
  return { path: publicPath, bytes: bytes.byteLength, sha256: sha256(bytes) };
};
const component = await describe(path.join(publicDir, 'esbt.component.wasm'), '/esbt.component.wasm');
const wit = await describe(path.join(publicDir, 'esbt.wit'), '/esbt.wit');
const wrapper = await describe(path.join(generatedDir, 'esbt.js'), 'client:collab/wasm/generated/esbt.js');
const coreModules = await Promise.all(
  coreNames.map((name) => describe(path.join(publicDir, name), `/${name}`)),
);
const manifest = {
  schema: 'esbt.component-artifact',
  format: 1,
  engine_revision: engineRevision,
  source_dirty: dirtyText === 'true',
  source_sha256: sourceSha256,
  profile_sha256: profileSha256,
  wit_package: 'esbt:document@1.0.0',
  wit_sha256: wit.sha256,
  wire_version: 1,
  transpiler_package: transpilerPackage,
  transpiler_version: transpilerVersion,
  component,
  wrapper,
  core_modules: coreModules,
  compiler,
  target: 'wasm32-unknown-unknown',
};

await Promise.all([
  writeFile(
    path.join(publicDir, 'esbt.component.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ),
  writeFile(path.join(publicDir, 'esbt.component.rev'), `${engineRevision}\n`),
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
