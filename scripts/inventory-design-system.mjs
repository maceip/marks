import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const DESIGN_SYSTEM_INVENTORY_SCHEMA = 3;
export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_INVENTORY_PATH = 'docs/design-system-inventory.json';

const ICON_ASSET_EXCEPTIONS = {
  arrow: 'The renderer deliberately draws this directional primitive from the catalog vector mark.',
  bubble: 'The renderer deliberately draws this speech primitive from the catalog vector mark.',
};

const EXTERNAL_STYLE_EXCEPTIONS = {
  'katex/dist/katex.min.css': 'KaTeX owns its third-party typesetting selectors and release lifecycle.',
};

const NON_PRODUCTION_TSX_EXCEPTIONS = {
  'client/src/design-system/DesignSystem.tsx': 'Executable catalog route; it inventories production UI but is not shipped product machinery.',
  'client/src/main.tsx': 'React bootstrap entrypoint; it mounts App but is not a reusable UI component.',
};

const CONTRACT_AXES = {
  themes: ['light', 'dark'],
  densities: ['comfortable', 'compact'],
  glass: ['full', 'reduced'],
  motion: ['full', 'reduced'],
  materialTiers: ['cinematic', 'balanced', 'foundation', 'opaque'],
  postures: ['phone', 'studio', 'desktop', 'fold-book', 'fold-laptop'],
  states: ['default', 'hover', 'active', 'focus-visible', 'disabled', 'pressed', 'selected', 'loading', 'offline'],
};

const STYLE_OWNERS = [{
  family: 'ribbon',
  owner: 'client/src/styles/components/ribbon.css',
  classPrefixes: ['ribbon-', 'phone-ribbon', 'phone-category', 'quick-access', 'foldable-ribbon'],
  featureExtensions: [{
    owner: 'client/src/styles/agent.css',
    requiredClassPrefix: 'agent-',
    reason: 'Agent-qualified ribbon states are lazy feature CSS and do not redefine the shared ribbon anatomy.',
  }],
}];

const slash = (value) => value.split(path.sep).join('/');
const relative = (root, value) => slash(path.relative(root, value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function listFiles(root, directory, predicate = () => true) {
  const absolute = path.join(root, directory);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(entries.map((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, child, predicate) : predicate(child) ? [slash(child)] : [];
  }));
  return nested.flat().sort();
}

function sourceFile(file, source) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function unwrap(expression) {
  let current = expression;
  while (
    current
    && (ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isParenthesizedExpression(current))
  ) current = current.expression;
  return current;
}

function findVariable(ast, name) {
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  throw new Error(`Could not find ${name} in ${ast.fileName}`);
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
  return undefined;
}

function arrayStrings(ast, name) {
  const initializer = unwrap(findVariable(ast, name).initializer);
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`${name} must remain a literal array so the design-system contract can inventory it.`);
  }
  return initializer.elements.map((element) => {
    const value = unwrap(element);
    if (!ts.isStringLiteralLike(value)) throw new Error(`${name} contains a non-literal entry in ${ast.fileName}`);
    return value.text;
  });
}

function objectStrings(ast, name) {
  const initializer = unwrap(findVariable(ast, name).initializer);
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    throw new Error(`${name} must remain a literal object so the design-system contract can inventory it.`);
  }
  return Object.fromEntries(initializer.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) throw new Error(`${name} contains a non-property entry in ${ast.fileName}`);
    const key = propertyName(property.name);
    const value = unwrap(property.initializer);
    if (!key || !ts.isStringLiteralLike(value)) throw new Error(`${name}.${key ?? '?'} must be a string literal.`);
    return [key, value.text];
  }));
}

function numberVariable(ast, name) {
  const initializer = unwrap(findVariable(ast, name).initializer);
  if (!initializer || !ts.isNumericLiteral(initializer)) {
    throw new Error(`${name} must remain a numeric literal so the design-system contract can inventory it.`);
  }
  return Number(initializer.text);
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function runtimeExports(ast) {
  const names = new Set();
  for (const statement of ast.statements) {
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name && /^[A-Z]/u.test(statement.name.text)) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && /^[A-Z]/u.test(declaration.name.text)) names.add(declaration.name.text);
      }
    } else if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.add('default');
    }
  }
  return [...names].sort();
}

