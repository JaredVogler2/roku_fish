/**
 * Offline preview of a composed scene: draws the display lists the way the channel does (same
 * transform, tint and light maths) so composition can be judged without booting the simulator.
 *
 *   node tools/art/scene-preview.mjs <region> [--sector=N] [--x= --y= --vh=] [--ppu=N]
 *        [--light=day|dusk|night] [--debug] [--out=name]
 *
 *   (default)     the whole region, 72 x 40.5 units
 *   --sector=N    one sector (24 x 13.5 units) at the widest in-game zoom
 *   --x --y --vh  an in-game camera: centre and visible height in units (1280x720 output)
 *   --debug       overlay collision shapes (magenta), shelters (green) and surfaces (yellow)
 * Output: tools/art/.cache/<name>.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '../../channel/assets');
const DATA = path.resolve(HERE, '../../channel/data');
const args = process.argv.slice(2);
const flag = (n, d) => {
  const a = args.find((x) => x === `--${n}` || x.startsWith(`--${n}=`));
  if (!a) return d;
  return a.includes('=') ? a.slice(n.length + 3) : true;
};
const region = args.find((a) => !a.startsWith('--')) ?? 'reef';
const meta = JSON.parse(fs.readFileSync(path.join(ASSETS, 'sprites.json')));
const scene = JSON.parse(fs.readFileSync(path.join(DATA, `scene_${region}.json`)));
const biomes = JSON.parse(fs.readFileSync(path.join(DATA, 'biomes.json')));
const src = JSON.parse(fs.readFileSync(path.join(HERE, 'data', `scene_${region}.json`)));

const lightName = flag('light', 'day');
const DL = lightName === 'night' ? 0 : lightName === 'dusk' ? 0.5 : 1;

/** Same formula as LightBase() x LightDepth() in channel/source/render.brs. row may be fractional. */
function lightFor(dl, row, biome) {
  let r = 0.3 + 0.7 * dl;
  let g = 0.42 + 0.58 * dl;
  let b = 0.7 + 0.3 * dl;
  const warm = 4 * dl * (1 - dl);
  g *= 1 - 0.1 * warm;
  b *= 1 - 0.24 * warm;
  const d = row * 0.5;
  r *= 1 - 0.3 * d;
  g *= 1 - 0.17 * d;
  b *= 1 - 0.03 * d;
  if (biome === 'twilightWreck') {
    r *= 0.8;
    g *= 0.86;
  } else if (biome === 'deepCanyon') {
    r *= 0.84;
    g *= 0.82;
  }
  return [r, g, b];
}

let view;
if (flag('sector', null) !== null) {
  const s = Number(flag('sector'));
  view = { x: (s % 3) * 24 + 12, y: (2 - Math.floor(s / 3)) * 13.5 + 6.75, w: 1280, h: 720, ppu: 720 / 13.5 };
} else if (flag('x', null) !== null) {
  const vh = Number(flag('vh', 10));
  view = { x: Number(flag('x')), y: Number(flag('y', 20)), w: 1280, h: 720, ppu: 720 / vh };
} else {
  const ppu = Number(flag('ppu', 24));
  view = { x: 36, y: 20.25, w: Math.round(72 * ppu), h: Math.round(40.5 * ppu), ppu };
}
if (flag('ppu', null) !== null && flag('sector', null) === null && flag('x', null) === null) view.ppu = Number(flag('ppu'));

const atlases = [];
for (const a of meta.atlases) atlases.push(await loadImage(path.join(HERE, '.cache', `atlas-${a.file.replace(/\.\w+$/, '')}.png`)));

const cv = createCanvas(view.w, view.h);
const g = cv.getContext('2d');
const X = (wx) => view.w / 2 + (wx - view.x) * view.ppu;
const Y = (wy) => view.h / 2 - (wy - view.y) * view.ppu;

// ---- water: each sector's biome gradient by depth
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
for (let si = 0; si < 9; si++) {
  const col = si % 3;
  const row = Math.floor(si / 3);
  const b = biomes[scene.sectors[si].biome.toLowerCase()];
  const top = mix(b.night_top, b.day_top, DL);
  const deep = mix(b.night_deep, b.day_deep, DL);
  const y1 = (2 - row) * 13.5 + 13.5;
  const y0 = (2 - row) * 13.5;
  const c0 = mix(top, deep, row / 3);
  const c1 = mix(top, deep, (row + 1) / 3);
  const gr = g.createLinearGradient(0, Y(y1), 0, Y(y0));
  gr.addColorStop(0, `rgb(${c0.map(Math.round)})`);
  gr.addColorStop(1, `rgb(${c1.map(Math.round)})`);
  g.fillStyle = gr;
  g.fillRect(X(col * 24), Y(y1), 24 * view.ppu + 1, 13.5 * view.ppu + 1);
}

