import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const styleExceptions = new Set(['client/src/styles/tokens.css']);
const webAnimationRecipeOwners = new Set(['client/src/components/icons/motion.ts']);
const timeLiteral = /(?<![-\w])(?:\d*\.)?\d+m?s\b/g;
const failures = [];
for (const file of globSync('client/src/**/*.css')) {
  if (styleExceptions.has(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const code = line.replace(/\/\*.*?\*\//g, '');
    for (const match of code.matchAll(timeLiteral)) {
      failures.push(`${file}:${index + 1}: use a named --motion-* token instead of ${match[0]}`);
    }
  });
}

const animationOptionLiteral = /\b(?:duration|delay)\s*:\s*\d+(?:\.\d+)?\b/g;
for (const file of globSync('client/src/**/*.{ts,tsx}')) {
  if (webAnimationRecipeOwners.has(file) || /\.(?:test|spec)\.[^.]+$/.test(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(animationOptionLiteral)) {
      failures.push(`${file}:${index + 1}: put Web Animation ${match[0]} in a registered motion recipe owner`);
    }
  });
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Motion check passed: all CSS and Web Animation durations use registered motion owners.');
}
