import { lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

function metadata(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

/**
 * Validate every existing component that Vite could traverse before applying
 * its destructive `--emptyOutDir` operation. The client root is checked
 * separately because walking only its descendants would trust a symlinked or
 * non-directory root without ever inspecting it.
 */
export function assertRealClientOutputPath(clientRoot: string, outputPath: string): void {
  const resolvedClientRoot = resolve(clientRoot);
  const resolvedOutput = resolve(outputPath);
  const outputRelative = relative(resolvedClientRoot, resolvedOutput);
  const outputSegments = outputRelative.split(/[\\/]/u);
  if (
    outputRelative === '' ||
    outputSegments[0] === '..' ||
    isAbsolute(outputRelative)
  ) {
    throw new Error('client output path must be a descendant of the client root');
  }

  const rootMetadata = metadata(resolvedClientRoot);
  if (rootMetadata === undefined) {
    throw new Error(`client root does not exist: ${JSON.stringify(resolvedClientRoot)}`);
  }
  if (rootMetadata.isSymbolicLink()) {
    throw new Error(`refusing symlinked client root ${JSON.stringify(resolvedClientRoot)}`);
  }
  if (!rootMetadata.isDirectory()) {
    throw new Error(`client root is not a directory: ${JSON.stringify(resolvedClientRoot)}`);
  }

  let outputComponent = resolvedClientRoot;
  for (const segment of outputSegments) {
    outputComponent = resolve(outputComponent, segment);
    const componentMetadata = metadata(outputComponent);
    if (componentMetadata === undefined) break;
    if (componentMetadata.isSymbolicLink()) {
      throw new Error(`refusing symlinked client output path component ${JSON.stringify(outputComponent)}`);
    }
    if (!componentMetadata.isDirectory()) {
      throw new Error(`client output path component is not a directory: ${JSON.stringify(outputComponent)}`);
    }
  }
}
