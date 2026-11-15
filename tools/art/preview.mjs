/**
 * Review sheet for any art generator module.
 *   node tools/art/preview.mjs <module.mjs> [--cols=N] [--px=N] [--scale=F] [--out=name] [--tints=#hex,#hex] [id ...]
 * The module must export IDS (array) and build(id, opts) -> SpriteDef (see lib/sprite.mjs).
 * Writes tools/art/.cache/<name>-preview.png and prints its path; open it to check the art.
 */
import path from 'node:path';
import fs from 'node:fs';
import { flatten, validate } from './lib/sprite.mjs';
import { contactSheet, savePng, Img, over, hex } from './lib/core.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const modPath = path.resolve(args.find((a) => !a.startsWith('--')));
const ids = args.filter((a) => !a.startsWith('--')).slice(1);
const mod = await import(modPath);
const list = ids.length ? ids : mod.IDS;
const px = flag('px', null);
const scale = Number(flag('scale', 1));
const items = [];
const t0 = Date.now();
let problems = 0;
for (const id of list) {
  const def = mod.build(id, px ? { px: Number(px) } : {});
  for (const msg of validate(id, def)) {
    console.log('PROBLEM', msg);
    problems++;
  }
  let { img } = flatten(def);
  if (def.tintable) {
    // Tintable (white-albedo) sprites are multiplied by a colour on the device; show them tinted.
    const tints = (flag('tints', '#ff7aa8,#ff9d5c,#ffd25e,#c58cff,#7fe0c4,#8fbf45,#e05aa0,#5ad1c6')).split(',').map(hex);
    const t = tints[items.length % tints.length];
    for (let i = 0; i < img.w * img.h; i++) {
      img.d[i * 4] *= t[0];
      img.d[i * 4 + 1] *= t[1];
      img.d[i * 4 + 2] *= t[2];
    }
  }
  if (scale !== 1) {
    // box-ish downscale for overview sheets
    const w = Math.max(1, Math.round(img.w * scale));
    const h = Math.max(1, Math.round(img.h * scale));
    const o = new Img(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x / scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) / scale));
        const y0 = Math.floor(y / scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) / scale));
        let n = 0;
        for (let yy = y0; yy < Math.min(img.h, y1); yy++)
          for (let xx = x0; xx < Math.min(img.w, x1); xx++) {
            const i = (yy * img.w + xx) * 4;
            for (let c = 0; c < 4; c++) o.d[(y * w + x) * 4 + c] += img.d[i + c];
            n++;
          }
        if (n) for (let c = 0; c < 4; c++) o.d[(y * w + x) * 4 + c] /= n;
      }
    img = o;
  }
  items.push(img);
}
const cw = Math.max(...items.map((i) => i.w)) + 12;
const ch = Math.max(...items.map((i) => i.h)) + 12;
const cols = Math.min(items.length, Number(flag('cols', 5)));
const sheet = contactSheet(items, cols, { w: cw, h: ch });
const name = flag('out', path.basename(modPath, '.mjs'));
const outDir = new URL('./.cache/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${name}-preview.png`);
await savePng(sheet, out);
console.log(`${list.length} sprites in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out} (${sheet.w}x${sheet.h})${problems ? `, ${problems} problem(s)` : ''}`);
