/**
 * Scene composer: turns each region's collision layout into the display lists the Roku channel
 * draws (channel/data/scene_<region>.json).
 *
 *   node tools/art/scene.mjs
 *
 * Input : tools/art/data/scene_<region>.json (solids, props, shelters, surfaces, seabed - exported
 *         from the web game's region builder) and channel/assets/sprites.json (the kit that exists).
 * Output: per sector four layers of placements
 *           back   cave interiors and large hazy growth behind the rock
 *           rock   rock, sand and wreck timber dressing the collision shapes exactly
 *           flora  corals, sponges, grass and scatter standing on the rock
 *           front  cover drawn over the animals (seagrass fronts, coral veils, cave gloom)
 *         each placement = [sprite, x, y, scaleX, scaleY, rotation, tint, swayAmp, swayRate, flags]
 *         (flags: 1 = mirrored, 2 = already coloured for its depth, so the device shades it less)
 *         plus one tint table per biome (the kit is neutral; biomes recolour it).
 * Everything is seeded, so the same input always produces the same reef.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng as makeRng, hashStr, clamp } from './lib/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const OUT = path.resolve(HERE, '../../channel/data');
const SPRITES = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../channel/assets/sprites.json'))).sprites;
const BIOMES = JSON.parse(fs.readFileSync(path.join(DATA, 'biomes.json')));
const PPU = 96;

const has = (id) => !!SPRITES[id];
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const scaleRgb = (c, k) => c.map((v) => Math.round(clamp(v * k, 0, 255)));
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** How much flora each biome grows and what it favours. */
const GROWTH = {
  sunlitGardens: { density: 1.0, kinds: ['coral_branch', 'coral_table', 'coral_brain', 'coral_boulder', 'coral_fan', 'coral_soft', 'coral_mushroom', 'coral_fire', 'coral_encrust', 'coral_pillar', 'sponge_tube', 'weed'], floor: ['pebbles', 'shell', 'weed', 'xmas_worm'] },
  seagrassNursery: { density: 0.7, kinds: ['weed', 'coral_mushroom', 'coral_soft', 'coral_encrust', 'sponge_vase', 'coral_boulder', 'weed', 'weed'], floor: ['pebbles', 'shell', 'weed', 'shell', 'urchin_decor'] },
  midReefDropoff: { density: 0.85, kinds: ['coral_fan', 'whip', 'sponge_tube', 'coral_soft', 'coral_branch', 'coral_encrust', 'sponge_vase', 'coral_pillar', 'coral_table'], floor: ['pebbles', 'shell', 'urchin_decor', 'weed'] },
  twilightWreck: { density: 0.6, kinds: ['coral_soft', 'whip', 'sponge_tube', 'coral_fan', 'coral_encrust', 'sponge_vase', 'barnacle'], floor: ['pebbles', 'shell', 'urchin_decor'] },
  openBluewater: { density: 0.45, kinds: ['coral_table', 'coral_fan', 'coral_soft', 'whip'], floor: ['pebbles'] },
  deepCanyon: { density: 0.65, kinds: ['whip', 'coral_fan', 'sponge_tube', 'coral_soft', 'sponge_vase', 'coral_encrust'], floor: ['pebbles', 'shell', 'urchin_decor'] },
};
const VARIANTS = {};
for (const id of Object.keys(SPRITES)) {
  const m = id.match(/^(.*)_(\d+)$/);
  if (m) (VARIANTS[m[1]] ??= []).push(id);
}
const variant = (family, r) => {
  const v = VARIANTS[family];
  if (!v || !v.length) return has(family) ? family : null;
  return v[Math.floor(r() * v.length) % v.length];
};
const PALETTE_OF = (family) =>
  family.startsWith('coral_soft') ? 'soft'
    : family.startsWith('coral_fan') || family.startsWith('whip') ? 'fan'
      : family.startsWith('grass') || family.startsWith('weed') ? 'grass'
        : family.startsWith('sponge') || family.startsWith('hang') ? 'sponge'
          : family.startsWith('pebbles') || family.startsWith('barnacle') ? 'rock'
            : family.startsWith('shell') || family.startsWith('xmas') || family.startsWith('urchin') ? 'white'
              : 'coral';

