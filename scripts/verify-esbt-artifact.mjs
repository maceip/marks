#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowDirty = process.argv.slice(2).includes('--allow-dirty-source');
const knownArguments = new Set(['--allow-dirty-source']);
for (const argument of process.argv.slice(2)) {
  if (!knownArguments.has(argument)) throw new Error(`unknown argument: ${argument}`);
}

const artifactPath = resolve(root, 'client/public/esbt.wasm');
const manifestPath = resolve(root, 'client/public/esbt.wasm.manifest.json');
const stampPath = resolve(root, 'client/public/esbt.wasm.rev');
const profilePath = resolve(root, 'engine-profile.json');
const bindingPath = resolve(root, 'client/src/collab/wasm/esbt-abi.generated.ts');
const cargoPath = resolve(root, 'crates/marks-server/Cargo.toml');

const [artifact, manifestText, stampText, profile, binding, cargo] = await Promise.all([
  readFile(artifactPath),
  readFile(manifestPath, 'utf8'),
  readFile(stampPath, 'utf8'),
  readFile(profilePath),
  readFile(bindingPath, 'utf8'),
  readFile(cargoPath, 'utf8'),
]);
const manifest = JSON.parse(manifestText);
const pinned = /ESBT-web",\s*rev\s*=\s*"([0-9a-f]{40})"/.exec(cargo)?.[1];
if (!pinned) fail('marks-server does not pin one full ESBT revision');
if (manifest.format !== 2) fail('unsupported artifact manifest');
if (manifest.engine_revision !== pinned) fail('artifact revision differs from marks-server');
if (stampText.trim() !== pinned) fail('artifact revision stamp differs from marks-server');
if (manifest.source_dirty !== false && !allowDirty) {
  fail('artifact was built from uncommitted engine source');
}
if (!/^[0-9a-f]{64}$/.test(manifest.source_sha256)) fail('source fingerprint is absent');
if (manifest.target !== 'wasm32-unknown-unknown') fail('artifact target is not Wasm');
if (typeof manifest.compiler !== 'string' || !/^rustc \d+\.\d+\.\d+ /.test(manifest.compiler)) {
  fail('compiler identity is absent');
}
if (sha256(artifact) !== manifest.wasm_sha256) fail('artifact hash differs from manifest');
if (sha256(profile) !== manifest.profile_sha256) fail('product profile hash differs from manifest');

const module = new WebAssembly.Module(artifact);
if (WebAssembly.Module.imports(module).length !== 0) {
  fail('artifact unexpectedly imports host capabilities');
}
const sections = WebAssembly.Module.customSections(module, 'esbt.abi');
if (sections.length !== 1) fail('artifact does not embed exactly one ABI definition');
const abiBytes = new Uint8Array(sections[0]);
const abiText = new TextDecoder('utf-8', { fatal: true }).decode(abiBytes);
const abi = JSON.parse(abiText);
if (abi.schema !== 'esbt.wasm-abi' || abi.version !== manifest.abi_version) {
  fail('embedded ABI version differs from manifest');
}
if (sha256(abiBytes) !== manifest.abi_sha256) fail('embedded ABI hash differs from manifest');
if (!binding.includes(`export const ESBT_ABI_DEFINITION = ${JSON.stringify(abiText)};`)) {
  fail('TypeScript binding was not generated from the embedded ABI');
}

const descriptors = new Map(
  WebAssembly.Module.exports(module).map((descriptor) => [descriptor.name, descriptor.kind]),
);
if (descriptors.get(abi.memory) !== 'memory') fail('declared memory export is absent');
const instance = new WebAssembly.Instance(module, {});
if (!(instance.exports[abi.memory] instanceof WebAssembly.Memory)) {
  fail('declared memory export has the wrong runtime type');
}
const declaredFunctions = new Set(abi.functions.map((fn) => fn.name));
for (const [name] of descriptors) {
  if (name.startsWith('esbt_') && !declaredFunctions.has(name)) {
    fail(`artifact exposes undeclared engine function ${name}`);
  }
}
for (const fn of abi.functions) {
  if (descriptors.get(fn.name) !== 'function') fail(`artifact is missing ${fn.name}`);
  const exported = instance.exports[fn.name];
  if (typeof exported !== 'function' || exported.length !== fn.parameters.length) {
    fail(`artifact has the wrong signature for ${fn.name}`);
  }
}

console.log(
  `verified ESBT artifact ${manifest.wasm_sha256.slice(0, 12)} ` +
    `(revision ${pinned.slice(0, 12)}, ABI v${abi.version}${manifest.source_dirty ? ', dirty source allowed' : ''})`,
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(`ESBT artifact verification failed: ${message}`);
}
