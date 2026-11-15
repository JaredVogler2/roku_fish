/**
 * Terrain kit: live rock, sand and shipwreck timber, authored at 96 px per world unit.
 *
 * The reef's collision shapes are simple (rounded boxes, circles, capsules), so the scenery is
 * assembled on the device from a few "three-slice" pieces - a cap, a middle that tiles, another
 * cap - each rendered with its full cross-section (lit top, textured face, shadowed underside),
 * then stretched to the thickness or width of the shape it dresses:
 *   shelf_*   horizontal ledge, nominal thickness 2.4 units       (l, m, r)
 *   slab_*    thin horizontal slab, 0.9 units (cave roofs/floors) (l, m, r)
 *   wall_*    broad vertical mass, nominal width 5 units          (t, m, b)
 *   post_*    thin vertical piece, 0.9 units (cave side walls)    (t, m, b)
 *   pillar_*  free-standing coral pillar, 2.4 units across        (t, m, b)
 *   boulder_* rounded rocks, 2 units across
 *   sand_top  seabed: the rippled surface strip (the device fills the body of the seabed itself)
 *   plank_*, plankv_*, mast_*, crate, porthole: the wreck
 * Rock and sand are rendered in neutral light greys (the device tints them per biome).
 */
import {
  Img, shade, clamp, lerp, smoothstep, fbm, vnoise, worley, hash2, mix3, mul3, add3, tone, hex,
} from './lib/core.mjs';
import { reliefRender, smax } from './lib/relief.mjs';

const PPU = 96;
const M = 28; // transparent margin around the nominal shape for the irregular silhouette
const OV = 4; // a cap or tile continues this far into the next piece, so joins never show a hairline

/**
 * Fused boulders: the union of flattened ellipsoid domes scattered on a jittered grid, the way
 * reef limestone weathers into rounded blocks. Returns the relief (0..~1), the id of the stone
 * on top (for colour variation) and how close the point is to a crease between stones.
 * cw, ch: cell size in px. Px, Py: period in cells (0 = none) so three-slice middles tile.
 * vary: when non-zero, cells away from the tile border use another seed - a second middle tile
 * that still joins the first one seamlessly.
 */
const ST = { h: 0, id: 0, crease: 1 };
function stoneField(X, Y, cw, ch, seed, Px = 0, Py = 0, vary = 0) {
  const u = X / cw;
  const v = Y / ch;
  const xi = Math.floor(u);
  const yi = Math.floor(v);
  let best = 0.1; // bedrock between stones
  let second = 0;
  let id = 0.5;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = Px > 0 ? ((cx % Px) + Px) % Px : cx;
      const wy = Py > 0 ? ((cy % Py) + Py) % Py : cy;
      let sd = seed;
      if (vary && ((Px > 0 && wx > 0 && wx < Px - 1) || (Py > 0 && wy > 0 && wy < Py - 1))) sd += vary;
      const ex = (u - cx - 0.22 - 0.56 * hash2(wx, wy, sd)) * cw;
      const ey = (v - cy - 0.22 - 0.56 * hash2(wx, wy, sd + 91)) * ch;
      const rx = (0.46 + 0.3 * hash2(wx, wy, sd + 3)) * cw;
      const ry = (0.42 + 0.3 * hash2(wx, wy, sd + 5)) * ch;
      const ang = (hash2(wx, wy, sd + 9) - 0.5) * 1.0;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const a = (ex * ca + ey * sa) / rx;
      const b = (-ex * sa + ey * ca) / ry;
      const q = a * a + b * b;
      if (q >= 1) continue;
      const dome = (0.55 + 0.45 * hash2(wx, wy, sd + 11)) * Math.sqrt(1 - q);
      if (dome > best) {
        second = best;
        best = dome;
        id = hash2(wx, wy, sd + 7);
      } else if (dome > second) second = dome;
    }
  ST.h = smax(best, second, 0.05);
  ST.id = id;
  ST.crease = clamp((best - second) * 6);
  return ST;
}