function importNames(declaration) {
  const names = [];
  const clause = declaration.importClause;
  if (!clause) return names;
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(`* as ${bindings.name.text}`);
  if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((element) => element.name.text));
  return names.sort();
}

async function resolveImport(root, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(importer), specifier);
  const candidates = path.extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.tsx`, `${base}.css`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return relative(root, candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') throw error;
    }
  }
  return relative(root, base);
}

function moduleSpecifiers(ast) {
  const values = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      values.push({ specifier: node.moduleSpecifier.text, imported: importNames(node), line: location.line + 1 });
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      values.push({ specifier: node.arguments[0].text, imported: [], line: location.line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return values;
}

function jsxFacts(ast) {
  const usedComponents = new Set();
  const nativeControls = new Map();
  const materialVariants = new Set();
  let surfaceMaterialTags = 0;
  const visit = (node) => {
    let tag;
    let attributes;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      tag = node.tagName.getText(ast);
      attributes = node.attributes;
    }
    if (tag) {
      if (/^[A-Z]/u.test(tag)) usedComponents.add(tag);
      if (['button', 'input', 'select', 'textarea', 'dialog'].includes(tag)) {
        nativeControls.set(tag, (nativeControls.get(tag) ?? 0) + 1);
      }
      if (tag === 'SurfaceMaterial') {
        surfaceMaterialTags += 1;
        const variant = attributes?.properties.find((attribute) => (
          ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'variant'
        ));
        if (variant && ts.isJsxAttribute(variant) && variant.initializer) {
          const collect = (child) => {
            if (ts.isStringLiteralLike(child)) materialVariants.add(child.text);
            ts.forEachChild(child, collect);
          };
          collect(variant.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return {
    jsxComponents: [...usedComponents].sort(),
    nativeControls: Object.fromEntries([...nativeControls].sort(([a], [b]) => a.localeCompare(b))),
    surfaceMaterialTags,
    materialVariants: [...materialVariants].sort(),
  };
}

function pngMetadata(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 29 || buffer.subarray(0, 8).toString('hex') !== signature || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return { valid: false };
  }
  return {
    valid: true,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    alpha: buffer[25] === 4 || buffer[25] === 6,
  };
}

function styleRole(file) {
  if (file.startsWith('client/src/design-system/')) return 'catalog';
  if (file.includes('/components/')) return 'component-pattern';
  if (/(?:^|\/)(?:foundation-|document-)?tokens\.css$/u.test(file)) return 'tokens';
  if (file.endsWith('/motion.css')) return 'motion';
  return 'application';
}

function cssImports(source) {
  return [...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gu)].map((match) => match[1]);
}

function tokenFacts(source) {
  const definitions = new Set([...source.matchAll(/(^|[;{]\s*)(--[a-z0-9-]+)\s*:/gimu)].map((match) => match[2]));
  const references = new Set([...source.matchAll(/var\(\s*(--[a-z0-9-]+)/giu)].map((match) => match[1]));
  return { definitions: [...definitions].sort(), references: [...references].sort() };
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
}

function ownedClassTokens(source, prefixes) {
  const clean = stripCssComments(source);
  const matches = [];
  for (const rule of clean.matchAll(/([^{}]+)\{/gu)) {
    const prelude = rule[1];
    const preludeOffset = rule.index + rule[0].indexOf(prelude);
    let selectorOffset = 0;
    for (const selector of prelude.split(',')) {
      const classes = [...selector.matchAll(/\.([_a-z][_a-z0-9-]*)/giu)];
      const selectorClasses = classes.map((match) => match[1]);
      for (const match of classes) {
        if (!prefixes.some((prefix) => match[1].startsWith(prefix))) continue;
        const index = preludeOffset + selectorOffset + match.index;
        const line = clean.slice(0, index).split('\n').length;
        matches.push({ className: match[1], line, selectorClasses });
      }
      selectorOffset += selector.length + 1;
    }
  }
  return matches;
}

async function buildSourceIndex(root) {
  const files = await listFiles(root, 'client/src', (file) => /\.(?:ts|tsx)$/u.test(file) && !/\.(?:test|spec)\.[^.]+$/u.test(file) && !file.includes('/generated/'));
  const result = new Map();
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    const ast = sourceFile(file, source);
    const imports = [];
    for (const entry of moduleSpecifiers(ast)) imports.push({ ...entry, resolved: await resolveImport(root, file, entry.specifier) });
    result.set(file, { source, ast, imports });
  }
  return result;
}

async function buildIcons(root) {
  const catalogPath = 'client/src/components/icons/catalog.ts';
  const manifestPath = 'client/src/components/icons/assets.ts';
  const rendererPath = 'client/src/components/ui/Icon.tsx';
  const assetRoot = 'client/public/icons/isometric';
  const catalogSource = await readFile(path.join(root, catalogPath), 'utf8');
  const manifestSource = await readFile(path.join(root, manifestPath), 'utf8');
  const rendererSource = await readFile(path.join(root, rendererPath), 'utf8');
  const catalog = sourceFile(catalogPath, catalogSource);
  const manifest = sourceFile(manifestPath, manifestSource);
  const names = arrayStrings(catalog, 'ICON_NAMES');
  const tones = objectStrings(catalog, 'ICON_TONE');
  const marks = objectStrings(catalog, 'ICON_MARKS');
  const vectorFallbacks = arrayStrings(manifest, 'VECTOR_ONLY_ICON_NAMES').sort();
  const assetSize = numberVariable(manifest, 'SHEET_ICON_SIZE');
  const actualAssets = await listFiles(root, assetRoot, (file) => file.endsWith('.png'));
  const expectedAssetNames = new Set(names.filter((name) => !vectorFallbacks.includes(name)));
  const registeredAssetPaths = new Set([...expectedAssetNames].map((name) => `${assetRoot}/${name}.png`));

  const entries = [];
  for (const name of names) {
    const source = vectorFallbacks.includes(name) ? 'vector-fallback' : 'png';
    let asset = null;
    if (source === 'png') {
      const assetPath = `${assetRoot}/${name}.png`;
      try {
        const bytes = await readFile(path.join(root, assetPath));
        asset = { path: assetPath, present: true, bytes: bytes.length, sha256: sha256(bytes), ...pngMetadata(bytes) };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        asset = { path: assetPath, present: false };
      }
    }
    entries.push({
      name,
      tone: tones[name] ?? null,
      source,
      fallbackMarkSha256: marks[name] ? sha256(marks[name]) : null,
      asset,
    });
  }

  return {
    catalogPath,
    manifestPath,
    rendererPath,
    assetRoot,
    assetSize,
    entries,
    unregisteredAssets: actualAssets.filter((file) => !registeredAssetPaths.has(file)),
    unregisteredToneNames: Object.keys(tones).filter((name) => !names.includes(name)).sort(),
    unregisteredMarkNames: Object.keys(marks).filter((name) => !names.includes(name)).sort(),
    catalogSha256: sha256(catalogSource),
    manifestSha256: sha256(manifestSource),
    rendererSha256: sha256(rendererSource),
  };
}

async function buildComponents(root, sourceIndex) {
  const componentFiles = [...sourceIndex.keys()].filter((file) => (
    file.endsWith('.tsx') && !Object.hasOwn(NON_PRODUCTION_TSX_EXCEPTIONS, file)
  ));
  const components = [];
  for (const file of [...new Set(componentFiles)].sort()) {
    const indexed = sourceIndex.get(file);
    if (!indexed) continue;
    const facts = jsxFacts(indexed.ast);
    const uiImports = indexed.imports.filter((entry) => entry.resolved?.startsWith('client/src/components/ui/'));
    const area = file === 'client/src/App.tsx'
      ? 'application-root'
      : file.startsWith('client/src/components/')
        ? file.split('/')[4]
        : file.startsWith('client/src/pages/')
          ? 'page'
          : file.split('/')[2];
    components.push({
      path: file,
      area,
      exports: runtimeExports(indexed.ast),
      uiPrimitives: [...new Set(uiImports.flatMap((entry) => entry.imported))].sort(),
      styleImports: indexed.imports.filter((entry) => entry.resolved?.endsWith('.css')).map((entry) => entry.resolved).sort(),
      jsxComponents: facts.jsxComponents,
      nativeControls: facts.nativeControls,
      surfaceMaterialTags: facts.surfaceMaterialTags,
      surfaceMaterialHostReferences: indexed.source.split('surface-material-host').length - 1,
      materialVariants: facts.materialVariants,
      sha256: sha256(indexed.source),
    });
  }
  return components;
}

async function buildUiPrimitives(root, sourceIndex) {
  const barrelPath = 'client/src/components/ui/index.ts';
  const barrelSource = await readFile(path.join(root, barrelPath), 'utf8');
  const barrel = sourceFile(barrelPath, barrelSource);
  const exportedModules = [];
  for (const statement of barrel.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const resolved = await resolveImport(root, barrelPath, statement.moduleSpecifier.text);
    if (resolved) exportedModules.push(resolved);
  }
  const modules = await listFiles(root, 'client/src/components/ui', (file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'));
  const entries = modules.map((file) => {
    const indexed = sourceIndex.get(file);
    return {
      path: file,
      exports: indexed ? runtimeExports(indexed.ast) : [],
      barrelExported: exportedModules.includes(file),
      sha256: indexed ? sha256(indexed.source) : null,
    };
  });
  return {
    barrelPath,
    barrelSha256: sha256(barrelSource),
    modules: entries,
    missingFromBarrel: entries.filter((entry) => !entry.barrelExported).map((entry) => entry.path),
    unknownBarrelModules: exportedModules.filter((file) => !modules.includes(file)).sort(),
  };
}

async function buildStyles(root, sourceIndex) {
  const styleFiles = await listFiles(root, 'client/src', (file) => file.endsWith('.css'));
  const importers = new Map(styleFiles.map((file) => [file, new Set()]));
  const externalImports = [];
  for (const [file, indexed] of sourceIndex) {
    for (const entry of indexed.imports.filter((candidate) => candidate.specifier.endsWith('.css'))) {
      if (entry.resolved && importers.has(entry.resolved)) importers.get(entry.resolved).add(file);
      else externalImports.push({ importer: file, specifier: entry.specifier });
    }
  }

  const sources = new Map();
  const internalImports = new Map();
  for (const file of styleFiles) {
    const source = await readFile(path.join(root, file), 'utf8');
    sources.set(file, source);
    const resolvedImports = [];
    for (const specifier of cssImports(source)) {
      const resolved = await resolveImport(root, file, specifier);
      if (resolved && importers.has(resolved)) {
        importers.get(resolved).add(file);
        resolvedImports.push(resolved);
      } else {
        externalImports.push({ importer: file, specifier });
      }
    }
    internalImports.set(file, resolvedImports.sort());
  }

  const entries = styleFiles.map((file) => {
    const source = sources.get(file);
    return {
      path: file,
      role: styleRole(file),
      importedBy: [...importers.get(file)].sort(),
      imports: internalImports.get(file),
      tokens: tokenFacts(source),
      bytes: Buffer.byteLength(source),
      sha256: sha256(source),
    };
  });
  const ownership = STYLE_OWNERS.map((contract) => {
    const { featureExtensions = [], ...canonicalContract } = contract;
    const usages = styleFiles.flatMap((file) => ownedClassTokens(sources.get(file), contract.classPrefixes)
      .map((usage) => ({ file, ...usage })));
    const allowedFeatureUsage = (usage) => featureExtensions.some((extension) => (
      usage.file === extension.owner
      && usage.selectorClasses.some((className) => className.startsWith(extension.requiredClassPrefix))
    ));
    const uniqueViolations = new Map();
    for (const usage of usages.filter((entry) => entry.file !== contract.owner && !allowedFeatureUsage(entry))) {
      uniqueViolations.set(`${usage.file}:${usage.className}`, uniqueViolations.get(`${usage.file}:${usage.className}`) ?? usage);
    }
    return {
      ...canonicalContract,
      featureExtensions: featureExtensions.map((extension) => ({
        ...extension,
        qualifiedClasses: [...new Set(usages
          .filter((usage) => usage.file === extension.owner && allowedFeatureUsage(usage))
          .map((usage) => usage.className))].sort(),
      })),
      ownedClasses: [...new Set(usages.filter((usage) => usage.file === contract.owner).map((usage) => usage.className))].sort(),
      violations: [...uniqueViolations.values()].map(({ selectorClasses: _, ...violation }) => violation),
    };
  });
  return {
    entries,
    orphanFiles: entries.filter((entry) => entry.importedBy.length === 0).map((entry) => entry.path),
    externalImports: externalImports.sort((a, b) => `${a.importer}:${a.specifier}`.localeCompare(`${b.importer}:${b.specifier}`)),
    ownership,
  };
}

async function buildPatterns(root) {
  const files = await listFiles(root, 'client/src/design-system/patterns', (file) => file.endsWith('.md'));
  return Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(root, file), 'utf8');
    const headings = source.split('\n').flatMap((line) => {
      const match = /^(#{1,2})\s+(.+)$/u.exec(line.trim());
      return match ? [{ level: match[1].length, title: match[2] }] : [];
    });
    return {
      path: file,
      title: headings.find((heading) => heading.level === 1)?.title ?? null,
      sections: headings.filter((heading) => heading.level === 2).map((heading) => heading.title),
      sha256: sha256(source),
    };
  }));
}

function buildCanonicalImportContract(sourceIndex) {
  const violations = [];
  for (const [file, indexed] of sourceIndex) {
    if (file.startsWith('client/src/components/ui/')) continue;
    for (const entry of indexed.imports) {
      if (!entry.resolved?.startsWith('client/src/components/ui/')) continue;
      if (entry.resolved === 'client/src/components/ui/index.ts') continue;
      violations.push({ consumer: file, line: entry.line, specifier: entry.specifier, resolved: entry.resolved, imported: entry.imported });
    }
  }
  return { requiredModule: 'client/src/components/ui/index.ts', violations };
}

function buildCatalogCoverage(sourceIndex, uiPrimitives) {
  const catalogPath = 'client/src/design-system/DesignSystem.tsx';
  const catalog = sourceIndex.get(catalogPath);
  const publicComponents = [...new Set(uiPrimitives.modules.flatMap((module) => module.exports))].sort();
  const facts = catalog ? jsxFacts(catalog.ast) : { jsxComponents: [] };
  const renderedComponents = publicComponents.filter((name) => facts.jsxComponents.includes(name));
  const imports = catalog
    ? catalog.imports.find((entry) => entry.resolved === uiPrimitives.barrelPath)?.imported ?? []
    : [];
  return {
    catalogPath,
    publicComponents,
    importedComponents: publicComponents.filter((name) => imports.includes(name)),
    renderedComponents,
    missingComponents: publicComponents.filter((name) => !renderedComponents.includes(name)),
  };
}

export async function buildDesignSystemInventory(root = DEFAULT_ROOT) {
  const sourceIndex = await buildSourceIndex(root);
  const [icons, components, uiPrimitives, styles, patterns] = await Promise.all([
    buildIcons(root),
    buildComponents(root, sourceIndex),
    buildUiPrimitives(root, sourceIndex),
    buildStyles(root, sourceIndex),
    buildPatterns(root),
  ]);
  const vectorFallbacks = icons.entries.filter((entry) => entry.source === 'vector-fallback').map((entry) => entry.name);
  const externalStyleSpecifiers = [...new Set(styles.externalImports.map((entry) => entry.specifier))].sort();
  const materialHosts = components
    .filter((component) => component.surfaceMaterialTags || component.surfaceMaterialHostReferences)
    .map((component) => ({
      path: component.path,
      hostReferences: component.surfaceMaterialHostReferences,
      rendererTags: component.surfaceMaterialTags,
      variants: component.materialVariants,
    }));
  const componentPaths = new Set(components.map((component) => component.path));
  const tsxFiles = [...sourceIndex.keys()].filter((file) => file.endsWith('.tsx')).sort();
  const knownNonProductionTsx = Object.keys(NON_PRODUCTION_TSX_EXCEPTIONS).filter((file) => sourceIndex.has(file)).sort();
  const unknownTsx = tsxFiles.filter((file) => !componentPaths.has(file) && !knownNonProductionTsx.includes(file));

  return {
    schemaVersion: DESIGN_SYSTEM_INVENTORY_SCHEMA,
    generatedBy: 'node scripts/inventory-design-system.mjs',
    authority: {
      contract: 'docs/DESIGN-SYSTEM.md',
      executableCatalog: 'client/src/design-system/DesignSystem.tsx',
      iconCatalog: icons.catalogPath,
      iconAssetManifest: icons.manifestPath,
      uiBarrel: uiPrimitives.barrelPath,
      tokenSource: 'client/src/styles/tokens.css',
      patternRoot: 'client/src/design-system/patterns',
    },
    axes: CONTRACT_AXES,
    icons,
    uiPrimitives,
    components,
    patterns,
    styles,
    materialHosts,
    contracts: {
      canonicalUiImports: buildCanonicalImportContract(sourceIndex),
      catalogCoverage: buildCatalogCoverage(sourceIndex, uiPrimitives),
    },
    exceptions: {
      iconAssets: vectorFallbacks.map((name) => ({ name, kind: 'vector-fallback', reason: ICON_ASSET_EXCEPTIONS[name] ?? null })),
      externalStyles: externalStyleSpecifiers.map((specifier) => ({ specifier, reason: EXTERNAL_STYLE_EXCEPTIONS[specifier] ?? null })),
      nonProductionTsx: knownNonProductionTsx.map((file) => ({ file, reason: NON_PRODUCTION_TSX_EXCEPTIONS[file] })),
    },
    unknownTsx,
  };
}

function duplicateValues(values) {
  const seen = new Set();
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))];
}

export function validateDesignSystemInventory(inventory) {
  const errors = [];
  if (inventory.schemaVersion !== DESIGN_SYSTEM_INVENTORY_SCHEMA) errors.push(`schemaVersion must be ${DESIGN_SYSTEM_INVENTORY_SCHEMA}`);

  const iconNames = inventory.icons?.entries?.map((entry) => entry.name) ?? [];
  for (const duplicate of duplicateValues(iconNames)) errors.push(`duplicate icon name: ${duplicate}`);
  for (const entry of inventory.icons?.entries ?? []) {
    if (!entry.tone) errors.push(`icon ${entry.name} has no registered tone`);
    if (!entry.fallbackMarkSha256) errors.push(`icon ${entry.name} has no fallback mark`);
    if (entry.source === 'png') {
      if (!entry.asset?.present) errors.push(`icon ${entry.name} is missing ${entry.asset?.path ?? 'its PNG asset'}`);
      else if (!entry.asset.valid) errors.push(`icon ${entry.name} asset is not a valid PNG`);
      else if (entry.asset.width !== inventory.icons.assetSize || entry.asset.height !== inventory.icons.assetSize || entry.asset.bitDepth !== 8 || entry.asset.colorType !== 6 || !entry.asset.alpha) {
        errors.push(`icon ${entry.name} must be a ${inventory.icons.assetSize}x${inventory.icons.assetSize} 8-bit RGBA PNG`);
      }
    }
  }
  if (inventory.icons?.assetSize !== 104) errors.push('the canonical sheet icon size must remain 104px unless the contract is deliberately revised');
  for (const asset of inventory.icons?.unregisteredAssets ?? []) errors.push(`unregistered icon asset: ${asset}`);
  for (const name of inventory.icons?.unregisteredToneNames ?? []) errors.push(`tone registered for unknown icon: ${name}`);
  for (const name of inventory.icons?.unregisteredMarkNames ?? []) errors.push(`fallback mark registered for unknown icon: ${name}`);

  const configuredIconExceptions = Object.keys(ICON_ASSET_EXCEPTIONS).sort();
  const inventoriedIconExceptions = (inventory.exceptions?.iconAssets ?? []).map((entry) => entry.name).sort();
  if (JSON.stringify(configuredIconExceptions) !== JSON.stringify(inventoriedIconExceptions)) {
    errors.push(`icon asset exceptions must exactly match renderer fallbacks (${configuredIconExceptions.join(', ')})`);
  }
  for (const exception of inventory.exceptions?.iconAssets ?? []) if (!exception.reason) errors.push(`icon asset exception ${exception.name} needs a reason`);

  for (const missing of inventory.uiPrimitives?.missingFromBarrel ?? []) errors.push(`public UI primitive is missing from the canonical barrel: ${missing}`);
  for (const unknown of inventory.uiPrimitives?.unknownBarrelModules ?? []) errors.push(`canonical UI barrel exports an unknown module: ${unknown}`);
  for (const violation of inventory.contracts?.canonicalUiImports?.violations ?? []) {
    errors.push(`${violation.consumer}:${violation.line} imports ${violation.specifier}; import from the canonical components/ui barrel`);
  }
  for (const component of inventory.contracts?.catalogCoverage?.missingComponents ?? []) {
    errors.push(`executable design-system catalog does not render public UI primitive: ${component}`);
  }

  for (const orphan of inventory.styles?.orphanFiles ?? []) errors.push(`style file has no source importer: ${orphan}`);
  for (const ownership of inventory.styles?.ownership ?? []) {
    if (!ownership.ownedClasses.length) errors.push(`style owner ${ownership.owner} declares no ${ownership.family} classes`);
    for (const extension of ownership.featureExtensions ?? []) {
      if (!extension.reason) errors.push(`feature stylesheet ${extension.owner} needs a reason to extend the ${ownership.family} class family`);
      if (!extension.qualifiedClasses.length) errors.push(`feature stylesheet ${extension.owner} declares no ${extension.requiredClassPrefix} qualified ${ownership.family} selectors`);
    }
    for (const violation of ownership.violations) {
      errors.push(`${violation.file}:${violation.line} declares .${violation.className}; ${ownership.owner} exclusively owns the ${ownership.family} class family`);
    }
  }
  for (const exception of inventory.exceptions?.externalStyles ?? []) if (!exception.reason) errors.push(`external stylesheet exception ${exception.specifier} needs a reason`);
  const configuredExternalStyles = Object.keys(EXTERNAL_STYLE_EXCEPTIONS).sort();
  const inventoriedExternalStyles = (inventory.exceptions?.externalStyles ?? []).map((entry) => entry.specifier).sort();
  if (JSON.stringify(configuredExternalStyles) !== JSON.stringify(inventoriedExternalStyles)) {
    errors.push(`external stylesheet exceptions must exactly match actual imports (${configuredExternalStyles.join(', ')})`);
  }

  const componentPaths = inventory.components?.map((entry) => entry.path) ?? [];
  for (const duplicate of duplicateValues(componentPaths)) errors.push(`duplicate component path: ${duplicate}`);
  const stylePaths = inventory.styles?.entries?.map((entry) => entry.path) ?? [];
  for (const duplicate of duplicateValues(stylePaths)) errors.push(`duplicate style path: ${duplicate}`);
  const patternPaths = inventory.patterns?.map((entry) => entry.path) ?? [];
  for (const duplicate of duplicateValues(patternPaths)) errors.push(`duplicate pattern path: ${duplicate}`);
  if (patternPaths.length === 0) errors.push('at least one design-system pattern document is required');
  for (const file of inventory.unknownTsx ?? []) errors.push(`TSX file is outside the registered production component roots: ${file}`);
  const configuredNonProductionTsx = Object.keys(NON_PRODUCTION_TSX_EXCEPTIONS).sort();
  const inventoriedNonProductionTsx = (inventory.exceptions?.nonProductionTsx ?? []).map((entry) => entry.file).sort();
  if (JSON.stringify(configuredNonProductionTsx) !== JSON.stringify(inventoriedNonProductionTsx)) {
    errors.push(`non-production TSX exceptions must exactly match current source (${configuredNonProductionTsx.join(', ')})`);
  }
  for (const exception of inventory.exceptions?.nonProductionTsx ?? []) if (!exception.reason) errors.push(`non-production TSX exception ${exception.file} needs a reason`);
  for (const host of inventory.materialHosts ?? []) {
    if (host.hostReferences > 0 && host.rendererTags === 0) errors.push(`material host ${host.path} does not render SurfaceMaterial`);
  }
  return errors;
}

export async function writeDesignSystemInventory({ root = DEFAULT_ROOT, output = DEFAULT_INVENTORY_PATH } = {}) {
  const inventory = await buildDesignSystemInventory(root);
  const errors = validateDesignSystemInventory(inventory);
  if (errors.length) throw new Error(`Design-system inventory is invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  const destination = path.resolve(root, output);
  await writeFile(destination, `${JSON.stringify(inventory, null, 2)}\n`);
  return { inventory, destination };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const { inventory, destination } = await writeDesignSystemInventory();
    console.log(
      `Inventoried ${inventory.icons.entries.length} icons, ${inventory.uiPrimitives.modules.length} primitives, `
      + `${inventory.components.length} components, ${inventory.styles.entries.length} styles, and ${inventory.patterns.length} patterns in ${relative(DEFAULT_ROOT, destination)}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
