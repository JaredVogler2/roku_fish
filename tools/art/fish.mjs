/**
 * Fish sprite renderer.
 *
 * Each fish is defined by the same parametric body plans as the web game (data/fish_shapes.json:
 * dorsal/ventral profile, width, fins, tail type, eye, extras), but instead of a low-poly mesh it
 * is shaded per pixel as a smooth rounded body: analytic thickness -> surface normal -> key light,
 * hemisphere ambient, wet specular sheen, rim light, scales, countershading and the species'
 * pattern, with translucent ray-finned fins and a glossy eye.
 *
 * Output: a body layer (body, dorsal/anal/pelvic fins, tail, extras), a separate near-side
 * pectoral fin layer (so the device can flap it), and the measurements the runtime rig needs.
 * Model space: length 1 along +X (nose at +0.5, tail tip at -0.5), +Y up, sprite faces right.
 */
import fs from 'node:fs';
import {
  Img, shade, over, bounds, crop, hex, mix3, mul3, add3, mulc, dot3, norm3, clamp, lerp, smoothstep, fract, hash2, vnoise, fbm, worley,
  saturate, tone, lum, hashStr,
} from './lib/core.mjs';
import { lit, membrane } from './lib/light.mjs';
import { LOOKS } from './looks.mjs';

const PI = Math.PI;

// ---------------------------------------------------------------------------- geometry
function makeGeom(sh) {
  const ext = sh.snoutExt ?? 0;
  const u0 = ext;
  const snoutR = sh.snoutR ?? 0.012;
  // Head: blend of the web game's sine-power curve with an elliptical arc so snouts are rounded
  // rather than wedge-shaped; `round` 0..1 controls how blunt the head is.
  const round = clamp(sh.round ?? 0.4 + 0.3 * clamp(sh.snout - 0.5), 0.2, 0.9);
  const fall = 1 + clamp((sh.H - 0.14) * 3.2, 0, 0.9);
  const profAt = (ub, max, p) => {
    if (ub <= 0) return 0;
    if (ub <= p) {
      const t = ub / p;
      const a = Math.pow(Math.sin((PI / 2) * t), 1 / Math.max(0.2, sh.snout));
      const b = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
      return max * lerp(a, b, round);
    }
    const t = Math.pow(Math.min(1, (ub - p) / (sh.bodyEnd - p)), fall);
    const ct = (1 - Math.cos(t * PI)) / 2;
    return max * (1 - ct * (1 - sh.ped));
  };
  const prof = (ub, max) => profAt(ub, max, sh.peak);
  // The back peaks a little ahead of the belly, as on real fish.
  const peakTop = sh.peak - 0.025;
  const peakBot = Math.min(sh.bodyEnd - 0.1, sh.peak + 0.045);
  const ubOf = (u) => ((u - u0) / (sh.bodyEnd - u0)) * sh.bodyEnd;
  const hump = (ub) => (sh.hump ? sh.hump * Math.exp(-Math.pow((ub - 0.18) / 0.08, 2)) : 0);
  // Smooth max so a long snout blends into the head instead of meeting it at a crease.
  const smax = (a, b, k) => {
    const h = clamp(0.5 + (0.5 * (a - b)) / k);
    return lerp(b, a, h) + k * h * (1 - h);
  };
  const tube = (u) => (ext > 0 ? snoutR * smoothstep(0, 0.02, u) * (0.75 + 0.25 * smoothstep(0, ext, u)) : 0);
  const N = 1024;
  const TOP = new Float32Array(N + 1);
  const BOT = new Float32Array(N + 1);
  const WID = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * sh.bodyEnd;
    let h = 0;
    let w = 0;
    let hm = 0;
    if (u >= u0) {
      const ub = ubOf(u);
      h = profAt(ub, sh.H, peakTop);
      w = prof(ub, sh.W);
      hm = hump(ub);
    }
    let top = h + hm;
    let bot = (u >= u0 ? profAt(ubOf(u), sh.H, peakBot) : 0) * sh.belly;
    if (ext > 0) {
      const tb = tube(u);
      top = smax(top, tb, 0.012);
      bot = smax(bot, tb, 0.012);
      w = Math.max(w, tb * 0.9);
    }
    TOP[i] = top;
    BOT[i] = bot;
    WID[i] = w;
  }
  const look = (arr, u) => {
    const f = clamp(u / sh.bodyEnd) * N;
    const i = Math.min(N - 1, Math.floor(f));
    const t = f - i;
    return arr[i] * (1 - t) + arr[i + 1] * t;
  };
  return {
    sh, ext, u0,
    top: (u) => look(TOP, u),
    bot: (u) => look(BOT, u),
    wid: (u) => look(WID, u),
    ped: prof(sh.bodyEnd, sh.H),
    prof,
  };
}

function finHeight(f, t) {
  let hh = f.h;
  switch (f.shape ?? 'low') {
    case 'low':
      hh *= Math.sin(Math.min(1, t * 1.2) * PI * 0.5) * (1 - Math.pow(t, 6) * 0.6);
      break;
    case 'tall':
      hh *= t < 0.3 ? Math.sin((t / 0.3) * PI * 0.5) : 1 - ((t - 0.3) / 0.7) * 0.75;
      break;
    case 'spiny':
      hh *= (0.62 + 0.38 * Math.pow(Math.abs(Math.sin(t * PI * 6)), 0.7)) * (t < 0.15 ? Math.sin((t / 0.15) * PI * 0.5) : 1 - t * 0.35);
      break;
    case 'sail':
      hh *= Math.sin(t * PI) * 0.6 + (t > 0.5 ? 0.4 * (1 - (t - 0.5) * 1.2) : 0.4 * t * 2);
      break;
    case 'streamer':
      hh *= t < 0.22 ? Math.sin((t / 0.22) * PI * 0.5) : 0.12 + 0.88 * Math.pow(1 - (t - 0.22) / 0.78, 1.8);
      break;
    case 'shark':
      hh *= t < 0.55 ? Math.pow(t / 0.55, 0.8) : Math.max(0, 1 - (t - 0.55) / 0.45) * 0.3;
      break;
    default:
      break;
  }
  return Math.max(0.003, hh);
}
function finShear(f, t) {
  let ox = 0;
  if (f.shape === 'shark') ox = -t * 0.04 - (t < 0.55 ? 0.05 * (t / 0.55) : 0.05);
  if (f.shape === 'streamer') return -(finHeight(f, t) / f.h) * 0.11;
  if (f.trail && t > 0.6) ox -= (t - 0.6) * f.trail * 2.5;
  return ox;
}