/**
 * Sample live rock at a point: a rounded shoulder at the outline, boulders, smaller rubble in
 * the gaps, bore holes and grain. (X, Y) are the piece family's GLOBAL coordinates so a cap and
 * the tile it joins continue the same stones. cfg: { cw, ch, Px, Py, seed, vary, edgeR, amp }.
 */
function rockSample(o, d, X, Y, cfg) {
  const { cw, ch, Px, Py, seed, edgeR, amp } = cfg;
  const dd = Math.max(0, d);
  const t = Math.min(1, dd / edgeR);
  const pillow = edgeR * Math.sqrt(1 - (1 - t) * (1 - t));
  const big = stoneField(X, Y, cw, ch, seed, Px, Py, cfg.vary ?? 0);
  const bh = big.h;
  const bid = big.id;
  const crease = big.crease;
  const small = stoneField(X + 37, Y + 19, cw / 2.3, ch / 2.3, seed + 5, Px ? Math.round(Px * 2.3) : 0, Py ? Math.round(Py * 2.3) : 0);
  // rubble shows in the creases, big stones dominate elsewhere
  const relief = smax(bh, small.h * 0.5, 0.06);
  const per = (n) => (Px ? Math.max(1, Math.round((Px * cw) / n)) : 0);
  const lump = fbm(X / 96, Y / 96, 3, seed + 21, per(96));
  const grain = fbm(X / 7, Y / 7, 2, seed + 23, per(7));
  const pw = worley(X / 24, Y / 24, seed + 29, per(24));
  const hole = pw.id > 0.965 ? smoothstep(0.3, 0.1, pw.f1 + (grain - 0.5) * 0.2) : 0;
  const fadeIn = smoothstep(0, edgeR * 0.45, dd);
  o.d = d;
  o.h = pillow + (relief * amp + (lump - 0.5) * amp * 0.5) * (0.35 + 0.65 * fadeIn) + (grain - 0.5) * 2.2 - hole * 5;
  // colour: every stone a touch different, pale dust on top, darker in holes and creases
  const blotch = fbm(X / 150, Y / 150, 3, seed + 31, per(150));
  o.a = (0.8 + (bid - 0.5) * 0.13 + (blotch - 0.5) * 0.14 + (grain - 0.5) * 0.06) * (1 - hole * 0.4) * (0.86 + 0.14 * crease);
  o.t = (fbm(X / 120 + 9, Y / 120 + 4, 2, seed + 41, per(120)) - 0.5) * 0.1;
  o.g = 0.05;
  o.al = 1;
  return true;
}

const ROCK_OPTS = { pad: 46, ambient: 0.6, key: 1.22, shadowK: 0.86, aoK: 0.07, dust: 0.1, gain: 1.04 };

/** Displacement of a silhouette edge at global coordinate s (px), periodic with P cells. */
const edgeNoise = (s, P, cellPx, seed, amp = 11) =>
  (fbm(s / cellPx, seed * 0.37, 3, seed, P) - 0.5) * 2 * amp + (vnoise((s / cellPx) * 4, 7.7, seed + 2, P * 4) - 0.5) * amp * 0.5;

function wrap(img, pivot, extra = {}) {
  return { lenPx: PPU, anchor: 'center', tintable: true, parts: [{ img, pivot, at: [0, 0], anim: null }], extra };
}
function piece(w, h, fn, pivot, extra = {}) {
  return wrap(shade(w, h, 2, fn), pivot, extra);
}

/**
 * Horizontal three-slice piece. part: 'l' | 'm' | 'r'; len: length in px of this part; th: nominal
 * thickness in px; tile: length of the family's middle tile (the texture period).
 * The nominal top edge is at y = M and the bottom at y = M + th. The top edge stays close to the
 * line (things stand on it); the underside is allowed to be ragged.
 */