// ---- tinted sprite parts (cached)
const tintCache = new Map();
function tinted(atlasIdx, x, y, w, h, rgb) {
  const key = `${atlasIdx}:${x}:${y}:${rgb}`;
  let c = tintCache.get(key);
  if (!c) {
    c = createCanvas(w, h);
    const t = c.getContext('2d');
    t.drawImage(atlases[atlasIdx], x, y, w, h, 0, 0, w, h);
    t.globalCompositeOperation = 'multiply';
    t.fillStyle = `rgb(${rgb})`;
    t.fillRect(0, 0, w, h);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(atlases[atlasIdx], x, y, w, h, 0, 0, w, h);
    tintCache.set(key, c);
  }
  return c;
}

let drawn = 0;
function drawLayer(si, layer) {
  const sec = scene.sectors[si];
  const row = Math.floor(si / 3);
  const light = lightFor(DL, row, sec.biome);
  const tints = scene.tints[sec.biome.toLowerCase()] ?? [];
  for (const a of sec[layer]) {
    const id = scene.names[a[0]];
    const spr = meta.sprites[id];
    if (!spr) continue;
    const tc = a[6] >= 0 ? tints[a[6]] : [255, 255, 255, 255];
    // scenery is lit by its own depth, so tall formations shade smoothly from sunlit to deep
    const li = lightFor(DL, Math.min(2.3, Math.max(0, (40.5 - a[2]) / 13.5 - 0.5)), sec.biome);
    const rgb = [0, 1, 2].map((i) => Math.min(255, Math.round(tc[i] * li[i])));
    const k = view.ppu / spr.len;
    const sx = a[3] * k * (a[9] === 1 ? -1 : 1);
    const sy = a[4] * k;
    for (const p of spr.parts) {
      const img = tinted(p[0], p[1], p[2], p[3], p[4], rgb);
      g.save();
      g.globalAlpha = (tc[3] ?? 255) / 255;
      g.translate(X(a[1]) + p[7] * sx, Y(a[2]) + p[8] * sy);
      g.rotate((-a[5] * Math.PI) / 180);
      g.scale(sx, sy);
      g.drawImage(img, -p[5], -p[6]);
      g.restore();
      drawn++;
    }
  }
}
for (const layer of ['back', 'rock', 'flora', 'front']) for (let si = 0; si < 9; si++) drawLayer(si, layer);

if (flag('debug', false)) {
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(255,0,255,0.9)';
  for (const s of src.solids) {
    g.beginPath();
    if (s.kind === 'circle') g.arc(X(s.x), Y(s.y), s.r * view.ppu, 0, Math.PI * 2);
    else if (s.kind === 'box') g.roundRect(X(s.x - s.hw), Y(s.y + s.hh), s.hw * 2 * view.ppu, s.hh * 2 * view.ppu, (s.r ?? 0) * view.ppu);
    else if (s.kind === 'capsule') {
      const x0 = Math.min(s.ax, s.bx) - s.r;
      const x1 = Math.max(s.ax, s.bx) + s.r;
      const y0 = Math.min(s.ay, s.by) - s.r;
      const y1 = Math.max(s.ay, s.by) + s.r;
      g.roundRect(X(x0), Y(y1), (x1 - x0) * view.ppu, (y1 - y0) * view.ppu, s.r * view.ppu);
    }
    g.stroke();
  }
  g.strokeStyle = 'rgba(80,255,120,0.9)';
  for (const s of src.shelters) g.strokeRect(X(s.x - s.hw), Y(s.y + s.hh), s.hw * 2 * view.ppu, s.hh * 2 * view.ppu);
  g.strokeStyle = 'rgba(255,230,60,0.9)';
  for (const s of src.surfaces) {
    g.beginPath();
    s.ys.forEach((y, i) => {
      const x = s.x0 + ((s.x1 - s.x0) * i) / (s.ys.length - 1);
      if (i === 0) g.moveTo(X(x), Y(y));
      else g.lineTo(X(x), Y(y));
    });
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.beginPath();
  for (let i = 0; i <= src.floor.length; i++) {
    const x = i * src.floorRes;
    const y = src.floor[i % src.floor.length];
    if (i === 0) g.moveTo(X(x), Y(y));
    else g.lineTo(X(x), Y(y));
  }
  g.stroke();
}

const out = path.join(HERE, '.cache', `${flag('out', `scene-${region}`)}.png`);
fs.writeFileSync(out, cv.toBuffer('image/png'));
console.log(`${out}  ${view.w}x${view.h}  ${drawn} draws`);