const TAILS = {
  fork: [[0, 'p'], [0.55, 0.65], [1, 1], [0.78, 0.35], [0.52, 0], [0.78, -0.35], [1, -1], [0.55, -0.65], [0, '-p']],
  lunate: [[0, 'p'], [0.45, 0.7], [1, 1.1], [0.72, 0.42], [0.62, 0], [0.72, -0.42], [1, -1.1], [0.45, -0.7], [0, '-p']],
  crescent: [[0, 'p'], [0.4, 0.75], [1, 1.25], [0.62, 0.35], [0.5, 0], [0.62, -0.35], [1, -1.15], [0.4, -0.7], [0, '-p']],
  lyre: [[0, 'p'], [0.45, 0.7], [1.35, 1.25], [0.8, 0.45], [0.65, 0], [0.8, -0.45], [1.35, -1.25], [0.45, -0.7], [0, '-p']],
  round: [[0, 'p'], [0.3, 0.72], [0.62, 0.86], [0.9, 0.6], [1, 0], [0.9, -0.6], [0.62, -0.86], [0.3, -0.72], [0, '-p']],
  truncate: [[0, 'p'], [0.5, 0.82], [0.9, 0.97], [1, 0.6], [0.98, 0], [1, -0.6], [0.9, -0.97], [0.5, -0.82], [0, '-p']],
  heterocercal: [[0, 'p'], [0.55, 0.75], [1, 1.35], [0.82, 0.55], [0.6, 0.05], [0.66, -0.55], [0.48, -0.65], [0.25, -0.35], [0, '-p']],
  pointed: [[0, 'p'], [0.5, 'p*0.6'], [1, 0], [0.5, '-p*0.6'], [0, '-p']],
};

/** Chaikin corner cutting on an open polyline (keeps the end points). */
function chaikin(pts, iters, keep = () => false) {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const o = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      if (i > 0 && keep(a)) o.push(a);
      else if (i > 0) o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      if (i < p.length - 2 && !keep(b)) o.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    o.push(p[p.length - 1]);
    p = o;
  }
  return p;
}
function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Distance from point to polygon edge (unsigned). */
function polyDist(poly, x, y) {
  let d = 1e9;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0];
    const ay = poly[j][1];
    const bx = poly[i][0] - ax;
    const by = poly[i][1] - ay;
    const l2 = bx * bx + by * by;
    const t = l2 > 0 ? clamp(((x - ax) * bx + (y - ay) * by) / l2) : 0;
    const dx = x - ax - bx * t;
    const dy = y - ay - by * t;
    const dd = dx * dx + dy * dy;
    if (dd < d) d = dd;
  }
  return Math.sqrt(d);
}
function polyBounds(poly) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, x1, y0, y1 };
}

// ---------------------------------------------------------------------------- patterns
function cellDist(x, y, seed) {
  return worley(x, y, seed).f1;
}

/**
 * Body colouration. u: 0 nose .. 1 tail tip, v: -1 belly .. +1 back. Mirrors the pattern keys of
 * the web game (same intent, refined edges) so every species keeps its identity.
 */
