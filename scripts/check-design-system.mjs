import { readFile } from 'node:fs/promises';

const required = ['--color-canvas', '--color-action', '--motion-response', '--motion-enter', '--space-1', '--control-height-touch'];
const tokens = await readFile(new URL('../client/src/styles/tokens.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../client/src/App.tsx', import.meta.url), 'utf8');
const route = await readFile(new URL('../client/src/hooks/useRoute.ts', import.meta.url), 'utf8');
const failures = required.filter((token) => !tokens.includes(token)).map((token) => `missing token ${token}`);
if (!app.includes("import('./pages/DesignSystem')")) failures.push('design-system catalog is not lazy loaded');
if (!route.includes("'/design-system'")) failures.push('design-system route is missing');
if (app.includes("import { DesignSystem } from './pages/DesignSystem'")) failures.push('design-system route is eagerly imported');
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Design-system tokens, route split, and governance invariants are valid.');