function hslice(part, len, th, tile, seed, capR, vary = 0) {
  const w = len + (part === 'm' ? 0 : M) + (part === 'r' ? 0 : OV);
  const h = th + M * 2;
  const cellPx = 64;
  const P = Math.round(tile / cellPx);
  const ch = clamp(th / 2.2, 44, 110);
  const nx = Math.max(2, Math.round(tile / (ch * 1.25)));
  const cfg = { cw: tile / nx, ch, Px: nx, Py: 0, seed, vary, edgeR: Math.min(capR * 0.8, th * 0.42), amp: ch * 0.36 };
  return wrap(reliefRender(w, h, (x, y, o) => {
    // global X: the left cap ends where the first tile starts, the right cap follows the last tile
    const X = part === 'l' ? x - M - len : x;
    const u = part === 'l' ? x - M : part === 'r' ? len - x : 1e6; // distance from the free end
    const topN = edgeNoise(X, P, cellPx, seed, 6);
    const botN = (fbm((X + 1700) / cellPx, seed * 0.37, 2, seed + 4, P) - 0.5) * 30;
    const v = y - M + topN;
    const vb = M + th + botN - y;
    let d = Math.min(v, vb);
    if (part !== 'm') {
      const r = capR + edgeNoise(y, 0, cellPx, seed + 8, 7);
      const cy0 = clamp(y - M, r, th - r);
      const ex = r - u;
      if (ex > 0) {
        const dy = y - M - cy0 + (v < vb ? topN : -botN) * 0.5;
        const dist = r - Math.hypot(ex, dy);
        if (dist < d) d = dist;
      } else if (u < d) d = u;
    }
    if (d <= -2) return false;
    return rockSample(o, d, X, y, cfg);
  }, ROCK_OPTS), [part === 'l' ? M : 0, M], { nominal: th / PPU, ov: part === 'r' ? 0 : OV });
}

/** Vertical three-slice piece: nominal left edge at x = M, right edge at x = M + wd. */
function vslice(part, len, wd, tile, seed, capR, vary = 0) {
  const w = wd + M * 2;
  const h = len + (part === 'm' ? 0 : M) + (part === 'b' ? 0 : OV);
  const cellPx = 64;
  const P = Math.round(tile / cellPx);
  const cw = clamp(wd / 2.1, 44, 130);
  const ny = Math.max(2, Math.round(tile / (cw * 0.9)));
  const cfg = { cw, ch: tile / ny, Px: 0, Py: ny, seed, vary, edgeR: Math.min(capR * 0.8, wd * 0.42), amp: cw * 0.34 };
  return wrap(reliefRender(w, h, (x, y, o) => {
    const Y = part === 't' ? y - M - len : y;
    const ln = edgeNoise(Y, P, cellPx, seed, 12);
    const rn = edgeNoise(Y + 1300, P, cellPx, seed + 6, 12);
    const u = x - M + ln;
    const ub = M + wd + rn - x;
    let d = Math.min(u, ub);
    if (part !== 'm') {
      const v = part === 't' ? y - M : len - y;
      const r = Math.min(capR, wd / 2) + edgeNoise(x, 0, cellPx, seed + 3, 6);
      const cx0 = clamp(x - M, r, wd - r);
      const ey = r - v;
      if (ey > 0) {
        const dx = x - M - cx0 + (u < ub ? ln : -rn) * 0.5;
        const dist = r - Math.hypot(dx, ey);
        if (dist < d) d = dist;
      } else if (v < d) d = v;
    }
    if (d <= -2) return false;
    return rockSample(o, d, x, Y, cfg);
  }, ROCK_OPTS), [M, part === 't' ? M : 0], { nominal: wd / PPU, ov: part === 'b' ? 0 : OV });
}

function boulder(seed, squash) {
  const R = 96;
  const S = R * 2 + M * 2;
  const cfg = { cw: 96, ch: 88, Px: 0, Py: 0, seed, edgeR: 80, amp: 30 };
  return wrap(reliefRender(S, S, (x, y, o) => {
    const dx = x - S / 2;
    const dy = (y - S / 2) / squash;
    const ang = Math.atan2(dy, dx);
    const r = R * (0.9 + 0.1 * Math.sin(ang * 2 + seed) + 0.05 * Math.sin(ang * 3 + seed * 1.7)) + (fbm(Math.cos(ang) * 1.2 + 5, Math.sin(ang) * 1.2 + 5, 2, seed) - 0.5) * 22;
    const d = r - Math.hypot(dx, dy);
    if (d <= -2) return false;
    return rockSample(o, d, x, y, cfg);
  }, { ...ROCK_OPTS, pad: 30 }), [S / 2, S / 2], { nominal: 1 });
}