export function patternColor(key, A, B, C, u, v, seed) {
  let col = A;
  switch (key) {
    case 'countershade': {
      const edge = v + 0.1 * (vnoise(u * 16, 3.1, seed) - 0.5);
      col = mix3(B, A, smoothstep(-0.32, 0.02, edge));
      if (lum(C) < lum(A)) col = mix3(col, C, 0.3 * smoothstep(0.45, 1.0, v));
      break;
    }
    case 'vbars':
      col = mix3(A, B, smoothstep(0.44, 0.52, fract(u * 4.0 + 0.1)) * smoothstep(0.98, 0.9, fract(u * 4.0 + 0.1)));
      break;
    case 'hstripes':
      col = mix3(A, B, smoothstep(0.5, 0.58, fract(v * 3.0 + 0.2)) * smoothstep(1.0, 0.92, fract(v * 3.0 + 0.2)));
      break;
    case 'neonStripe':
      col = mix3(A, C, smoothstep(0.0, -0.5, v));
      col = mix3(col, B, smoothstep(0.17, 0.06, Math.abs(v - 0.05)));
      break;
    case 'spots':
      col = mix3(A, B, smoothstep(0.3, 0.22, cellDist(u * 9, v * 3, seed)));
      break;
    case 'darkSpots':
      col = mix3(A, B, smoothstep(0.26, 0.19, cellDist(u * 12, v * 4, seed)));
      break;
    case 'eyespot': {
      const d = Math.hypot((u - 0.78) * 3.0, v);
      col = mix3(col, B, smoothstep(0.33, 0.25, d));
      col = mix3(col, C, smoothstep(0.18, 0.12, d));
      break;
    }
    case 'mottled': {
      const n = fbm(u * 7, v * 3, 3, seed) * 0.6 + vnoise(u * 17, v * 7, seed + 5) * 0.4;
      col = mix3(A, B, smoothstep(0.38, 0.6, n));
      col = mix3(col, C, smoothstep(0.66, 0.8, n) * 0.6);
      break;
    }
    case 'saddles':
      col = mix3(A, B, smoothstep(-0.15, 0.15, Math.sin(u * 14.0)) * smoothstep(-0.05, 0.4, v));
      break;
    case 'bands': {
      const b = fract(u * 3.0 + 0.15);
      const band = smoothstep(0.08, 0.12, b) * smoothstep(0.36, 0.32, b);
      col = mix3(A, B, band);
      col = mix3(col, C, clamp(smoothstep(0.05, 0.08, b) * smoothstep(0.39, 0.36, b) - band));
      break;
    }
    case 'mask':
      col = mix3(col, B, smoothstep(0.12, 0.08, Math.abs(u - 0.2)));
      col = mix3(col, C, smoothstep(0.72, 0.82, u));
      break;
    case 'gradient':
      col = mix3(A, B, smoothstep(0.25, 0.9, u));
      break;
    case 'speckled':
      col = mix3(A, B, smoothstep(0.2, 0.12, cellDist(u * 30, v * 10, seed)) * 0.9);
      col = mix3(col, C, smoothstep(0.16, 0.1, cellDist(u * 15, v * 6, seed + 4)) * 0.8);
      break;
    case 'lined':
      col = mix3(A, B, smoothstep(0.08, 0.0, Math.abs(fract(v * 2.5 + u * 0.6) - 0.5) - 0.38));
      col = mix3(col, C, smoothstep(0.72, 0.8, u) * 0.6);
      break;
    case 'reticulated': {
      const w = worley(u * 10, v * 4, seed);
      col = mix3(B, A, smoothstep(0.05, 0.16, w.f2 - w.f1));
      break;
    }
    case 'checker':
      col = mix3(A, B, (Math.floor(u * 8) + Math.floor((v + 1) * 1.5)) % 2 ? 1 : 0);
      break;
    case 'zebra': {
      const z = fract(u * 9.0 + v * 0.6);
      col = mix3(A, B, smoothstep(0.35, 0.5, z) * smoothstep(1.0, 0.9, z));
      col = mix3(col, C, smoothstep(0.86, 0.93, z) * smoothstep(1.0, 0.97, z) * 0.7);
      break;
    }
    case 'glow':
      col = mix3(A, B, smoothstep(-1, 1, v));
      break;
    default:
      break;
  }
  return col;
}

// ---------------------------------------------------------------------------- renderer
/**
 * @param sp     species record (id, pattern, palette, group, model)
 * @param sh     fish shape (from fish_shapes.json)
 * @param opts   { px: pixels per body length, ss: supersampling, look?: custom look }
 */