function compose(regionId) {
  const scene = JSON.parse(fs.readFileSync(path.join(DATA, `scene_${regionId}.json`)));
  const names = [];
  const nameIdx = new Map();
  const nid = (id) => {
    if (!nameIdx.has(id)) {
      nameIdx.set(id, names.length);
      names.push(id);
    }
    return nameIdx.get(id);
  };
  const tints = {};
  const tintOf = (biome, rgb, a = 255) => {
    const list = (tints[biome] ??= []);
    const key = [...rgb, a].join(',');
    let i = list.findIndex((t) => t.join(',') === key);
    if (i < 0) {
      i = list.length;
      list.push([...rgb, a]);
    }
    return i;
  };
  const sectors = scene.sectors.map((s) => ({ biome: s.biome, sand: null, back: [], rock: [], flora: [], front: [] }));
  const floorAt = (x) => {
    const fx = (((x % 72) + 72) % 72) / scene.floorRes;
    const i0 = Math.floor(fx) % scene.floor.length;
    const i1 = (i0 + 1) % scene.floor.length;
    const t = fx - Math.floor(fx);
    return scene.floor[i0] * (1 - t) + scene.floor[i1] * t;
  };
  const sectorOf = (x, y) => {
    const col = clamp(Math.floor((((x % 72) + 72) % 72) / 24), 0, 2);
    const row = clamp(2 - Math.floor(clamp(y, 0, 40.49) / 13.5), 0, 2);
    return row * 3 + col;
  };
  /** Add a placement to a sector layer (skips sprites the kit does not have yet). */
  const add = (si, layer, id, x, y, sx, sy, o = {}) => {
    if (!id || !has(id)) return false;
    const biome = sectors[si].biome;
    const t = o.tint ? tintOf(biome, o.tint, o.alpha ?? 255) : -1;
    sectors[si][layer].push([nid(id), r2(((x % 72) + 72) % 72), r2(y), r3(sx), r3(sy), r2(o.rot ?? 0), t, r2(o.sway ?? 0), r2(o.rate ?? 0), (o.flip ? 1 : 0) | (o.keep ? 2 : 0)]);
    return true;
  };
  const look = (si) => BIOMES[sectors[si].biome];
  const rockTint = (si, r) => {
    const b = look(si);
    const base = hexRgb(b.rock[Math.floor(r() * b.rock.length) % b.rock.length]);
    return scaleRgb(base, 1.62 + r() * 0.12);
  };
  const paletteTint = (si, pal, r) => {
    const b = look(si);
    if (pal === 'white') return [255, 255, 255];
    if (pal === 'rock') return rockTint(si, r);
    if (pal === 'sponge') return hexRgb(['#d98a52', '#c9a24f', '#b56bb0', '#d4604a', '#8f7ad6'][Math.floor(r() * 5)]);
    const list = b[pal] ?? b.coral;
    return hexRgb(list[Math.floor(r() * list.length) % list.length]);
  };
  /**
   * Colour for things behind the play plane: aerial perspective, i.e. most of the way to the colour
   * of the water at that depth (a little darker so the silhouettes still read).
   */
  const backTint = (si, rgb, y = 20) => {
    const b = look(si);
    const k = Math.pow(clamp(1 - y / 40.5), 0.8);
    const water = mixRgb(hexRgb(b.waterTop), hexRgb(b.waterDeep), k);
    return mixRgb(scaleRgb(rgb, 0.7), scaleRgb(water, 0.92), 0.66);
  };

  // ------------------------------------------------------------------ rock
  /** Middle tiles come in two versions that join each other; mix them so long runs do not repeat. */
  const pickMid = (fam, key) => (has(`${fam}_m2`) && hashStr(`${fam}:${Math.round(key * 100)}`) % 100 < 45 ? `${fam}_m2` : `${fam}_m`);
  const hStrip = (si, fam, x0, x1, top, th, tint) => {
    const L = SPRITES[`${fam}_l`];
    const Mp = SPRITES[`${fam}_m`];
    if (!L || !Mp) return;
    const nominal = L.x?.nominal ?? 1;
    const sy = th / nominal;
    const capPx = L.parts[0][3] - L.parts[0][5] - (L.x?.ov ?? 0); // cap length without its margin and overlap
    const tilePx = Mp.parts[0][3] - (Mp.x?.ov ?? 0);
    const len = x1 - x0;
    let sxCap = clamp(sy, 0.55, 1.4);
    let capW = (capPx / PPU) * sxCap;
    if (capW * 2 > len * 0.9) {
      sxCap *= (len * 0.5) / capW;
      capW = len * 0.5;
    }
    const span = len - capW * 2;
    add(si, 'rock', `${fam}_l`, x0, top, sxCap, sy, { tint });
    if (span > 0.02) {
      const tileW0 = (tilePx / PPU) * clamp(sy, 0.6, 1.3);
      const n = Math.max(1, Math.round(span / tileW0));
      const tw = span / n;
      const sxm = (tw * PPU) / tilePx;
      for (let i = 0; i < n; i++) add(si, 'rock', pickMid(fam, x0 + i * 7.31 + top), x0 + capW + i * tw, top, sxm, sy, { tint });
    }
    add(si, 'rock', `${fam}_r`, x1 - capW, top, sxCap, sy, { tint });
  };
  const vStrip = (si, fam, x0, wd, top, bottom, tint, capBottom = true) => {
    const T = SPRITES[`${fam}_t`];
    const Mp = SPRITES[`${fam}_m`];
    const B = SPRITES[`${fam}_b`];
    if (!T || !Mp) return;
    const nominal = T.x?.nominal ?? 1;
    const sx = wd / nominal;
    const capPx = T.parts[0][4] - T.parts[0][6] - (T.x?.ov ?? 0);
    const botPx = B ? B.parts[0][4] - 28 : 0;
    const tilePx = Mp.parts[0][4] - (Mp.x?.ov ?? 0);
    const len = top - bottom;
    let syCap = clamp(sx, 0.55, 1.4);
    let capH = (capPx / PPU) * syCap;
    let botH = capBottom && B ? (botPx / PPU) * syCap : 0;
    if (capH + botH > len * 0.9) {
      const k = (len * 0.9) / (capH + botH);
      syCap *= k;
      capH *= k;
      botH *= k;
    }
    const span = len - capH - botH;
    // sector of each piece follows its own position so tall pillars are drawn from every sector they cross
    const put = (id, y, sy) => add(sectorOf(x0 + wd / 2, clamp(y - 0.01, 0.01, 40.4)), 'rock', id, x0, y, sx, sy, { tint });
    put(`${fam}_t`, top, syCap);
    if (span > 0.02) {
      const tileH0 = (tilePx / PPU) * clamp(sx, 0.6, 1.3);
      const n = Math.max(1, Math.round(span / tileH0));
      const th = span / n;
      const sym = (th * PPU) / tilePx;
      for (let i = 0; i < n; i++) put(pickMid(fam, x0 * 3.7 + i * 5.13), top - capH - i * th, sym);
    }
    if (botH > 0) put(`${fam}_b`, bottom + botH, syCap);
  };

  for (const rk of scene.rocks) {
    const si = rk.sector;
    const r = makeRng(rk.seed);
    const tint = rk.style === 'hull' || rk.style === 'mast' || rk.style === 'crate' ? hexRgb(['#8a6b4a', '#7d6248', '#94724e'][Math.floor(r() * 3)]) : rockTint(si, r);
    if (rk.kind === 'circle') {
      const id = variant('boulder', r);
      add(si, 'rock', id, rk.x, rk.y, rk.r * (1.02 + r() * 0.06), rk.r * (1.02 + r() * 0.06), { tint, flip: r() < 0.5 });
    } else if (rk.kind === 'box') {
      const { x, y, hw, hh } = rk;
      if (rk.style === 'crate') {
        const s = (hw * 2) / (SPRITES.crate?.x?.nominal ?? 1.58);
        add(si, 'rock', 'crate', x, y, s, s, { tint });
        continue;
      }
      const wood = rk.style === 'hull';
      if (hw >= hh * 1.15) {
        const th = hh * 2;
        const fam = wood ? 'plank' : th > 1.35 ? 'shelf' : 'slab';
        hStrip(si, fam, x - hw, x + hw, y + hh, th, tint);
      } else {
        const wd = hw * 2;
        const fam = wood ? 'plankv' : wd > 2.0 ? 'wall' : 'post';
        vStrip(si, fam, x - hw, wd, y + hh, Math.max(-0.8, y - hh), tint, y - hh > -0.5);
      }
    } else if (rk.kind === 'capsule') {
      const vertical = Math.abs(rk.ax - rk.bx) < 0.01;
      if (vertical) {
        const top = Math.max(rk.ay, rk.by) + rk.r;
        const bottom = Math.max(-0.8, Math.min(rk.ay, rk.by) - rk.r);
        const fam = rk.style === 'mast' ? 'plankv' : 'pillar';
        vStrip(si, fam, rk.ax - rk.r, rk.r * 2, top, bottom, tint, Math.min(rk.ay, rk.by) - rk.r > floorAt(rk.ax) + 0.4);
      } else {
        const x0 = Math.min(rk.ax, rk.bx) - rk.r;
        const x1 = Math.max(rk.ax, rk.bx) + rk.r;
        const fam = rk.style === 'mast' ? 'plank' : rk.r > 0.7 ? 'shelf' : 'slab';
        hStrip(si, fam, x0, x1, rk.ay + rk.r, rk.r * 2, tint);
      }
    }
  }

  // ------------------------------------------------------------------ encrusting colour on the rock faces
  const CRUST = {
    sunlitGardens: ['#d9799a', '#b98bd6', '#8fae5a', '#e0b060', '#d98a6a'],
    seagrassNursery: ['#8fae5a', '#a9b86a', '#d9a36a', '#c98aa8'],
    midReefDropoff: ['#b47ac8', '#c96a8e', '#6f9a8a', '#d0905a'],
    twilightWreck: ['#7f8fc0', '#9a7ab8', '#6f9a8a', '#a88a6a'],
    openBluewater: ['#8fa8c8', '#b98bd6'],
    deepCanyon: ['#8a6fc0', '#b0689a', '#5f8f9a'],
  };
  for (const rk of scene.rocks) {
    if (rk.style === 'hull' || rk.style === 'mast' || rk.style === 'crate') continue;
    let x0, x1, y0, y1;
    if (rk.kind === 'box') [x0, x1, y0, y1] = [rk.x - rk.hw, rk.x + rk.hw, rk.y - rk.hh, rk.y + rk.hh];
    else if (rk.kind === 'capsule') [x0, x1, y0, y1] = [Math.min(rk.ax, rk.bx) - rk.r, Math.max(rk.ax, rk.bx) + rk.r, Math.min(rk.ay, rk.by) - rk.r, Math.max(rk.ay, rk.by) + rk.r];
    else continue;
    y0 = Math.max(y0, floorAt((x0 + x1) / 2) + 0.2);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1.7 || h < 1.5) continue;
    const r = makeRng(rk.seed + 4242);
    const list = CRUST[sectors[rk.sector].biome] ?? CRUST.sunlitGardens;
    const n = Math.round(Math.min(18, (w * h) / 5.5));
    for (let i = 0; i < n; i++) {
      const sc = 0.4 + r() * 0.45;
      const mx = 1.05 * sc + 0.2;
      const my = 1.05 * sc + 0.2;
      if (w < mx * 2 || h < my * 2) continue;
      const x = x0 + mx + r() * (w - mx * 2);
      const y = y0 + my + r() * (h - my * 2);
      const tint = hexRgb(list[Math.floor(r() * list.length) % list.length]);
      add(sectorOf(x, clamp(y, 0.01, 40.4)), 'rock', variant('patch', r), x, y, sc, sc, { tint, alpha: 170 + Math.floor(r() * 80), flip: r() < 0.5, rot: Math.round(r() * 360) });
    }
  }

  // ------------------------------------------------------------------ seabed (bottom row)
  for (let col = 0; col < 3; col++) {
    const si = 6 + col;
    const sand = hexRgb(look(si).sand);
    const dark = hexRgb(look(si).sandDark);
    const x0 = col * 24;
    // the body of the seabed is a flat fill the device draws itself (one rectangle, any depth);
    // here only the rippled surface strip, segment by segment along the height field
    sectors[si].sand = mixRgb(sand, dark, 0.1);
    const seg = 2;
    for (let x = x0; x < x0 + 24 - 0.01; x += seg) {
      const h0 = floorAt(x);
      const h1 = floorAt(x + seg);
      const rot = (Math.atan2(h1 - h0, seg) * 180) / Math.PI;
      const len = Math.hypot(seg, h1 - h0) + 0.14;
      add(si, 'rock', 'sand_top', x - 0.06, h0, (len * PPU) / 384, 1.25, { tint: mixRgb(sand, dark, 0.1), rot, keep: true });
    }
  }

  // ------------------------------------------------------------------ caves and wreck holds
  for (const sh of scene.shelters) {
    if (sh.kind !== 'cave' && sh.kind !== 'wreck') continue;
    const si = sh.sector;
    // the back wall of the hollow: the formation's own rock, in shadow and shifted toward the water colour
    const wall = mixRgb(scaleRgb(hexRgb(look(si).rock[0]), 0.62), hexRgb(look(si).deepTint), 0.3);
    const w = sh.hw * 2 + 0.9;
    const h = sh.hh * 2 + 1.0;
    add(si, 'back', 'cave_back', sh.x - w / 2, sh.y + h / 2, (w * PPU) / 256, (h * PPU) / 192, { tint: wall });
    // gloom over whatever is inside, so occupants look tucked away rather than pasted on top
    const gw = sh.hw * 2 + 0.3;
    const gh = sh.hh * 2 + 0.3;
    add(si, 'front', 'fx_cave', sh.x - gw / 2, sh.y + gh / 2, (gw * PPU) / 128, (gh * PPU) / 128, { tint: scaleRgb(wall, 0.3), alpha: 84 });
  }

  // ------------------------------------------------------------------ authored props
  const taken = []; // [x, y, radius] spots that scatter must leave alone
  for (const a of scene.anchors) if (a.k !== 'open' && a.k !== 'burrow') taken.push([a.x, a.y, 0.45]);
  for (const st of scene.stations) taken.push([st.x, st.y, 1.1]);
  for (const f of scene.fixed) taken.push([f.x, f.y, 0.9]);
  for (const p of scene.passes) taken.push([p.x, p.y, 1.6]);
  const FAMILY = { branch: 'coral_branch', table: 'coral_table', brain: 'coral_brain', boulder: 'coral_boulder', fan: 'coral_fan', encrust: 'coral_encrust', mushroom: 'coral_mushroom', fire: 'coral_fire', soft: 'coral_soft', pillar: 'coral_pillar' };
  const VEIL = new Set(['branch', 'table', 'soft', 'fan', 'fire', 'pillar']);
  for (const p of scene.props) {
    const si = p.sector;
    const r = makeRng(p.seed);
    if (p.kind === 'grass') {
      const wd = p.w ?? 2;
      const n = Math.max(2, Math.round(wd / 0.5));
      const gl = look(si).grass;
      for (let i = 0; i < n; i++) {
        const gx = p.x - wd / 2 + ((i + 0.2 + r() * 0.6) / n) * wd;
        const tint = hexRgb(gl[Math.floor(r() * gl.length) % gl.length]);
        const s = p.s * (0.82 + r() * 0.3);
        add(si, 'flora', variant('grass_tuft', r), gx, p.y - 0.05, s, s, { tint: scaleRgb(tint, 0.8 + r() * 0.2), flip: r() < 0.5 });
      }
      // a thinner row in front of the animals: fish in the meadow are half hidden
      const nf = Math.max(1, Math.round(n * 0.45));
      for (let i = 0; i < nf; i++) {
        const gx = p.x - wd / 2 + ((i + 0.3 + r() * 0.4) / nf) * wd;
        const tint = hexRgb(gl[Math.floor(r() * gl.length) % gl.length]);
        const s = p.s * (0.7 + r() * 0.22);
        add(si, 'front', variant('grass_tuft', r), gx, p.y - 0.12, s, s, { tint, alpha: 205, flip: r() < 0.5 });
      }
      taken.push([p.x, p.y, wd / 2]);
    } else if (FAMILY[p.kind]) {
      const fam = FAMILY[p.kind];
      const id = variant(fam, r);
      const tint = paletteTint(si, PALETTE_OF(fam), r);
      const flip = r() < 0.5;
      add(si, 'flora', id, p.x, p.y - 0.04, p.s, p.s, { tint, flip });
      // shelter corals get a faint veil in front, so a fish inside reads as "among the branches"
      if (VEIL.has(p.kind)) add(si, 'front', id, p.x, p.y - 0.04, p.s, p.s, { tint, flip, alpha: 110 });
      taken.push([p.x, p.y, 0.7 * p.s]);
    } else if (p.kind === 'hullDecor') {
      const wd = p.w ?? 8;
      const n = Math.max(2, Math.round(wd / 3));
      for (let i = 0; i < n; i++) add(si, 'flora', 'porthole', p.x - wd / 2 + ((i + 0.5) / n) * wd, p.y + 0.9 + (r() - 0.5) * 0.3, 0.8, 0.8, { tint: [150, 140, 120] });
    }
  }

  // ------------------------------------------------------------------ scatter on every surface
  const free = (x, y, rad) => {
    for (const t of taken) {
      let dx = Math.abs(x - t[0]);
      if (dx > 36) dx = 72 - dx;
      if (dx < rad + t[2] && Math.abs(y - t[1]) < rad + t[2] + 0.4) return false;
    }
    return true;
  };
  const insideShelter = (x, y) => scene.shelters.some((s) => (s.kind === 'cave' || s.kind === 'wreck') && Math.abs(x - s.x) < s.hw + 0.3 && Math.abs(y - s.y) < s.hh + 0.4);
  const surfY = (s, x) => {
    const t = clamp((x - s.x0) / Math.max(0.001, s.x1 - s.x0), 0, 1) * (s.ys.length - 1);
    const i = Math.floor(t);
    return s.ys[i] + (s.ys[Math.min(s.ys.length - 1, i + 1)] - s.ys[i]) * (t - i);
  };
  for (const s of scene.surfaces) {
    const si = s.sector;
    const g = GROWTH[sectors[si].biome];
    const r = makeRng(hashStr(`${regionId}:surf:${s.id}`));
    const len = s.x1 - s.x0;
    const isFloor = s.kind === 'floor';
    const n = Math.round(len * (isFloor ? 1.05 : 1.5) * g.density);
    for (let i = 0; i < n; i++) {
      const x = s.x0 + r() * len;
      const y = surfY(s, x);
      const inCave = insideShelter(x, y + 0.3);
      const list = isFloor || inCave ? g.floor : r() < 0.25 ? g.floor : g.kinds;
      const fam = list[Math.floor(r() * list.length) % list.length];
      const small = fam.startsWith('pebbles') || fam.startsWith('shell') || fam.startsWith('xmas') || fam.startsWith('urchin') || fam.startsWith('barnacle') || fam.startsWith('weed');
      const sc = small ? 0.8 + r() * 0.6 : 0.55 + r() * 0.6;
      const rad = small ? 0.2 : 0.4 * sc;
      if (!free(x, y, rad)) continue;
      const id = variant(fam, r);
      if (!id) continue;
      const tint = scaleRgb(paletteTint(si, PALETTE_OF(fam), r), 0.86 + r() * 0.14);
      const sway = fam.startsWith('weed') ? 3 : 0;
      if (add(si, 'flora', id, x, y - 0.03, sc, sc, { tint, flip: r() < 0.5, sway, rate: 1.1 + r() })) taken.push([x, y, rad * 0.9]);
    }
    // large hazy growth behind the rock line: depth without parallax
    if (!isFloor || len > 6) {
      const nb = Math.round(len * 0.32 * g.density);
      for (let i = 0; i < nb; i++) {
        const x = s.x0 + r() * len;
        const y = surfY(s, x);
        if (insideShelter(x, y + 0.5)) continue;
        const fam = g.kinds[Math.floor(r() * g.kinds.length) % g.kinds.length];
        if (fam.startsWith('weed') || fam.startsWith('barnacle')) continue;
        const id = variant(fam, r);
        if (!id) continue;
        const sc = 1.3 + r() * 1.1;
        add(si, 'back', id, x, y - 0.25, sc, sc, { tint: backTint(si, paletteTint(si, PALETTE_OF(fam), r), y), flip: r() < 0.5, keep: true });
      }
    }
  }

  // ------------------------------------------------------------------ growth on walls and pillars
  const wrapD = (d) => (d > 36 ? d - 72 : d < -36 ? d + 72 : d);
  const solidAt = (x, y) => {
    if (y < floorAt(x)) return true;
    for (const q of scene.solids) {
      if (q.kind === 'circle') {
        if (Math.hypot(wrapD(x - q.x), y - q.y) < q.r) return true;
      } else if (q.kind === 'box') {
        if (Math.abs(wrapD(x - q.x)) < q.hw && Math.abs(y - q.y) < q.hh) return true;
      } else if (q.kind === 'capsule') {
        const px = q.ax + wrapD(x - q.ax);
        const vx = q.bx - q.ax;
        const vy = q.by - q.ay;
        const t = clamp(((px - q.ax) * vx + (y - q.ay) * vy) / (vx * vx + vy * vy || 1), 0, 1);
        if (Math.hypot(px - q.ax - vx * t, y - q.ay - vy * t) < q.r) return true;
      }
    }
    return false;
  };
  const WALL = ['coral_fan', 'coral_fan', 'whip', 'coral_soft', 'sponge_tube', 'coral_table', 'coral_encrust', 'coral_branch', 'sponge_vase'];
  for (const rk of scene.rocks) {
    if (rk.style === 'hull' || rk.style === 'mast' || rk.style === 'crate' || rk.kind === 'circle') continue;
    let x0, x1, y0, y1;
    if (rk.kind === 'box') [x0, x1, y0, y1] = [rk.x - rk.hw, rk.x + rk.hw, rk.y - rk.hh, rk.y + rk.hh];
    else [x0, x1, y0, y1] = [Math.min(rk.ax, rk.bx) - rk.r, Math.max(rk.ax, rk.bx) + rk.r, Math.min(rk.ay, rk.by) - rk.r, Math.max(rk.ay, rk.by) + rk.r];
    y0 = Math.max(y0, floorAt((x0 + x1) / 2) + 0.5);
    const h = y1 - y0;
    if (h < 2.4) continue;
    const r = makeRng(rk.seed + 991);
    const g = GROWTH[sectors[rk.sector].biome];
    const n = Math.round(h * 0.55 * g.density);
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const y = y0 + 0.7 + r() * (h - 1.6);
        const x = side < 0 ? x0 + 0.1 : x1 - 0.1;
        // the base must sit on this formation's face with open water in front of it
        if (solidAt(x + side * 0.45, y) || solidAt(x + side * 1.0, y + 0.3) || !solidAt(x - side * 0.3, y)) continue;
        if (insideShelter(x + side * 0.4, y) || !free(x + side * 0.4, y, 0.4)) continue;
        const fam = WALL[Math.floor(r() * WALL.length) % WALL.length];
        const id = variant(fam, r);
        if (!id) continue;
        const sc = 0.5 + r() * 0.55;
        // lean out from the wall and up toward the light
        const lean = fam === 'coral_table' || fam === 'coral_encrust' ? 78 + r() * 10 : 38 + r() * 30;
        const si2 = sectorOf(x, clamp(y, 0.01, 40.4));
        const tint = scaleRgb(paletteTint(si2, PALETTE_OF(fam), r), 0.85 + r() * 0.15);
        if (add(si2, 'flora', id, x, y, sc, sc, { tint, rot: side < 0 ? lean : -lean, flip: r() < 0.5 })) taken.push([x + side * 0.4, y, 0.42 * sc + 0.15]);
      }
    }
  }

  // ------------------------------------------------------------------ distant rocks along the seabed
  for (let col = 0; col < 3; col++) {
    const si = 6 + col;
    const r = makeRng(hashStr(`${regionId}:backrock:${col}`));
    for (let i = 0; i < 7; i++) {
      const x = col * 24 + 1 + r() * 22;
      const sc = 0.9 + r() * 1.5;
      add(si, 'back', variant('boulder', r), x, floorAt(x) + sc * 0.35, sc, sc * (0.7 + r() * 0.2), { tint: backTint(si, rockTint(si, r), 1), flip: r() < 0.5, keep: true });
    }
  }

  // ------------------------------------------------------------------ growth under ledges
  for (const rk of scene.rocks) {
    if (rk.kind !== 'box' || rk.style === 'crate' || rk.style === 'hull') continue;
    if (rk.hw < rk.hh * 1.15 || rk.hw < 1.2) continue;
    const si = rk.sector;
    const r = makeRng(rk.seed + 77);
    const yb = rk.y - rk.hh;
    if (yb < floorAt(rk.x) + 1.4) continue;
    const n = Math.round(rk.hw * 2 * 0.5 * GROWTH[sectors[si].biome].density);
    for (let i = 0; i < n; i++) {
      const x = rk.x - rk.hw + 0.5 + r() * (rk.hw * 2 - 1);
      if (insideShelter(x, yb - 0.4) || solidAt(x, yb - 0.5) || yb < floorAt(x) + 1.2) continue;
      const id = variant('hang', r);
      const sc = 0.6 + r() * 0.6;
      add(sectorOf(x, clamp(yb - 0.05, 0.01, 40.4)), 'flora', id, x, yb + 0.13, sc, sc, { tint: scaleRgb(paletteTint(si, 'sponge', r), 0.8), flip: r() < 0.5, sway: 2, rate: 0.9 + r() * 0.6 });
    }
  }

  const count = sectors.reduce((a, s) => a + s.back.length + s.rock.length + s.flora.length + s.front.length, 0);
  // lower-case keys: the device reads this with ParseJson and dot access
  const lowerTints = {};
  for (const [k, v] of Object.entries(tints)) lowerTints[k.toLowerCase()] = v;
  const out = { names, tints: lowerTints, sectors };
  fs.writeFileSync(path.join(OUT, `scene_${regionId}.json`), JSON.stringify(out));
  const kb = (fs.statSync(path.join(OUT, `scene_${regionId}.json`)).size / 1024).toFixed(0);
  console.log(`${regionId}: ${count} placements (${sectors.map((s) => s.back.length + s.rock.length + s.flora.length + s.front.length).join(' ')}), ${names.length} sprites used, ${kb} KB`);
}

for (const id of ['reef', 'outer', 'wreck']) compose(id);
