import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const exceptions = new Set(['tokens.css']);
const timeLiteral = /(?<![-\w])(?:\d*\.)?\d+m?s\b/g;
const failures = [];
for (const file of globSync('client/src/styles/*.css')) {
  if (exceptions.has(file.split('/').at(-1))) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const code = line.replace(/\/\*.*?\*\//g, '');
    for (const match of code.matchAll(timeLiteral)) {
      failures.push(`${file}:${index + 1}: use a named --motion-* token instead of ${match[0]}`);
    }
  });
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Motion check passed: shared styles contain no hard-coded durations.');
}