export function renderFish(sp, sh, opts = {}) {
  const PX = opts.px ?? 220;
  const ss = opts.ss ?? 3;
  const g = makeGeom(sh);
  const seed = hashStr(sp.id) & 0xffff;
  const A = hex(sp.palette[0]);
  const B = hex(sp.palette[1]);
  const C = hex(sp.palette[2]);
  const look = opts.look ?? {};
  const pat = look.pattern ?? ((u, v, part) => patternColor(sp.pattern, A, B, C, u, v, seed));
  const smooth = sp.group === 'shark' || sp.model === 'moray' || look.smoothSkin;
  const scales = look.scales ?? (smooth ? 0 : 1);
  const gloss = look.gloss ?? (smooth ? 0.22 : 0.5);
  const xOf = (u) => 0.5 - u;
  const bodyEndX = xOf(sh.bodyEnd);
  const tl = 1 - sh.bodyEnd;

  // ---- tail polygon
  const P = g.ped * 0.95;
  const tailRaw = TAILS[sh.tail].map(([tx, ty]) => {
    let y;
    if (typeof ty === 'string') {
      const k = ty.includes('*') ? parseFloat(ty.split('*')[1]) : 1;
      y = (ty.startsWith('-') ? -1 : 1) * P * k;
    } else y = ty * sh.T;
    // The stem overlaps the body so the joint is seamless.
    return [bodyEndX - tx * tl + (tx === 0 ? 0.03 : 0), y];
  });
  const tailPoly = chaikin(tailRaw, sh.tail === 'pointed' ? 1 : 2);
  const tailB = polyBounds(tailPoly);

  // ---- vertical fins
  const fins = [];
  for (const f of sh.dorsal) fins.push({ ...f, sign: 1 });
  for (const f of sh.anal) fins.push({ ...f, sign: -1 });
  const baseY = (f, u) => (f.sign > 0 ? g.top(u) * 0.9 : -g.bot(u) * 0.9);
  const FN = 56;
  for (const f of fins) {
    f.bp = [];
    f.op = [];
    f.x0 = 1e9; f.x1 = -1e9; f.y0 = 1e9; f.y1 = -1e9;
    for (let i = 0; i <= FN; i++) {
      const t = i / FN;
      const u = f.a + (f.b - f.a) * t;
      const by = baseY(f, u) - f.sign * 0.012;
      const bx = xOf(u);
      const ox = bx + finShear(f, t);
      const oy = baseY(f, u) + f.sign * finHeight(f, t);
      f.bp.push([bx, by]);
      f.op.push([ox, oy]);
      f.x0 = Math.min(f.x0, bx, ox); f.x1 = Math.max(f.x1, bx, ox);
      f.y0 = Math.min(f.y0, by, oy); f.y1 = Math.max(f.y1, by, oy);
    }
  }
  /** (t along the base, r base->edge) for a point, or null when outside the fin. */
  const finAt = (f, x, y) => {
    if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) return null;
    let prev = 0;
    for (let i = 0; i <= FN; i++) {
      const b = f.bp[i];
      const o = f.op[i];
      const dx = o[0] - b[0];
      const dy = o[1] - b[1];
      const cr = dx * (y - b[1]) - dy * (x - b[0]);
      if (i > 0 && (cr === 0 || cr > 0 !== prev > 0)) {
        const pb = f.bp[i - 1];
        const po = f.op[i - 1];
        const k = Math.abs(prev) / (Math.abs(prev) + Math.abs(cr) + 1e-12);
        const bx = lerp(pb[0], b[0], k);
        const by = lerp(pb[1], b[1], k);
        const ex = lerp(po[0], o[0], k) - bx;
        const ey = lerp(po[1], o[1], k) - by;
        const r = ((x - bx) * ex + (y - by) * ey) / (ex * ex + ey * ey + 1e-12);
        if (r >= 0 && r <= 1) return { t: (i - 1 + k) / FN, r };
      }
      prev = cr;
    }
    return null;
  };
  // Streamer filament (moorish idol / spadefish).
  const filaments = [];
  for (const f of sh.dorsal) {
    if (f.shape === 'streamer' && f.trail) {
      const pts = [];
      const fu = f.a + (f.b - f.a) * 0.22;
      const y0 = g.top(fu) * 0.9 + f.h - 0.012;
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        pts.push([xOf(fu) - 0.105 - t * f.trail, y0 + Math.sin(t * 2.0) * 0.05 - t * t * 0.2, 0.012 * (1 - t) + 0.0028]);
      }
      filaments.push(pts);
    }
  }
  const extras = sh.extras ?? [];
  if (extras.includes('filament')) {
    // Lionfish: long free dorsal rays.
    for (let k = 0; k < 9; k++) {
      const u = 0.18 + k * 0.05;
      const y0 = g.top(u) * 0.9;
      const len = 0.4 - Math.abs(k - 3) * 0.028;
      const pts = [];
      for (let q = 0; q <= 6; q++) {
        const t = q / 6;
        pts.push([xOf(u) - t * 0.07 - t * t * 0.03, y0 + t * len, 0.0075 * (1 - t) + 0.002]);
      }
      filaments.push(pts);
    }
  }
  if (extras.includes('barbels')) {
    for (const off of [0, 0.012]) {
      const pts = [];
      for (let q = 0; q <= 6; q++) {
        const t = q / 6;
        pts.push([xOf(0.05 + g.ext) - t * 0.06 - off, -g.bot(0.06) * 0.9 - t * 0.085 - off, 0.006 * (1 - t) + 0.002]);
      }
      filaments.push(pts);
    }
  }
  let lure = null;
  if (extras.includes('lure')) {
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      pts.push([xOf(0.1) + t * 0.14, g.top(0.1) * 0.95 + 0.02 + Math.sin(t * 3.0) * 0.045 + t * 0.1, 0.0055]);
    }
    filaments.push(pts);
    const tip = pts[pts.length - 1];
    lure = { x: tip[0] + 0.012, y: tip[1], r: 0.026 };
  }
  const tubeDist = (pts, x, y) => {
    let best = 1e9;
    let tt = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0];
      const ay = pts[i][1];
      const bx = pts[i + 1][0] - ax;
      const by = pts[i + 1][1] - ay;
      const l2 = bx * bx + by * by;
      const t = l2 > 0 ? clamp(((x - ax) * bx + (y - ay) * by) / l2) : 0;
      const d = Math.hypot(x - ax - bx * t, y - ay - by * t) - lerp(pts[i][2], pts[i + 1][2], t);
      if (d < best) {
        best = d;
        tt = (i + t) / (pts.length - 1);
      }
    }
    return [best, tt];
  };

  // ---- pelvic fin
  let pelvic = null;
  if (sh.pelvic && sh.pelvic > 0) {
    const pu = 0.36 + g.ext * 0.5;
    const px = xOf(pu);
    const by = -g.bot(pu) * 0.88;
    const s = sh.pelvic;
    pelvic = chaikin([[px + 0.015, by + 0.01], [px - s * 0.25, by - s * 0.55], [px - s * 0.62, by - s * 1.0], [px - s * 0.8, by - s * 0.62], [px - s * 0.5, by + 0.01]], 2);
  }

  // ---- extras: cones / blobs
  const cones = [];
  const blobs = [];
  const topAt = (u) => g.top(u);
  if (extras.includes('horn')) cones.push({ a: [xOf(0.12), topAt(0.12) * 0.7], b: [xOf(-0.07), topAt(0.12) * 0.98], r: 0.026, col: 'body' });
  if (extras.includes('horns')) {
    cones.push({ a: [xOf(0.08), topAt(0.08) * 0.75], b: [xOf(-0.13), topAt(0.08) * 1.0], r: 0.02, col: 'body' });
    cones.push({ a: [xOf(sh.bodyEnd - 0.05), -g.bot(sh.bodyEnd - 0.05) * 0.8], b: [xOf(sh.bodyEnd + 0.08), -g.bot(sh.bodyEnd) - 0.03], r: 0.016, col: 'body' });
  }
  if (extras.includes('underbite')) cones.push({ a: [xOf(0.12 + g.ext * 0), -g.bot(0.12) * 0.55], b: [xOf(-0.012), -g.bot(0.02) * 0.4 - 0.006], r: 0.02, col: 'body' });
  if (extras.includes('spikes')) {
    for (let k = 0; k < 34; k++) {
      const u = 0.14 + hash2(k, 1, seed) * 0.62;
      const side = hash2(k, 2, seed) * 2 - 1;
      const yy = side >= 0 ? topAt(u) * side : -g.bot(u) * -side;
      cones.push({ a: [xOf(u), yy * 0.9], b: [xOf(u) - 0.012, yy * 0.9 + (side >= 0 ? 0.03 : -0.03) * (0.4 + Math.abs(side))], r: 0.006, col: 'spike' });
    }
  }
  const coneAt = (c, x, y) => {
    const bx = c.b[0] - c.a[0];
    const by = c.b[1] - c.a[1];
    const l2 = bx * bx + by * by;
    const t = clamp(((x - c.a[0]) * bx + (y - c.a[1]) * by) / l2);
    const d = Math.hypot(x - c.a[0] - bx * t, y - c.a[1] - by * t);
    const r = c.r * (1 - t * 0.92);
    return d <= r ? { t, s: d / r } : null;
  };

  // ---- eye
  const eu = sh.eye.u + g.ext;
  const eye = { x: xOf(eu), y: g.top(eu) * sh.eye.y, r: sh.eye.r * (look.eyeScale ?? 1) };
  const irisCol = look.iris ? hex(look.iris) : mix3([0.78, 0.62, 0.3], mix3(A, C, 0.5), 0.3);

  // ---- body surface helpers
  const box = sh.box ?? 2;
  const zAt = (x, y) => {
    const u = 0.5 - x;
    if (u < 0 || u > sh.bodyEnd) return -1;
    const t = g.top(u);
    const b = g.bot(u);
    if (t + b <= 0) return -1;
    const hh = (t + b) / 2;
    const s = (y - (t - b) / 2) / hh;
    if (s < -1 || s > 1) return -1;
    const w = g.wid(u);
    return w * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), box)), 1 / box);
  };
  const gillU = (look.gill ?? sh.peak * 0.62) + g.ext;

  // ---- image extents (model units)
  let xmin = Math.min(-0.5 - 0.02, tailB.x0 - 0.01);
  let xmax = 0.5 + 0.02;
  let ymax = 0;
  let ymin = 0;
  for (let i = 0; i <= 200; i++) {
    const u = (i / 200) * sh.bodyEnd;
    ymax = Math.max(ymax, g.top(u));
    ymin = Math.min(ymin, -g.bot(u));
  }
  for (const f of fins) {
    ymax = Math.max(ymax, f.y1);
    ymin = Math.min(ymin, f.y0);
    xmin = Math.min(xmin, f.x0 - 0.01);
  }
  ymax = Math.max(ymax, tailB.y1);
  ymin = Math.min(ymin, tailB.y0);
  for (const pts of filaments) for (const p of pts) {
    ymax = Math.max(ymax, p[1] + p[2]);
    ymin = Math.min(ymin, p[1] - p[2]);
    xmin = Math.min(xmin, p[0] - p[2]);
    xmax = Math.max(xmax, p[0] + p[2]);
  }
  if (lure) {
    ymax = Math.max(ymax, lure.y + lure.r);
    xmax = Math.max(xmax, lure.x + lure.r);
  }
  for (const c of cones) {
    for (const q of [c.a, c.b]) {
      ymax = Math.max(ymax, q[1] + c.r);
      ymin = Math.min(ymin, q[1] - c.r);
      xmax = Math.max(xmax, q[0] + c.r);
      xmin = Math.min(xmin, q[0] - c.r);
    }
  }
  if (pelvic) for (const p of pelvic) ymin = Math.min(ymin, p[1]);
  const pad = 0.03;
  xmin -= pad;
  xmax += pad;
  ymin -= pad;
  ymax += pad;
  const W = Math.ceil((xmax - xmin) * PX);
  const H = Math.ceil((ymax - ymin) * PX);
  const toX = (px) => xmin + px / PX;
  const toY = (py) => ymax - py / PX;

  const finColor = look.fin ?? ((part, u, v) => pat(u, v, part));
  const finAlpha = look.finAlpha ?? 0.88;
  const aaW = 1.2 / PX; // one output pixel in model units (for soft feature edges)

  const shadeMembrane = membrane;

  const body = shade(W, H, ss, (px, py, out) => {
    const x = toX(px);
    const y = toY(py);
    const u = 0.5 - x;
    let r = 0, gg = 0, b = 0, a = 0;
    const put = (c, al) => {
      // composite `c` over what we have (front-most last)
      r = c[0] * al + r * (1 - al);
      gg = c[1] * al + gg * (1 - al);
      b = c[2] * al + b * (1 - al);
      a = al + a * (1 - al);
    };

    // -- tail
    if (x <= tailB.x1 && x >= tailB.x0 && y >= tailB.y0 && y <= tailB.y1 && inPoly(tailPoly, x, y)) {
      const dx = bodyEndX - x;
      const ang = Math.atan2(y, dx + 0.02);
      const rr = clamp(dx / (tl * (sh.tail === 'lyre' ? 1.35 : 1)));
      const edge = smoothstep(0.012, 0.0, polyDist(tailPoly, x, y)) * smoothstep(0.02, 0.1, rr);
      const base = finColor('tail', clamp(sh.bodyEnd + rr * tl), clamp(y / (sh.T + 1e-6), -1, 1));
      const c = shadeMembrane(base, ang * (sh.tail === 'pointed' ? 22 : 30), rr, edge, false);
      put(tone(c), lerp(0.97, finAlpha - 0.06, smoothstep(0.1, 0.9, rr)));
    }
    // -- pelvic
    if (pelvic && inPoly(pelvic, x, y)) {
      const rr = clamp((-g.bot(0.36) * 0.88 - y) / sh.pelvic);
      const base = finColor('pelvic', 0.36, -0.95);
      const edge = smoothstep(0.008, 0.0, polyDist(pelvic, x, y));
      put(tone(shadeMembrane(base, (x + y * 0.6) * 420, rr, edge * 0.7, false)), finAlpha);
    }
    // -- dorsal / anal fins
    for (let i = 0; i < fins.length; i++) {
      const f = fins[i];
      const hit = finAt(f, x, y);
      if (!hit) continue;
      const fu = f.a + (f.b - f.a) * hit.t;
      const spiny = f.shape === 'spiny';
      const nr = spiny ? 6 : Math.max(8, Math.round((f.b - f.a) * 70));
      const base = finColor(f.sign > 0 ? 'dorsal' : 'anal', fu, f.sign * (0.82 + 0.18 * hit.r));
      const edge = smoothstep(0.86, 1.0, hit.r);
      let c = shadeMembrane(base, hit.t * PI * 2 * nr + (spiny ? PI : 0), hit.r, edge, spiny);
      // soft contact shadow where the fin meets the body
      c = mul3(c, 0.72 + 0.28 * smoothstep(0.0, 0.3, hit.r));
      put(tone(c), lerp(0.98, finAlpha, smoothstep(0.05, 0.8, hit.r)));
    }
    // -- filaments, barbels, lure stalk
    for (let i = 0; i < filaments.length; i++) {
      const [d, t] = tubeDist(filaments[i], x, y);
      if (d < 0) {
        const base = finColor('dorsal', 0.3, 0.9);
        put(tone(mul3(base, 0.8 + 0.3 * t)), 0.96);
      }
    }
    if (lure) {
      const d = Math.hypot(x - lure.x, y - lure.y) / lure.r;
      if (d < 1) put(tone(mix3([1.0, 0.95, 0.7], [1.0, 0.6, 0.25], d * d)), 1);
    }

    // -- body
    const z = zAt(x, y);
    if (z >= 0) {
      const top = g.top(u);
      const bot = g.bot(u);
      const hh = (top + bot) / 2;
      const s = clamp((y - (top - bot) / 2) / hh, -1, 1);
      // surface normal from the thickness field
      const e = 0.004;
      const zx = (Math.max(0, zAt(x + e, y)) - Math.max(0, zAt(x - e, y))) / (2 * e);
      const zy = (Math.max(0, zAt(x, y + e)) - Math.max(0, zAt(x, y - e))) / (2 * e);
      let n = norm3([-zx, -zy, 1]);
      let alb = pat(u, s, 'body');
      // countershading: darker back, paler belly
      alb = mul3(alb, 0.8 + 0.34 * smoothstep(0.7, -0.7, s));
      alb = mix3(alb, add3(mul3(alb, 0.8), [0.2, 0.2, 0.19]), smoothstep(-0.35, -1.0, s) * (look.belly ?? 0.35));
      let gl = gloss;
      let shn = 0.16;
      if (scales > 0) {
        // overlapping scale rows following the flank
        const su = u * (look.scaleU ?? 46);
        const row = (Math.asin(s) / (PI / 2)) * (look.scaleV ?? 11);
        const ri = Math.floor(row);
        const cx = fract(su + (ri % 2 ? 0.5 : 0)) - 0.5;
        const cy = row - ri - 0.5;
        const d = Math.hypot(cx * 1.15 - 0.12, cy);
        const rim = smoothstep(0.3, 0.52, d);
        const fadeEdge = smoothstep(1.0, 0.72, Math.abs(s)) * smoothstep(0.1 + g.ext, 0.24 + g.ext, u) * smoothstep(sh.bodyEnd, sh.bodyEnd - 0.08, u);
        alb = mul3(alb, 1 - 0.13 * rim * scales * fadeEdge);
        n = norm3([n[0] + cx * 0.22 * scales * fadeEdge, n[1] + cy * 0.18 * scales * fadeEdge, n[2]]);
        gl *= 0.75 + 0.5 * (1 - rim);
        shn += 0.05;
      } else {
        const nn = fbm(u * 60, s * 16, 2, seed + 9) - 0.5;
        alb = mul3(alb, 1 + nn * 0.08);
      }
      // gill cover: a soft crescent line and a slightly raised plate in front of it
      const gx = (u - gillU - 0.045 * (1 - s * s)) / 0.012;
      const gill = Math.exp(-gx * gx) * smoothstep(1.0, 0.55, Math.abs(s + 0.1)) * (look.gillLine ?? 0.55);
      alb = mul3(alb, 1 - 0.42 * gill);
      // lateral line
      const ll = Math.exp(-Math.pow((s - 0.12 - 0.1 * Math.sin(u * 3.2)) / 0.03, 2)) * smoothstep(gillU + 0.03, gillU + 0.12, u) * smoothstep(sh.bodyEnd, sh.bodyEnd - 0.1, u);
      alb = mul3(alb, 1 + 0.1 * ll * (look.lateral ?? 1));
      if (look.bodyPost) alb = look.bodyPost(alb, u, s, x, y);
      let c = lit(alb, n, gl, shn, 1);
      // ambient occlusion along the belly and under the chin
      c = mul3(c, 0.78 + 0.22 * smoothstep(-1.0, -0.55, s));
      // mouth
      const mu = (look.mouthLen ?? 0.055) + g.ext * 0.0;
      if (g.ext === 0 && u < mu + 0.03) {
        const my = -bot * 0.18 - (mu - u) * 0.25 * (look.mouthCurve ?? 0.4);
        const md = Math.abs(y - my) / 0.0055;
        c = mul3(c, 1 - 0.75 * Math.exp(-md * md) * smoothstep(mu + 0.02, mu - 0.01, u));
      }
      // silhouette: darken the very edge slightly so the sprite reads on any background
      const edgeDark = smoothstep(0.82, 1.0, Math.abs(s)) * (s < 0 ? 0.3 : 0.12);
      c = mul3(c, 1 - edgeDark);
      put(tone(c), 1);

      // -- eye (on the body): soft socket, coloured iris with a darker limbal ring, deep pupil
      const ed = Math.hypot(x - eye.x, y - eye.y) / eye.r;
      if (ed < 1.3) {
        let ec = mul3([r, gg, b], 1 - 0.38 * smoothstep(1.3, 0.98, ed));
        if (ed < 1.0) {
          const sphere = Math.sqrt(Math.max(0, 1 - ed * ed));
          let iris = mix3(mul3(irisCol, 0.4), irisCol, smoothstep(1.0, 0.62, ed));
          iris = mul3(iris, 0.8 + 0.25 * vnoise(Math.atan2(y - eye.y, x - eye.x) * 9, ed * 5, seed));
          // lit from above: the upper iris is shadowed by the brow, the lower catches light
          iris = mul3(iris, 0.7 + 0.5 * clamp(0.5 - (y - eye.y) / eye.r * 0.5));
          ec = mix3(ec, iris, smoothstep(1.0, 0.9, ed));
          ec = mix3(ec, [0.008, 0.012, 0.022], smoothstep(0.6, 0.52, ed));
          ec = mul3(ec, 0.8 + 0.25 * sphere);
          const h1 = Math.hypot(x - eye.x + eye.r * 0.26, y - eye.y - eye.r * 0.34) / eye.r;
          ec = mix3(ec, [1.6, 1.6, 1.6], smoothstep(0.24, 0.1, h1));
          const h2 = Math.hypot(x - eye.x - eye.r * 0.3, y - eye.y + eye.r * 0.36) / eye.r;
          ec = add3(ec, mul3([0.25, 0.45, 0.6], smoothstep(0.36, 0.06, h2) * 0.45));
        }
        const te = tone(ec);
        r = te[0];
        gg = te[1];
        b = te[2];
      }
    }
    // -- cones (horns, spikes, underbite) drawn over the body
    for (let i = 0; i < cones.length; i++) {
      const c0 = cones[i];
      const hit = coneAt(c0, x, y);
      if (!hit) continue;
      const base = c0.col === 'spike' ? [0.92, 0.9, 0.8] : pat(clamp(0.5 - c0.a[0]), c0.a[1] >= 0 ? 0.8 : -0.8, 'body');
      const sph = Math.sqrt(1 - hit.s * hit.s);
      put(tone(mul3(base, 0.5 + 0.6 * sph + 0.15 * hit.t)), 1);
    }
    if (a <= 0) return false;
    out[0] = r;
    out[1] = gg;
    out[2] = b;
    out[3] = a;
    return true;
  });

  // ---- near-side pectoral fin (own layer so it can flap)
  let pect = null;
  let pectMeta = null;
  if (sh.pect && sh.pect.size > 0) {
    const pu = sh.pect.u + g.ext;
    const prx = xOf(pu);
    const pry = -g.bot(pu) * 0.22;
    const s = sh.pect.size;
    let poly;
    const kind = sh.pect.shape ?? 'oval';
    if (kind === 'wing') poly = chaikin([[0.02, 0.012], [-s * 0.3, -s * 0.2], [-s * 0.62, -s * 0.72], [-s * 0.78, -s * 0.82], [-s * 0.66, -s * 0.42], [-s * 0.42, -s * 0.06], [-s * 0.2, 0.02]], 2);
    else if (kind === 'fan') {
      poly = [[0.01, 0.0]];
      for (let k = 0; k <= 12; k++) {
        const a = 0.75 - (k / 12) * 2.5;
        const rr = s * (0.82 + 0.18 * Math.abs(Math.sin(k * 1.7)));
        poly.push([-Math.cos(a) * rr * 0.95, Math.sin(a) * rr * 0.8 - s * 0.1]);
      }
      poly = chaikin(poly, 1);
    } else if (kind === 'arm') poly = chaikin([[0.02, 0.01], [-s * 0.1, -s * 0.5], [-s * 0.3, -s * 0.98], [s * 0.2, -s * 1.02], [s * 0.26, -s * 0.5], [s * 0.14, 0.0]], 2);
    else {
      poly = [];
      for (let k = 0; k <= 14; k++) {
        const a = (k / 14) * PI;
        poly.push([-Math.sin(a) * s * 0.98 * (0.9 + 0.1 * Math.cos(a)), Math.cos(a) * s * 0.34 - s * 0.1 - Math.sin(a) * s * 0.12]);
      }
      poly.push([0.015, -s * 0.2]);
      poly = chaikin(poly, 1);
    }
    const pb = polyBounds(poly);
    const m = 0.02;
    const pw = Math.ceil((pb.x1 - pb.x0 + m * 2) * PX);
    const ph = Math.ceil((pb.y1 - pb.y0 + m * 2) * PX);
    const base = finColor('pect', pu, -0.2);
    pect = shade(pw, ph, ss, (px, py, out) => {
      const x = pb.x0 - m + px / PX;
      const y = pb.y1 + m - py / PX;
      if (!inPoly(poly, x, y)) return false;
      const rr = clamp(Math.hypot(x, y) / (s * 1.0));
      const ang = Math.atan2(y, -x);
      const edge = smoothstep(0.01, 0.0, polyDist(poly, x, y)) * smoothstep(0.1, 0.3, rr);
      const c = shadeMembrane(mul3(base, 1.08), ang * (kind === 'fan' ? 26 : 34), rr, edge, kind === 'fan');
      out[0] = tone(c)[0];
      out[1] = tone(c)[1];
      out[2] = tone(c)[2];
      out[3] = lerp(0.95, kind === 'arm' ? 0.96 : finAlpha - 0.12, smoothstep(0.05, 0.85, rr));
      return true;
    });
    pectMeta = {
      // root pivot inside the pectoral layer (px) and where that pivot sits on the body layer (px)
      pivot: [Math.round((0 - (pb.x0 - m)) * PX), Math.round((pb.y1 + m - 0) * PX)],
      at: [Math.round((prx - xmin) * PX), Math.round((ymax - pry) * PX)],
    };
  }

  return {
    body,
    pect,
    meta: {
      px: PX,
      // model origin (creature centre) in the body layer
      origin: [Math.round((0 - xmin) * PX), Math.round(ymax * PX)],
      // x (px) of the tail joint and the nose / tail tip
      tailX: Math.round((bodyEndX - xmin) * PX),
      noseX: Math.round((0.5 - xmin) * PX),
      tipX: Math.round((-0.5 - xmin) * PX),
      pect: pectMeta,
      halfH: Math.round(Math.max(ymax, -ymin) * PX),
    },
  };
}

