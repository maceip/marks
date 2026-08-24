#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { componentWit } from '@bytecodealliance/jco-transpile/wasm-tools';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowDirty = process.argv.slice(2).includes('--allow-dirty-source');
const knownArguments = new Set(['--allow-dirty-source']);
for (const argument of process.argv.slice(2)) {
  if (!knownArguments.has(argument)) throw new Error(`unknown argument: ${argument}`);
}

const publicDirectory = resolve(root, 'client/public');
const componentPath = resolve(publicDirectory, 'esbt.component.wasm');
const manifestPath = resolve(publicDirectory, 'esbt.component.manifest.json');
const stampPath = resolve(publicDirectory, 'esbt.component.rev');
const witPath = resolve(publicDirectory, 'esbt.wit');
const profilePath = resolve(root, 'engine-profile.json');
const cargoPath = resolve(root, 'crates/marks-server/Cargo.toml');
const packagePath = resolve(root, 'package.json');
const engineTypesPath = resolve(
  root,
  'client/src/collab/wasm/generated/interfaces/esbt-document-engine.d.ts',
);

const [component, manifestText, stampText, wit, profile, cargo, packageText, engineTypes] =
  await Promise.all([
    readFile(componentPath),
    readFile(manifestPath, 'utf8'),
    readFile(stampPath, 'utf8'),
    readFile(witPath),
    readFile(profilePath),
    readFile(cargoPath, 'utf8'),
    readFile(packagePath, 'utf8'),
    readFile(engineTypesPath, 'utf8'),
  ]);
const manifest = JSON.parse(manifestText);
const packageJson = JSON.parse(packageText);
const pinned = /ESBT-web",\s*rev\s*=\s*"([0-9a-f]{40})"/u.exec(cargo)?.[1];
if (!pinned) fail('marks-server does not pin one full ESBT revision');

validateManifest(manifest);
if (manifest.engine_revision !== pinned) fail('component revision differs from marks-server');
if (stampText !== `${pinned}\n`) fail('component revision stamp differs from marks-server');
if (manifest.source_dirty !== false && !allowDirty) {
  fail('component was built from uncommitted engine source');
}
if (manifest.target !== 'wasm32-unknown-unknown') fail('component target is not Wasm');
if (typeof manifest.compiler !== 'string' || !/^rustc \d+\.\d+\.\d+ /u.test(manifest.compiler)) {
  fail('compiler identity is absent');
}
if (manifest.transpiler_package !== '@bytecodealliance/jco-transpile'
    || packageJson.devDependencies?.[manifest.transpiler_package] !== manifest.transpiler_version) {
  fail('Marks and the component manifest do not pin the same exact transpiler');
}
verifyDescriptor(component, manifest.component, 'component');
if (component.subarray(0, 8).toString('hex') !== '0061736d0d000100') {
  fail('esbt.component.wasm is not a WebAssembly component binary');
}
if (sha256(wit) !== manifest.wit_sha256) fail('WIT contract hash differs from manifest');
if (sha256(profile) !== manifest.profile_sha256) fail('product profile hash differs from manifest');

const wrapperPath = clientSourcePath(manifest.wrapper.path);
const wrapper = await readFile(wrapperPath);
verifyDescriptor(wrapper, manifest.wrapper, 'generated browser wrapper');

const seenCorePaths = new Set();
for (const descriptor of manifest.core_modules) {
  if (seenCorePaths.has(descriptor.path)) fail(`duplicate core module ${descriptor.path}`);
  seenCorePaths.add(descriptor.path);
  const bytes = await readFile(resolve(publicDirectory, basename(descriptor.path)));
  verifyDescriptor(bytes, descriptor, descriptor.path);
  if (bytes.subarray(0, 8).toString('hex') !== '0061736d01000000') {
    fail(`${descriptor.path} is not a core WebAssembly module`);
  }
  // Parsing catches corrupt sections and unsupported value types before any
  // browser is asked to instantiate the generated component binding.
  new WebAssembly.Module(bytes);
}