/**
 * The back wall of a cave or a hold: rock in shadow with a soft ragged edge, stretched by the
 * composer to fill the opening so the frame pieces read as one hollow formation.
 */
function caveBack() {
  const w = 256;
  const h = 192;
  const cfg = { cw: 70, ch: 60, Px: 0, Py: 0, seed: 97, edgeR: 8, amp: 9 };
  return wrap(reliefRender(w, h, (x, y, o) => {
    const n = (fbm(x / 26, y / 26, 3, 5) - 0.5) * 26;
    const d = Math.min(x, y, w - x, h - y) - 12 + n;
    if (d <= -2) return false;
    rockSample(o, d + 40, x, y, cfg);
    o.d = d;
    o.a *= 0.8;
    return true;
  }, { pad: 24, gain: 0.8, softEdge: 9 }), [0, 0]);
}

/** Encrusting growth: a mottled glaze the composer tints pink, violet, olive or ochre. */
function patch(seed, w, h) {
  return piece(w, h, (x, y, o) => {
    const nx = (x / w) * 2 - 1;
    const ny = (y / h) * 2 - 1;
    const r = Math.hypot(nx, ny);
    const n = fbm(x / 34 + seed, y / 34, 4, seed);
    const speck = fbm(x / 6, y / 6, 2, seed + 3);
    const m = n * 1.5 - r * 0.95 - 0.16 + (speck - 0.5) * 0.3;
    if (m <= 0) return false;
    const lobes = worley(x / 15, y / 15, seed + 9);
    const v = 0.74 + (speck - 0.5) * 0.3 + smoothstep(0.1, 0.5, lobes.f2 - lobes.f1) * 0.2;
    o[0] = v;
    o[1] = v;
    o[2] = v;
    o[3] = smoothstep(0, 0.2, m) * (0.3 + 0.5 * smoothstep(0.35, 0.7, speck));
    return true;
  }, [w / 2, h / 2]);
}

// ---------------------------------------------------------------------------- sand
/** Rippled seabed surface: lit crests, a soft lip, and a lower edge that fades into the fill. */
function sandTop() {
  const w = 384;
  const h = 150;
  return wrap(reliefRender(w, h, (x, y, o) => {
    const top = 26 + (fbm(x / 64, 1.3, 3, 31, 6) - 0.5) * 10;
    const d = y - top;
    if (d <= -2) return false;
    const fade = Math.exp(-d / 60);
    const rip = Math.sin((x + Math.sin(y * 0.07 + 1) * 14) * ((Math.PI * 2) / 48) + Math.sin(x * ((Math.PI * 2) / 384) * 2) * 1.6);
    const grain = vnoise(x * 0.8, y * 0.8, 77, 0);
    const lip = 9 * Math.sqrt(1 - Math.pow(1 - Math.min(1, d / 9), 2));
    o.d = d;
    o.h = lip + rip * 4.2 * fade * smoothstep(0, 12, d) + (grain - 0.5) * 1.3;
    const speck = hash2(Math.floor(x / 2), Math.floor(y / 2), 5) > 0.972 ? 0.12 : 0;
    o.a = 0.93 + (grain - 0.5) * 0.07 - speck + rip * 0.04 * fade;
    o.t = 0.03;
    o.g = 0.12;
    o.al = smoothstep(h - 2, h - 58, y);
    return true;
  }, { pad: 16, aoR: 6, aoK: 0.11, shadow: 16, shadowK: 0.6, key: 1.1, ambient: 0.8 }), [0, 26]);
}
// ---------------------------------------------------------------------------- wreck timber
/**
 * Old ship's timber: boards with rounded faces and dark seams, butt joints, grain, worm holes
 * and a little pale growth. Writes height and albedo for the relief renderer.
 * a runs along the boards, b across them.
 */