// ---------------------------------------------------------------------------- sprite definitions
const SPECIES = JSON.parse(fs.readFileSync(new URL('./data/species.json', import.meta.url)));
const SHAPES = JSON.parse(fs.readFileSync(new URL('./data/fish_shapes.json', import.meta.url)));
const BY_ID = new Map(SPECIES.map((s) => [s.id, s]));

/** Species drawn by this module (everything whose model is a fish body plan). */
export const IDS = SPECIES.filter((s) => SHAPES[s.model]).map((s) => s.id);

/** Pixels of body length each species is authored at: big enough for portraits, capped for giants. */
export function authoredLength(sp) {
  return Math.round(clamp(110 * sp.len, 190, 640) / 2) * 2;
}

/** Copy columns [x0,x1) of an image; optionally feather the left edge so it blends over the part behind it. */
function slice(img, x0, x1, feather = 0) {
  const out = crop(img, x0, 0, x1 - x0, img.h);
  for (let x = 0; x < Math.min(feather, out.w); x++) {
    const k = (x + 0.5) / feather;
    for (let y = 0; y < out.h; y++) {
      const i = (y * out.w + x) * 4;
      out.d[i] *= k;
      out.d[i + 1] *= k;
      out.d[i + 2] *= k;
      out.d[i + 3] *= k;
    }
  }
  return out;
}