const sourceWit = wit.toString('utf8');
for (const token of [
  'package esbt:document@1.0.0',
  'resource document',
  'wire-version',
  'classify-artifact',
  'apply-update',
  'apply-snapshot',
  'capture-causal-position',
  'resolve-causal-position',
]) {
  if (!sourceWit.includes(token)) fail(`WIT source is missing ${JSON.stringify(token)}`);
}
for (const token of [
  'export type Bytes = Uint8Array',
  'export type Utf16Units = Uint16Array',
  'low: bigint',
  'high: bigint',
  'export class Document',
  'replace(from: number, to: number, inserted: Utf16Units',
  'applyUpdate(update: Bytes): ApplyReceipt',
  'stateHash(): bigint',
]) {
  if (!engineTypes.includes(token)) fail(`generated WIT value types are missing ${token}`);
}

let extractedWit;
try {
  extractedWit = await componentWit(new Uint8Array(component));
} catch (error) {
  fail(`the pinned transpiler could not inspect the component: ${error instanceof Error ? error.message : error}`);
}
if (!extractedWit.includes('export esbt:document/engine@1.0.0')) {
  fail('component does not actually export the versioned ESBT WIT engine');
}

console.log(
  `verified ESBT component ${manifest.component.sha256.slice(0, 12)} `
    + `(revision ${pinned.slice(0, 12)}, ${manifest.wit_package}, wire v${manifest.wire_version}, `
    + `${manifest.transpiler_package} ${manifest.transpiler_version}`
    + `${manifest.source_dirty ? ', dirty source allowed' : ''})`,
);

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest is not an object');
  if (value.schema !== 'esbt.component-artifact' || value.format !== 1) {
    fail('unsupported component manifest');
  }
  if (!/^[0-9a-f]{40}$/u.test(value.engine_revision ?? '')) fail('engine revision is invalid');
  for (const key of ['source_sha256', 'profile_sha256', 'wit_sha256']) {
    if (!/^[0-9a-f]{64}$/u.test(value[key] ?? '')) fail(`${key} is invalid`);
  }
  if (value.wit_package !== 'esbt:document@1.0.0') fail('WIT package is unsupported');
  if (value.wire_version !== 1) fail('ESBT wire version is unsupported');
  if (value.transpiler_package !== '@bytecodealliance/jco-transpile'
      || !/^\d+\.\d+\.\d+$/u.test(value.transpiler_version ?? '')) {
    fail('component transpiler is not pinned exactly');
  }
  if (value.component?.path !== '/esbt.component.wasm') fail('component path is not canonical');
  if (value.wrapper?.path !== 'client:collab/wasm/generated/esbt.js') {
    fail('wrapper path is not canonical');
  }
  if (!Array.isArray(value.core_modules) || value.core_modules.length < 1 || value.core_modules.length > 16) {
    fail('core module list is empty or unbounded');
  }
  for (const descriptor of [value.component, value.wrapper, ...value.core_modules]) {
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1) {
      fail('artifact descriptor byte length is invalid');
    }
    if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256 ?? '')) {
      fail('artifact descriptor hash is invalid');
    }
  }
  for (const descriptor of value.core_modules) {
    if (!/^\/esbt\.core(?:[1-9][0-9]*)?\.wasm$/u.test(descriptor.path ?? '')) {
      fail(`core module path is invalid: ${descriptor.path}`);
    }
  }
}

function clientSourcePath(manifestPathValue) {
  const relative = manifestPathValue.slice('client:'.length);
  if (!relative || relative.includes('..') || relative.startsWith('/')) {
    fail('generated wrapper path escapes the client source tree');
  }
  return resolve(root, 'client/src', relative);
}

function verifyDescriptor(bytes, descriptor, label) {
  if (bytes.byteLength !== descriptor.bytes) fail(`${label} byte length differs from manifest`);
  if (sha256(bytes) !== descriptor.sha256) fail(`${label} hash differs from manifest`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(`ESBT component verification failed: ${message}`);
}
