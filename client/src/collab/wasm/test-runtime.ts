import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EsbtRuntime,
  isEsbtComponentManifest,
  verifyComponentArtifact,
  type EsbtComponentManifest,
} from './esbt-document.ts';

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../../public');

let artifactPromise:
  | Promise<{
      manifest: EsbtComponentManifest;
      modules: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
    }>
  | undefined;

export async function loadTestArtifact(): Promise<{
  manifest: EsbtComponentManifest;
  modules: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
}> {
  artifactPromise ??= (async () => {
    const parsed: unknown = JSON.parse(
      await readFile(join(publicDirectory, 'esbt.component.manifest.json'), 'utf8'),
    );
    if (!isEsbtComponentManifest(parsed)) {
      throw new TypeError('test component manifest is malformed');
    }
    const entries = await Promise.all(parsed.core_modules.map(async (descriptor) => {
      const bytes = Uint8Array.from(
        await readFile(join(publicDirectory, descriptor.path.slice(1))),
      );
      await verifyComponentArtifact(bytes, descriptor);
      return [descriptor.path.slice(descriptor.path.lastIndexOf('/') + 1), bytes] as const;
    }));
    return { manifest: parsed, modules: Object.fromEntries(entries) };
  })();
  return artifactPromise;
}

export async function createTestRuntime(): Promise<EsbtRuntime> {
  const { modules } = await loadTestArtifact();
  return EsbtRuntime.fromCoreModules(modules);
}
