/**
 * Builds every sprite and packs them into the atlases the Roku channel loads.
 *
 *   node tools/art/build-art.mjs [--only=fish,critters] [--quality=82] [--png]
 *
 * Inputs : the generator modules listed in MODULES (each exports IDS and build(id) -> SpriteDef).
 * Outputs: channel/assets/<atlas>.webp   packed sprite sheets (lossy WebP, lossless alpha)
 *          channel/assets/sprites.json   rig data: for every sprite its parts as
 *              [atlas, x, y, w, h, pivotX, pivotY, atX, atY, animKind, p1, p2, p3, p4]
 *          tools/art/.cache/atlas-*.png  review copies
 *
 * Rendered sprites are cached by (module source hash, id) so rebuilding after a small change is fast.
 * Rectangles are placed on a 4 px grid with a 4 px gutter so the half and quarter size copies the
 * device makes at load time (for clean down-scaling) stay aligned and never bleed into neighbours.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Img, over, savePng, saveWebp, toRGBA8, fromRGBA8 } from './lib/core.mjs';
import { validate } from './lib/sprite.mjs';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../channel/assets');
const CACHE = path.join(HERE, '.cache');
const args = process.argv.slice(2);
const flag = (n, d) => {
  const a = args.find((x) => x === `--${n}` || x.startsWith(`--${n}=`));
  if (!a) return d;
  return a.includes('=') ? a.slice(n.length + 3) : true;
};

/** group: which atlas family a module's sprites go to (kept apart so regions can be loaded separately later). */
const MODULES = [
  { name: 'fish', file: 'fish.mjs', group: 'creatures' },
  { name: 'critters', file: 'critters.mjs', group: 'creatures' },
  { name: 'flora', file: 'flora.mjs', group: 'kit' },
  { name: 'rocks', file: 'rocks.mjs', group: 'kit' },
  { name: 'fx', file: 'fx.mjs', group: 'ui' },
  { name: 'ui', file: 'ui.mjs', group: 'ui' },
];
const ATLAS_MAX = 2048;
const GRID = 4;
const GUTTER = 4;
const KIND = { tail: 1, wave: 2, flap: 3, sway: 4, pulse: 5, bob: 6 };

const only = flag('only', null);
const quality = Number(flag('quality', 82));
const usePng = !!flag('png', false);

function cacheKey(modFile, id) {
  const h = crypto.createHash('sha1');
  for (const f of [modFile, 'lib/core.mjs', 'lib/light.mjs', 'lib/sprite.mjs', 'looks.mjs']) {
    const p = path.join(HERE, f);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  h.update(id);
  return h.digest('hex').slice(0, 20);
}

/** SpriteDefs hold float images; cache them as raw float files. */
function saveDef(file, def) {
  const meta = { lenPx: def.lenPx, anchor: def.anchor, tintable: !!def.tintable, extra: def.extra ?? null, parts: def.parts.map((p) => ({ w: p.img.w, h: p.img.h, pivot: p.pivot, at: p.at, anim: p.anim ?? null })) };
  const head = Buffer.from(JSON.stringify(meta));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length);
  const bufs = [len, head];
  for (const p of def.parts) bufs.push(Buffer.from(p.img.d.buffer, p.img.d.byteOffset, p.img.d.byteLength));
  fs.writeFileSync(file, Buffer.concat(bufs));
}
function loadDef(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(0);
  const meta = JSON.parse(buf.subarray(4, 4 + n).toString());
  let off = 4 + n;
  const parts = meta.parts.map((p) => {
    const img = new Img(p.w, p.h);
    const bytes = p.w * p.h * 16;
    img.d.set(new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + bytes)));
    off += bytes;
    return { img, pivot: p.pivot, at: p.at, anim: p.anim };
  });
  return { lenPx: meta.lenPx, anchor: meta.anchor, tintable: meta.tintable, extra: meta.extra, parts };
}

const up = (v, g) => Math.ceil(v / g) * g;