const TIMBER_OPTS = { pad: 14, aoR: 4, aoK: 0.13, shadow: 12, shadowK: 0.6, key: 1.18, ambient: 0.66, dust: 0.06 };
function timberSample(o, d, a, b, seed, edgeR = 5) {
  const boardW = 22;
  const bi = Math.floor(b / boardW);
  const bf = b / boardW - bi;
  const across = Math.min(bf, 1 - bf); // 0 at a seam .. 0.5 mid-board
  const shift = hash2(bi, 3, seed) * 300;
  const al = a + shift;
  const grain = fbm(al / 90, b / 5 + bi * 3.1, 3, seed + bi);
  const fine = vnoise(al / 3.2, b * 1.7, seed + 5);
  const buttD = Math.abs((((al % 170) + 170) % 170) - 85) - 82; // > 0 inside a butt joint
  const butt = smoothstep(0, 2.5, buttD);
  const wear = fbm(al / 60, b / 30, 2, seed + 9);
  const pw = worley(al / 13, b / 13, seed + 17);
  const hole = pw.id > 0.9 ? smoothstep(0.26, 0.08, pw.f1) : 0;
  const dd = Math.max(0, d);
  const t = Math.min(1, dd / edgeR);
  o.d = d;
  // each board is slightly cupped; seams and butt joints are grooves
  o.h = edgeR * Math.sqrt(1 - (1 - t) * (1 - t)) + 4.2 * Math.sqrt(Math.min(1, across / 0.16)) * (1 - butt * 0.9)
    + (grain - 0.5) * 2.2 + (fine - 0.5) * 0.8 + (wear - 0.5) * 2.4 - hole * 3.5 + (hash2(bi, 21, seed) - 0.5) * 2.5;
  let v = 0.74 + (grain - 0.5) * 0.3 + (hash2(bi, 9, seed) - 0.5) * 0.16 + (fine - 0.5) * 0.08;
  v *= 1 - 0.25 * butt;
  v *= 1 - hole * 0.45;
  const crust = smoothstep(0.6, 0.8, fbm(al / 46, b / 46, 3, seed + 40));
  o.a = clamp(lerp(v, 0.95, crust * 0.35));
  o.t = 0.05 - crust * 0.07;
  o.g = 0.04;
  o.al = 1;
  return true;
}
function plankH(part, len, th, seed) {
  const w = len + (part === 'm' ? 0 : 10);
  const h = th + 12;
  return wrap(reliefRender(w, h, (x, y, o) => {
    const u = part === 'l' ? x - 10 : part === 'r' ? len - x : 1e6;
    const jag = (hash2(Math.floor(y / 11), 1, seed) - 0.5) * 16;
    const v = y - 6;
    const vb = th + 6 - y;
    const d = Math.min(v, vb, part === 'm' ? 1e6 : u + jag);
    if (d <= -2) return false;
    return timberSample(o, d, part === 'r' ? w - x : x, y, seed);
  }, TIMBER_OPTS), [part === 'l' ? 10 : 0, 6], { nominal: th / PPU });
}
function plankV(part, len, wd, seed) {
  const w = wd + 12;
  const h = len + (part === 'm' ? 0 : 10);
  return wrap(reliefRender(w, h, (x, y, o) => {
    const v = part === 't' ? y - 10 : part === 'b' ? len - y : 1e6;
    const jag = (hash2(Math.floor(x / 11), 2, seed) - 0.5) * 14;
    const u = x - 6;
    const ub = wd + 6 - x;
    const d = Math.min(u, ub, part === 'm' ? 1e6 : v + jag);
    if (d <= -2) return false;
    return timberSample(o, d, part === 'b' ? h - y : y, x, seed);
  }, TIMBER_OPTS), [6, part === 't' ? 10 : 0], { nominal: wd / PPU });
}
function crate() {
  const S = 160;
  return wrap(reliefRender(S, S, (x, y, o) => {
    const d = Math.min(x - 4, y - 4, S - 4 - x, S - 4 - y);
    if (d <= -2) return false;
    const inFrame = d < 22;
    const diagD = Math.min(Math.abs(x - y), Math.abs(x + y - S)) / Math.SQRT2;
    const onBrace = diagD < 9 && !inFrame;
    // frame boards run around the edge, panel boards run upright, braces cross the panel
    const vertical = x < 26 || x > S - 26;
    if (inFrame) timberSample(o, d, vertical ? y : x, vertical ? x : y, 52, 6);
    else if (onBrace) timberSample(o, 9 - diagD, x + y, 11, 53, 4);
    else timberSample(o, d, y, x, 51, 6);
    o.d = d;
    // the frame and braces stand proud of the panel
    if (inFrame) o.h += 7;
    else if (onBrace) o.h += 5;
    else o.a *= 0.86;
    return true;
  }, TIMBER_OPTS), [S / 2, S / 2], { nominal: 152 / PPU });
}
function porthole() {
  const S = 96;
  return wrap(reliefRender(S, S, (x, y, o) => {
    const r = Math.hypot(x - 48, y - 48);
    const d = 44 - r;
    if (d <= -2) return false;
    const ring = smoothstep(14, 18, d); // 0 on the rim .. 1 in the glass
    o.d = d;
    // a rounded metal rim around dark glass, with four bolts
    const rimT = clamp(d / 16);
    let hgt = 7 * Math.sin(rimT * Math.PI) * (1 - ring) + 1;
    let alb = 0.72;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.785;
      const bd = Math.hypot(x - 48 - Math.cos(a) * 36, y - 48 - Math.sin(a) * 36);
      if (bd < 4) hgt += Math.sqrt(16 - bd * bd) * 0.9;
    }
    if (ring > 0.5) {
      alb = 0.13 + 0.1 * clamp(1 - Math.hypot(x - 40, y - 38) / 22);
      hgt = 1;
    }
    o.h = hgt;
    o.a = alb;
    o.t = 0.02;
    o.g = ring > 0.5 ? 0.5 : 0.25;
    o.al = 1;
    return true;
  }, { ...TIMBER_OPTS, shadow: 6 }), [48, 48]);
}

