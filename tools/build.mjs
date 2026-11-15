/**
 * Packages the channel: zips channel/ into dist/reefbound.zip (manifest at the zip root, as Roku
 * requires) and reports the size against the 4 MB certification limit.
 *
 *   node tools/build.mjs [--out=dist/reefbound.zip] [--no-limit]
 *
 * Already-compressed assets (WebP, JPEG, PNG, MP3) are stored; everything else is deflated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'channel');
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = path.resolve(ROOT, outArg ? outArg.slice(6) : 'dist/reefbound.zip');
const LIMIT = 4 * 1024 * 1024;
const STORE = new Set(['.webp', '.jpg', '.jpeg', '.png', '.mp3']);

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

const files = walk(SRC);
if (!files.some((f) => f.rel === 'manifest')) throw new Error('channel/manifest is missing');
const entries = {};
const byDir = {};
for (const f of files) {
  const data = fs.readFileSync(f.full);
  const level = STORE.has(path.extname(f.rel).toLowerCase()) ? 0 : 9;
  entries[f.rel] = [new Uint8Array(data), { level }];
}
const zip = zipSync(entries, { mtime: new Date('2026-01-01T00:00:00Z') });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zip);

// Per-folder breakdown of the compressed size (each file zipped on its own for the estimate).
for (const f of files) {
  const top = f.rel.includes('/') ? f.rel.split('/')[0] : '(root)';
  const one = zipSync({ [f.rel]: entries[f.rel] }).length - 22 - 46 - 30 - 2 * f.rel.length;
  byDir[top] = (byDir[top] ?? 0) + Math.max(0, one);
}
const kb = (n) => `${(n / 1024).toFixed(0).padStart(6)} KB`;
console.log(`Packaged ${files.length} files -> ${path.relative(ROOT, OUT)}`);
for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(10)} ${kb(n)}`);
console.log(`  ${'TOTAL'.padEnd(10)} ${kb(zip.length)}  (${((zip.length / LIMIT) * 100).toFixed(1)} % of the 4 MB limit)`);
if (zip.length > LIMIT && !args.includes('--no-limit')) {
  console.error('Package exceeds the 4 MB Roku certification limit.');
  process.exit(1);
}