/**
 * Build the rigged sprite for a fish species.
 * Parts, back to front: tail (rotates/narrows with the swim cycle), optional rear body strips
 * (slender fish undulate), front body, near pectoral fin (flaps).
 */
export function build(id, opts = {}) {
  const sp = BY_ID.get(id) ?? opts.species;
  if (!sp) throw new Error(`Unknown species ${id}`);
  const sh = { ...SHAPES[sp.model], ...(LOOKS[sp.id]?.shape ?? {}) };
  const px = opts.px ?? authoredLength(sp);
  const r = renderFish(sp, sh, { px, ss: opts.ss ?? 3, look: LOOKS[sp.id] });
  const m = r.meta;
  const [ox, oy] = m.origin;
  const parts = [];
  const slender = sh.H < 0.13 || sp.model === 'greatWhite';
  const eel = sp.model === 'moray';
  const ov = Math.max(3, Math.round(px * 0.02));
  const tailCut = Math.min(r.body.w, m.tailX + ov);
  // wave set-up for slender swimmers
  const uStart = eel ? 0.18 : 0.45;
  const xStart = Math.round(ox + (0.5 - uStart) * px);
  const strips = slender ? (eel ? 11 : px > 320 ? 7 : 4) : 0;
  const tailAmp = slender ? px * (eel ? 0.075 : 0.035) : 0;
  const waves = eel ? 1.5 : 0.8;
  const env = (u) => Math.pow(clamp((u - uStart) / (1 - uStart)), 1.4);
  const lagOf = (u) => clamp((u - uStart) / (1 - uStart)) * Math.PI * 2 * waves;
  parts.push({
    img: slice(r.body, 0, tailCut),
    pivot: [m.tailX, oy],
    at: [m.tailX - ox, 0],
    anim: { kind: 'tail', rot: eel ? 4 : slender ? 7 : 9, squash: eel ? 0.1 : 0.32, phase: 0, amp: tailAmp * env(sh.bodyEnd), lag: lagOf(sh.bodyEnd) },
  });
  let front = m.tailX;
  if (strips > 0) {
    const span = xStart - m.tailX;
    for (let k = 0; k < strips; k++) {
      const a = m.tailX + Math.round((span * k) / strips);
      const b = m.tailX + Math.round((span * (k + 1)) / strips);
      const cx = (a + b) / 2;
      const u = 0.5 - (cx - ox) / px;
      parts.push({
        img: slice(r.body, a - ov, b, ov),
        pivot: [Math.round(cx - (a - ov)), oy],
        at: [Math.round(cx - ox), 0],
        anim: { kind: 'wave', amp: tailAmp * env(u), lag: lagOf(u) },
      });
    }
    front = xStart;
  }
  parts.push({ img: slice(r.body, front - ov, r.body.w, ov), pivot: [ox - (front - ov), oy], at: [0, 0], anim: null });
  if (r.pect) {
    const kind = sh.pect.shape ?? 'oval';
    parts.push({
      img: r.pect,
      pivot: m.pect.pivot,
      at: [m.pect.at[0] - ox, m.pect.at[1] - oy],
      anim: { kind: 'flap', amp: kind === 'wing' ? 3 : kind === 'arm' ? 5 : 14, rate: kind === 'fan' ? 0.5 : 1.6, phase: 0.6 },
    });
  }
  return { lenPx: px, anchor: 'center', parts };
}