const BUILD = {
  shelf_l: () => hslice('l', 192, 230, 512, 11, 74),
  shelf_m: () => hslice('m', 512, 230, 512, 11, 74),
  shelf_m2: () => hslice('m', 512, 230, 512, 11, 74, 500),
  shelf_r: () => hslice('r', 192, 230, 512, 11, 74),
  slab_l: () => hslice('l', 112, 86, 320, 23, 36),
  slab_m: () => hslice('m', 320, 86, 320, 23, 36),
  slab_r: () => hslice('r', 112, 86, 320, 23, 36),
  wall_t: () => vslice('t', 176, 480, 448, 37, 86),
  wall_m: () => vslice('m', 448, 480, 448, 37, 86),
  wall_b: () => vslice('b', 176, 480, 448, 37, 86),
  post_t: () => vslice('t', 96, 86, 256, 41, 34),
  post_m: () => vslice('m', 256, 86, 256, 41, 34),
  post_b: () => vslice('b', 96, 86, 256, 41, 34),
  pillar_t: () => vslice('t', 176, 230, 384, 53, 112),
  pillar_m: () => vslice('m', 384, 230, 384, 53, 112),
  pillar_m2: () => vslice('m', 384, 230, 384, 53, 112, 700),
  pillar_b: () => vslice('b', 128, 230, 384, 53, 60),
  boulder_1: () => boulder(61, 0.9),
  boulder_2: () => boulder(67, 0.78),
  boulder_3: () => boulder(73, 1.0),
  cave_back: () => caveBack(),
  patch_1: () => patch(3, 176, 120),
  patch_2: () => patch(8, 144, 104),
  patch_3: () => patch(14, 200, 96),
  sand_top: () => sandTop(),
  plank_l: () => plankH('l', 96, 62, 81),
  plank_m: () => plankH('m', 288, 62, 81),
  plank_r: () => plankH('r', 96, 62, 81),
  plankv_t: () => plankV('t', 96, 62, 85),
  plankv_m: () => plankV('m', 256, 62, 85),
  plankv_b: () => plankV('b', 96, 62, 85),
  crate: () => crate(),
  porthole: () => porthole(),
};

export const IDS = Object.keys(BUILD);
export function build(id) {
  const f = BUILD[id];
  if (!f) throw new Error(`Unknown terrain piece ${id}`);
  return f();
}
