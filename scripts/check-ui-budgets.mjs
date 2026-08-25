import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(projectRoot, 'client', 'dist');

const limits = {
  // Leave bounded room for the shared UI contract while keeping the entry
  // shell below a 125 KB compressed critical path. Route-owned ribbon CSS and
  // activation-only icon motion must remain split out of these totals.
  app: { javascript: 110 * 1024, css: 12 * 1024 },
  marketing: { javascript: 5 * 1024, total: 25 * 1024 },
};

async function gzipBytes(path) {
  return gzipSync(await readFile(path), { level: 9 }).byteLength;
}

async function receipt(name, htmlPath) {
  const absoluteHtml = join(distRoot, htmlPath);
  const html = await readFile(absoluteHtml, 'utf8');
  const references = [
    ...new Set(
      Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g), (match) => match[1]),
    ),
  ];

  let javascript = 0;
  let css = 0;
  const assets = [];
  for (const reference of references) {
    const bytes = await gzipBytes(join(distRoot, reference.slice(1)));
    assets.push({ reference, bytes });
    if (reference.endsWith('.js')) javascript += bytes;
    if (reference.endsWith('.css')) css += bytes;
  }

  const htmlBytes = gzipSync(html, { level: 9 }).byteLength;
  return { name, html: htmlBytes, javascript, css, total: htmlBytes + javascript + css, assets };
}

const receipts = [
  await receipt('app', 'index.html'),
  await receipt('marketing', join('welcome', 'index.html')),
];

const format = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;
let failed = false;

for (const item of receipts) {
  console.log(
    `${item.name}: ${format(item.total)} critical ` +
      `(HTML ${format(item.html)}, JS ${format(item.javascript)}, CSS ${format(item.css)})`,
  );

  for (const [metric, limit] of Object.entries(limits[item.name])) {
    if (item[metric] <= limit) continue;
    failed = true;
    console.error(
      `${item.name} ${metric} exceeds its ${format(limit)} budget: ${format(item[metric])}`,
    );
  }
}

if (failed) process.exitCode = 1;