/** Shelf packer: tallest first, rows of equal-ish height. Returns pages of placed rectangles. */
function pack(rects, maxW, maxH) {
  const sorted = rects.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  const pages = [];
  for (const r of sorted) {
    const w = up(r.w, GRID) + GUTTER;
    const h = up(r.h, GRID) + GUTTER;
    if (w > maxW || h > maxH) throw new Error(`Sprite part ${r.id} is larger than an atlas (${r.w}x${r.h})`);
    let placed = false;
    for (const pg of pages) {
      for (const sh of pg.shelves) {
        if (h <= sh.h && sh.x + w <= maxW) {
          r.page = pg.index;
          r.x = sh.x;
          r.y = sh.y;
          sh.x += w;
          placed = true;
          break;
        }
      }
      if (placed) break;
      if (pg.y + h <= maxH) {
        pg.shelves.push({ x: w, y: pg.y, h });
        r.page = pg.index;
        r.x = 0;
        r.y = pg.y;
        pg.y += h;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const pg = { index: pages.length, y: h, shelves: [{ x: w, y: 0, h }] };
      pages.push(pg);
      r.page = pg.index;
      r.x = 0;
      r.y = 0;
    }
  }
  for (const pg of pages) {
    pg.w = up(Math.max(...pg.shelves.map((s) => s.x)), GRID);
    pg.h = up(pg.y, GRID);
  }
  return pages;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
  const groups = new Map();
  const sprites = {};
  const t0 = Date.now();
  let rendered = 0;
  let cached = 0;
  for (const mod of MODULES) {
    if (only && !String(only).split(',').includes(mod.name)) continue;
    const file = path.join(HERE, mod.file);
    if (!fs.existsSync(file)) {
      console.log(`- ${mod.name}: (module not present yet, skipped)`);
      continue;
    }
    const m = await import(file);
    const ids = m.IDS;
    for (const id of ids) {
      const key = cacheKey(mod.file, id);
      const cf = path.join(CACHE, `${mod.name}-${id.replace(/[^a-zA-Z0-9_]/g, '_')}-${key}.spr`);
      let def;
      if (fs.existsSync(cf)) {
        def = loadDef(cf);
        cached++;
      } else {
        def = m.build(id);
        const issues = validate(id, def);
        if (issues.length) throw new Error(issues.join('\n'));
        saveDef(cf, def);
        rendered++;
      }
      if (sprites[id]) throw new Error(`Duplicate sprite id ${id}`);
      sprites[id] = { def, group: mod.group };
      if (!groups.has(mod.group)) groups.set(mod.group, []);
      def.parts.forEach((p, i) => groups.get(mod.group).push({ id: `${id}#${i}`, sprite: id, part: i, w: p.img.w, h: p.img.h, img: p.img }));
    }
    console.log(`- ${mod.name}: ${ids.length} sprites`);
  }

  const atlases = [];
  let totalBytes = 0;
  let totalPixels = 0;
  for (const [group, rects] of groups) {
    const pages = pack(rects, ATLAS_MAX, ATLAS_MAX);
    for (const pg of pages) {
      const img = new Img(pg.w, pg.h);
      for (const r of rects) if (r.page === pg.index) over(img, r.img, r.x, r.y);
      const name = `${group}${pg.index}`;
      const file = path.join(OUT, `${name}.${usePng ? 'png' : 'webp'}`);
      if (usePng) await savePng(img, file);
      else await saveWebp(img, file, quality);
      await savePng(img, path.join(CACHE, `atlas-${name}.png`));
      const bytes = fs.statSync(file).size;
      totalBytes += bytes;
      totalPixels += pg.w * pg.h;
      pg.atlasIndex = atlases.length;
      atlases.push({ file: path.basename(file), w: pg.w, h: pg.h, group });
      console.log(`  ${path.basename(file)}  ${pg.w}x${pg.h}  ${(bytes / 1024).toFixed(0)} KB`);
    }
    for (const r of rects) r.atlas = pages[r.page].atlasIndex;
  }

  // ---- rig data
  const r2 = (v) => Math.round(v * 100) / 100;
  const outSprites = {};
  const partRect = new Map();
  for (const rects of groups.values()) for (const r of rects) partRect.set(r.id, r);
  for (const [id, { def }] of Object.entries(sprites)) {
    const parts = def.parts.map((p, i) => {
      const r = partRect.get(`${id}#${i}`);
      const a = p.anim;
      let k = 0;
      let v = [0, 0, 0, 0];
      if (a) {
        k = KIND[a.kind];
        if (a.kind === 'tail') v = [a.rot ?? 0, a.squash ?? 0, a.amp ?? 0, a.lag ?? 0];
        else if (a.kind === 'wave') v = [a.amp ?? 0, a.lag ?? 0, 0, 0];
        else v = [a.amp ?? 0, a.rate ?? 1, a.phase ?? 0, 0];
      }
      return [r.atlas, r.x, r.y, p.img.w, p.img.h, Math.round(p.pivot[0]), Math.round(p.pivot[1]), Math.round(p.at[0]), Math.round(p.at[1]), k, ...v.map(r2)];
    });
    const o = { len: def.lenPx, base: def.anchor === 'base' ? 1 : 0, parts };
    if (def.tintable) o.tint = 1;
    if (def.extra) o.x = def.extra;
    // overall bounds relative to the origin (for culling and layout)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of def.parts) {
      x0 = Math.min(x0, p.at[0] - p.pivot[0]);
      y0 = Math.min(y0, p.at[1] - p.pivot[1]);
      x1 = Math.max(x1, p.at[0] - p.pivot[0] + p.img.w);
      y1 = Math.max(y1, p.at[1] - p.pivot[1] + p.img.h);
    }
    o.box = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
    outSprites[id.toLowerCase()] = o;
  }
  // sheets from an earlier build that are no longer referenced would only bloat the package
  if (!only) {
    const keep = new Set(atlases.map((a) => a.file));
    for (const f of fs.readdirSync(OUT)) if (/\.(webp|png)$/.test(f) && !keep.has(f)) fs.rmSync(path.join(OUT, f));
  }
  const json = JSON.stringify({ atlases, sprites: outSprites });
  fs.writeFileSync(path.join(OUT, 'sprites.json'), json);
  console.log(`sprites: ${Object.keys(outSprites).length}  rendered ${rendered}, cached ${cached}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`atlases: ${atlases.length}, ${(totalBytes / 1024).toFixed(0)} KB on disk, ${(totalPixels * 4 / 1048576).toFixed(1)} MB as textures, sprites.json ${(json.length / 1024).toFixed(0)} KB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
