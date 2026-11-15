/**
 * Dedicated sprite renderer for the six big / slender hunters that the generic fish generator
 * (fish.mjs) cannot do justice: great white, blacktip reef shark, whitemouth moray, blackfin
 * barracuda, humphead wrasse and crocodile needlefish.
 *
 * Same look as fish.mjs and critters.mjs (shared light rig in lib/light.mjs, linear light, filmic
 * tone curve, core.shade() supersampling), but every animal has its own anatomy:
 *  - the body is a smooth closed outline (centripetal Catmull-Rom through hand-placed points) lofted
 *    into a rounded height field -> per-pixel normal -> lit();
 *  - fins are smooth polygons with a signed distance field: shark fins are shaded as thick foils
 *    (lit(), blended into the trunk), ray fins as translucent tissue (membrane());
 *  - gill slits, jaws, teeth, eyes, keels and scale rows are painted into the albedo and the normal.
 *
 * Authoring conventions
 *  - Model units: 1 = body length (snout tip to tail tip), x right, y UP, origin = body centre on
 *    the swimming axis, animals face +x (snout at x = +0.5, tail tip at x = -0.5).
 *  - Edges are anti-aliased analytically from the distance fields, so ss = 2 is already clean;
 *    species with hair-thin features (teeth, beak) default to ss = 3.
 *  - Rig (see lib/sprite.mjs and DrawCreature in channel/source/render.brs), back to front:
 *    tail (rotates, narrows, follows the body wave), wave strips from the tail joint forward,
 *    static front body, near-side pectoral fin (flap). The strips are cut so that the neutral
 *    pose composites back to the original render exactly, also through translucent fins.
 *  - Everything is deterministic: noise seeds derive from the species id.
 */
import fs from 'node:fs';
import {
  Img, shade, bounds, crop, hex, mix3, mul3, add3, norm3, clamp, lerp, smoothstep, fract, hash2, vnoise, fbm, worley,
  saturate, tone, lum, hashStr,
} from './lib/core.mjs';
import { lit, membrane } from './lib/light.mjs';

const PI = Math.PI;
const TAU = PI * 2;
const SPECIES = JSON.parse(fs.readFileSync(new URL('./data/species.json', import.meta.url)));
const BY_ID = new Map(SPECIES.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------- small maths
const gauss = (v, w) => Math.exp(-(v * v) / (w * w));
/** Tilt a unit normal in place (bump detail). */
function nudge(n, dx, dy) {
  const x = n[0] + dx;
  const y = n[1] + dy;
  const l = Math.hypot(x, y, n[2]) || 1;
  n[0] = x / l;
  n[1] = y / l;
  n[2] /= l;
}
/** Smooth organic noise 0..1 (rotated domain hides the grid of raw value noise). */
const organic = (x, y, seed, oct = 3) => fbm(x * 0.8 + y * 0.6 + 7.3, y * 0.8 - x * 0.6 + 3.1, oct, seed);
/** Distance from a point to a segment, plus the parameter along it. */
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2) : 0;
  return [Math.hypot(x - ax - dx * t, y - ay - dy * t), t];
}

// ---------------------------------------------------------------------------- curves and outlines
/** Centripetal Catmull-Rom through 2D points (no overshoot on unevenly spaced points). */
function catmull(pts, per = 10, closed = false) {
  const n = pts.length;
  if (n < 2) return pts.map((p) => [p[0], p[1]]);
  const P = (i) => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const d1 = Math.max(1e-5, Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])));
    const d2 = Math.max(1e-5, Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])));
    const d3 = Math.max(1e-5, Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])));
    const m1 = [0, 0];
    const m2 = [0, 0];
    for (let c = 0; c < 2; c++) {
      m1[c] = d2 * ((p1[c] - p0[c]) / d1 - (p2[c] - p0[c]) / (d1 + d2) + (p2[c] - p1[c]) / d2);
      m2[c] = d2 * ((p2[c] - p1[c]) / d2 - (p3[c] - p1[c]) / (d2 + d3) + (p3[c] - p2[c]) / d3);
    }
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      out.push([h00 * p1[0] + h10 * m1[0] + h01 * p2[0] + h11 * m2[0], h00 * p1[1] + h10 * m1[1] + h01 * p2[1] + h11 * m2[1]]);
    }
  }
  if (!closed) out.push([pts[n - 1][0], pts[n - 1][1]]);
  return out;
}

/**
 * Closed smooth outline through control points. A point written [x, y, 1] is kept as a sharp
 * corner (fin tips, jaw notches); the runs between corners are splined.
 */
function outline(pts, per = 8) {
  const n = pts.length;
  const corners = [];
  for (let i = 0; i < n; i++) if (pts[i][2]) corners.push(i);
  if (!corners.length) return catmull(pts, per, true);
  const out = [];
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c];
    const b = corners[(c + 1) % corners.length];
    const run = [];
    let i = a;
    do {
      run.push(pts[i]);
      i = (i + 1) % n;
    } while (i !== b);
    run.push(pts[b]);
    const seg = catmull(run, per, false);
    seg.pop();
    for (const q of seg) out.push(q);
  }
  return out;
}

/** Smooth function through [x, v] control points (any x order), tabulated for fast lookups. */
function curve1(pts, N = 1024) {
  const s = pts.slice().sort((a, b) => a[0] - b[0]);
  const xa = s[0][0];
  const xb = s[s.length - 1][0];
  const pl = catmull(s, 12, false);
  const t = new Float32Array(N + 1);
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const x = xa + ((xb - xa) * i) / N;
    while (j < pl.length - 2 && pl[j + 1][0] < x) j++;
    const a = pl[j];
    const b = pl[j + 1];
    t[i] = b[0] > a[0] ? a[1] + ((b[1] - a[1]) * clamp((x - a[0]) / (b[0] - a[0]))) : a[1];
  }
  return (x) => {
    const f = clamp((x - xa) / (xb - xa)) * N;
    const i = Math.min(N - 1, Math.floor(f));
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  };
}

function polyBox(poly, pad = 0) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/**
 * Signed distance field of a polygon on a grid (positive inside, clamped to +-band), sampled
 * bilinearly. It gives every shape analytic edge anti-aliasing, an inward gradient for pillow
 * shading and cheap "how far from the outline" queries.
 */
function makeSdf(poly, cell, band) {
  const bb = polyBox(poly, cell * 2);
  const x0 = bb[0];
  const y0 = bb[1];
  const nx = Math.ceil((bb[2] - x0) / cell) + 1;
  const ny = Math.ceil((bb[3] - y0) / cell) + 1;
  const d = new Float32Array(nx * ny).fill(band * band);
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j][0];
    const ay = poly[j][1];
    const ex = poly[i][0] - ax;
    const ey = poly[i][1] - ay;
    const l2 = ex * ex + ey * ey;
    const i0 = Math.max(0, Math.floor((Math.min(ax, ax + ex) - band - x0) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, ax + ex) + band - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, ay + ey) - band - y0) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, ay + ey) + band - y0) / cell));
    for (let jj = j0; jj <= j1; jj++) {
      const y = y0 + jj * cell;
      for (let ii = i0; ii <= i1; ii++) {
        const x = x0 + ii * cell;
        const t = l2 > 0 ? clamp(((x - ax) * ex + (y - ay) * ey) / l2) : 0;
        const dx = x - ax - ex * t;
        const dy = y - ay - ey * t;
        const dd = dx * dx + dy * dy;
        const q = jj * nx + ii;
        if (dd < d[q]) d[q] = dd;
      }
    }
  }
  const xs = [];
  for (let jj = 0; jj < ny; jj++) {
    const y = y0 + jj * cell;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = poly[i][1];
      const yj = poly[j][1];
      if (yi > y !== yj > y) xs.push(((poly[j][0] - poly[i][0]) * (y - yi)) / (yj - yi) + poly[i][0]);
    }
    xs.sort((a, b) => a - b);
    let k = 0;
    let inside = false;
    for (let ii = 0; ii < nx; ii++) {
      const x = x0 + ii * cell;
      while (k < xs.length && xs[k] <= x) {
        inside = !inside;
        k++;
      }
      const q = jj * nx + ii;
      d[q] = inside ? Math.sqrt(d[q]) : -Math.sqrt(d[q]);
    }
  }
  const fx1 = nx - 1.001;
  const fy1 = ny - 1.001;
  const at = (x, y) => {
    const fx = (x - x0) / cell;
    const fy = (y - y0) / cell;
    if (fx < 0 || fy < 0 || fx > fx1 || fy > fy1) return -band;
    const ix = fx | 0;
    const iy = fy | 0;
    const tx = fx - ix;
    const ty = fy - iy;
    const q = iy * nx + ix;
    const a = d[q];
    const b = d[q + 1];
    const c = d[q + nx];
    const e = d[q + nx + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
  };
  return { at, poly, band, box: bb };
}

// ---------------------------------------------------------------------------- lofted body
/**
 * A fish trunk: closed side-view outline lofted into a rounded height field.
 * o.pts    outline control points (see outline()), any winding
 * o.ratio  half-thickness toward the viewer as a fraction of the half-depth (number or [x, v] points)
 * o.mid    where the cross-section is widest, 0 = belly line .. 1 = back line (number or points)
 * o.pT/pB  superellipse exponents of the upper / lower half (2 = round, higher = boxier)
 * geom(x, y, G) fills G.z (thickness), G.s (-1 belly .. +1 back), G.n (unit normal), G.top, G.bot.
 */
function makeBody(o, px) {
  const poly = outline(o.pts, o.per ?? 10);
  const bb = polyBox(poly);
  const xa = bb[0];
  const xb = bb[2];
  const N = 4096;
  const inv = N / (xb - xa);
  const T = new Float32Array(N + 2).fill(-1e9);
  const Bt = new Float32Array(N + 2).fill(1e9);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    let ax = poly[j][0];
    let ay = poly[j][1];
    let bx = poly[i][0];
    let by = poly[i][1];
    if (ax > bx) {
      [ax, bx] = [bx, ax];
      [ay, by] = [by, ay];
    }
    const i0 = Math.max(0, Math.ceil((ax - xa) * inv - 1e-9));
    const i1 = Math.min(N, Math.floor((bx - xa) * inv + 1e-9));
    for (let k = i0; k <= i1; k++) {
      const x = xa + k / inv;
      const f = bx > ax ? clamp((x - ax) / (bx - ax)) : 0.5;
      const y = ay + (by - ay) * f;
      if (y > T[k]) T[k] = y;
      if (y < Bt[k]) Bt[k] = y;
    }
  }
  for (let k = 0; k <= N + 1; k++) {
    if (T[k] < Bt[k]) {
      const q = k > 0 && T[k - 1] >= Bt[k - 1] ? k - 1 : -1;
      const v = q >= 0 ? (T[q] + Bt[q]) / 2 : 0;
      T[k] = v;
      Bt[k] = v;
    }
  }
  const fn = (v, d) => (v === undefined ? () => d : typeof v === 'number' ? () => v : curve1(v));
  const ratio = fn(o.ratio, 0.85);
  const mid = fn(o.mid, 0.5);
  const M = new Float32Array(N + 2);
  const W = new Float32Array(N + 2);
  for (let k = 0; k <= N + 1; k++) {
    const x = xa + k / inv;
    M[k] = Bt[k] + (T[k] - Bt[k]) * mid(x);
    W[k] = ((T[k] - Bt[k]) / 2) * ratio(x);
  }
  const pT = o.pT ?? 2;
  const pB = o.pB ?? 2;
  const relief = o.relief ?? 1;
  const col = (x, c) => {
    const f = (x - xa) * inv;
    if (!(f > 0 && f < N)) {
      c.ok = false;
      return c;
    }
    const i = f | 0;
    const t = f - i;
    c.ok = true;
    c.top = T[i] + (T[i + 1] - T[i]) * t;
    c.bot = Bt[i] + (Bt[i + 1] - Bt[i]) * t;
    c.m = M[i] + (M[i + 1] - M[i]) * t;
    c.w = W[i] + (W[i + 1] - W[i]) * t;
    return c;
  };
  const zc = (c, y) => {
    if (!c.ok) return 0;
    const dy = y - c.m;
    const h = dy >= 0 ? c.top - c.m : c.m - c.bot;
    if (!(h > 1e-7)) return 0;
    const q = Math.abs(dy) / h;
    if (q >= 1) return 0;
    const p = dy >= 0 ? pT : pB;
    return c.w * Math.pow(1 - Math.pow(q, p), 1 / p);
  };
  const c0 = {};
  const c1 = {};
  const c2 = {};
  const e = (o.e ?? 1.0) * px;
  const geom = (x, y, G) => {
    col(x, c0);
    col(x - e, c1);
    col(x + e, c2);
    G.top = c0.top;
    G.bot = c0.bot;
    G.mid = c0.m;
    G.w = c0.w;
    const dy = y - c0.m;
    const h = dy >= 0 ? c0.top - c0.m : c0.m - c0.bot;
    G.s = h > 1e-7 ? clamp(dy / h, -1, 1) : 0;
    G.z = zc(c0, y);
    const zx = (zc(c2, y) - zc(c1, y)) / (2 * e);
    const zy = (zc(c0, y + e) - zc(c0, y - e)) / (2 * e);
    const nx = -zx * relief;
    const ny = -zy * relief;
    const l = Math.hypot(nx, ny, 1);
    G.n[0] = nx / l;
    G.n[1] = ny / l;
    G.n[2] = 1 / l;
    return G;
  };
  const top = (x) => col(x, c0).top ?? 0;
  const bot = (x) => col(x, c0).bot ?? 0;
  return { poly, box: bb, geom, top, bot, xa, xb, sdf: makeSdf(poly, 0.6 * px, o.band ?? 0.022) };
}

// ---------------------------------------------------------------------------- drawing
/** Canvas for a drawing that covers the model-space box `ext`; the sprite origin lands on a whole pixel. */
function makeView(S, ext) {
  const L = Math.ceil(-ext[0] * S) + 4;
  const R = Math.ceil(ext[2] * S) + 4;
  const U = Math.ceil(ext[3] * S) + 4;
  const D = Math.ceil(-ext[1] * S) + 4;
  return { S, x0: -L / S, y1: U / S, W: L + R, H: U + D, ox: L, oy: U };
}
function unionBox(boxes, pad = 0) {
  const b = [1e9, 1e9, -1e9, -1e9];
  for (const q of boxes) {
    b[0] = Math.min(b[0], q[0]);
    b[1] = Math.min(b[1], q[1]);
    b[2] = Math.max(b[2], q[2]);
    b[3] = Math.max(b[3], q[3]);
  }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/**
 * Paint layers back to front with core.shade(). A layer is { box: [x0, y0, x1, y1], fn(x, y, out) }
 * in model units; fn writes straight-alpha linear colour (already tone mapped) and returns false
 * for empty samples.
 */
function paint(view, ss, layers) {
  const tmp = [0, 0, 0, 0];
  const { S, x0, y1 } = view;
  return shade(view.W, view.H, ss, (px, py, out) => {
    const x = x0 + px / S;
    const y = y1 - py / S;
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const bx = L.box;
      if (x < bx[0] || x > bx[2] || y < bx[1] || y > bx[3]) continue;
      tmp[3] = 0;
      if (L.fn(x, y, tmp) === false) continue;
      const al = tmp[3];
      if (!(al > 0)) continue;
      const k = 1 - al;
      r = tmp[0] * al + r * k;
      g = tmp[1] * al + g * k;
      b = tmp[2] * al + b * k;
      a = al + a * k;
    }
    if (a <= 0) return false;
    out[0] = r / a;
    out[1] = g / a;
    out[2] = b / a;
    out[3] = a;
    return true;
  });
}

/** Light a skin sample: shared rig, soft silhouette darkening so the sprite reads on any water, tone curve. */
function skin(alb, n, gloss, sheen, ao, edge = 0.22) {
  let c = lit(alb, n, gloss, sheen, ao);
  if (edge > 0 && n[2] < 0.5) c = mul3(c, 1 - edge * (1 - smoothstep(0.0, 0.5, n[2])) * (n[1] < 0 ? 1 : 0.4));
  return tone(c);
}

/**
 * Glossy eye painted over what is already in `c` (linear, tone mapped). Returns the new colour.
 * o: iris, pr (pupil radius 0..1), slit (vertical slit pupil), ring (pale eyelid ring colour or null).
 */
function eyeOver(c, ex, ey, o) {
  const ed = Math.hypot(ex, ey);
  if (ed >= 1.5) return c;
  let out = mul3(c, 1 - (o.socket ?? 0.38) * smoothstep(1.5, 0.98, ed));
  if (ed < 1.0) {
    const iris = o.iris;
    const sphere = Math.sqrt(Math.max(0, 1 - ed * ed));
    let ic = mix3(mul3(iris, 0.4), iris, smoothstep(1.0, 0.62, ed));
    ic = mul3(ic, 0.8 + 0.25 * vnoise(Math.atan2(ey, ex) * 9, ed * 5, o.seed ?? 1));
    ic = mul3(ic, 0.7 + 0.5 * clamp(0.5 - ey * 0.5));
    const pr = o.pr ?? 0.56;
    const p = o.slit ? smoothstep(pr * 0.5 + 0.06, pr * 0.5 - 0.05, Math.abs(ex)) * smoothstep(0.92, 0.74, Math.abs(ey)) : smoothstep(pr + 0.05, pr - 0.04, ed);
    ic = mix3(ic, [0.008, 0.012, 0.022], p);
    ic = mul3(ic, 0.8 + 0.25 * sphere);
    const h1 = Math.hypot(ex + 0.26, ey - 0.34);
    ic = mix3(ic, [1.6, 1.6, 1.6], smoothstep(0.26, 0.1, h1));
    const h2 = Math.hypot(ex - 0.3, ey + 0.36);
    ic = add3(ic, mul3([0.25, 0.45, 0.6], smoothstep(0.36, 0.06, h2) * 0.45));
    ic = mul3(ic, 1 - 0.35 * smoothstep(0.82, 1.0, ed));
    out = mix3(out, tone(ic), smoothstep(1.0, 0.9, ed));
  }
  return out;
}

// ---------------------------------------------------------------------------- rig assembly
/**
 * Cut the painted body layer into the swim rig.
 * R: { xTail, xStart, strips, ampPed, lagPed, pow, rot, squash }
 *   xTail   model x of the tail joint (caudal peduncle): the tail part pivots here
 *   xStart  model x where the body wave starts (everything in front is the static part)
 *   strips  number of wave strips between the two
 *   ampPed  wave amplitude at the tail joint, as a fraction of the body length
 *   lagPed  phase lag at the tail joint (radians); the lag grows linearly along the wave zone
 *   pow     exponent of the amplitude envelope (as in fish.mjs: amp ~ ((u - uStart) / span) ^ pow)
 * Neighbouring parts share a feathered zone; the part in front fades in over the part behind, whose
 * translucent pixels are thinned by exactly the amount that makes the neutral pose identical to img.
 */
function sliceRig(view, img, R) {
  const { S, ox, oy } = view;
  const X = (x) => Math.round(ox + x * S);
  const ov = Math.max(4, Math.round(S * 0.02));
  const under = 2;
  const bTail = X(R.xTail);
  const bStart = X(R.xStart);
  const n = R.strips;
  const bnd = [];
  for (let k = 0; k <= n; k++) bnd.push(Math.round(bTail + ((bStart - bTail) * k) / n));
  const uOf = (pxl) => 0.5 - (pxl - ox) / S;
  const uS = uOf(bStart);
  const uP = uOf(bTail);
  const tOf = (u) => clamp((u - uS) / (uP - uS), 0, 1.6);
  const ampOf = (u) => Math.round(R.ampPed * S * Math.pow(tOf(u), R.pow ?? 1.4) * 100) / 100;
  const lagOf = (u) => Math.round(R.lagPed * tOf(u) * 1000) / 1000;
  // weight of the part in front of boundary j at pixel column px (0 behind the feather, 1 in front)
  const ramp = (j, px) => clamp((px + 0.5 - (bnd[j] - ov / 2)) / ov);
  const parts = [];
  const cut = (lo, hi, pivot, anim) => {
    // lo / hi: boundary indices on the tail side / head side of this part (-1 = none)
    const x0 = lo < 0 ? 0 : Math.max(0, Math.floor(bnd[lo] - ov / 2));
    const x1 = hi < 0 ? img.w : Math.min(img.w, Math.ceil(bnd[hi] + ov / 2) + under);
    const o = new Img(img.w, img.h);
    for (let y = 0; y < img.h; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * img.w + x) * 4;
        const a = img.d[i + 3];
        if (a <= 0) continue;
        let k = lo < 0 ? 1 : ramp(lo, x);
        if (hi >= 0) {
          const kf = ramp(hi, x);
          if (kf >= 1) k *= a >= 0.999 ? 1 : 0;
          else k *= (1 - kf) / (1 - kf * a);
        }
        if (!(k > 0)) continue;
        o.d[i] = img.d[i] * k;
        o.d[i + 1] = img.d[i + 1] * k;
        o.d[i + 2] = img.d[i + 2] * k;
        o.d[i + 3] = a * k;
      }
    parts.push(partFrom(o, pivot, [ox, oy], anim));
  };
  cut(-1, 0, [bTail, oy], { kind: 'tail', rot: R.rot, squash: R.squash, amp: ampOf(uP), lag: lagOf(uP) });
  for (let k = 0; k < n; k++) {
    const cx = Math.round((bnd[k] + bnd[k + 1]) / 2);
    const u = uOf(cx);
    cut(k, k + 1, [cx, oy], { kind: 'wave', amp: ampOf(u), lag: lagOf(u) });
  }
  cut(n, -1, [bStart + Math.round(ov / 2) + 4, oy], null);
  return parts;
}

/**
 * Crop a canvas-sized image to its content plus a 3 px transparent margin and express the pivot
 * (canvas pixels) inside the crop. The crop is nudged so the pivot is a multiple of 4: the device
 * halves and quarters pivots for its mip levels, and this keeps neighbouring strips registered.
 */
function partFrom(img, pivot, origin, anim) {
  const b = bounds(img, 0.004) ?? { x0: pivot[0], y0: pivot[1], x1: pivot[0], y1: pivot[1] };
  const m = 3;
  let x0 = Math.min(b.x0, pivot[0]) - m;
  let y0 = Math.min(b.y0, pivot[1]) - m;
  x0 -= (((pivot[0] - x0) % 4) + 4) % 4 === 0 ? 0 : 4 - ((((pivot[0] - x0) % 4) + 4) % 4);
  y0 -= (((pivot[1] - y0) % 4) + 4) % 4 === 0 ? 0 : 4 - ((((pivot[1] - y0) % 4) + 4) % 4);
  const x1 = Math.max(b.x1, pivot[0]) + m;
  const y1 = Math.max(b.y1, pivot[1]) + m;
  return {
    img: crop(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1),
    pivot: [pivot[0] - x0, pivot[1] - y0],
    at: [pivot[0] - origin[0], pivot[1] - origin[1]],
    anim,
  };
}

// ---------------------------------------------------------------------------- sharks
/**
 * Thick, opaque shark fin: pillow-shaded foil whose base melts into the trunk.
 * o.alb(x, y, sd) -> albedo; o.dim darkens far-side fins; o.root(x, y) -> 0..1 fades the base in.
 */
function sharkFin(sdf, pitch, o) {
  const e = pitch * 1.5;
  const n = [0, 0, 1];
  return {
    box: sdf.box,
    fn: (x, y, out) => {
      const sd = sdf.at(x, y);
      if (sd <= -0.5 * pitch) return false;
      let alpha = clamp(0.5 + sd / pitch);
      if (o.root) alpha *= o.root(x, y);
      if (!(alpha > 0)) return false;
      const gx = (sdf.at(x + e, y) - sdf.at(x - e, y)) / (2 * e);
      const gy = (sdf.at(x, y + e) - sdf.at(x, y - e)) / (2 * e);
      const d = Math.max(0, sd);
      // rounded rim + a broad swell so the fin reads as a solid foil rather than a cut-out
      const k = (o.rim ?? 1.1) * Math.exp(-d / (o.rimW ?? 0.006)) + (o.swell ?? 0.35) * Math.exp(-d / (o.swellW ?? 0.03));
      n[0] = -gx * k + (o.tilt ? o.tilt[0] : 0);
      n[1] = -gy * k + (o.tilt ? o.tilt[1] : 0);
      n[2] = 1;
      const l = Math.hypot(n[0], n[1], 1);
      n[0] /= l;
      n[1] /= l;
      n[2] /= l;
      let alb = o.alb(x, y, sd);
      if (o.streak) alb = mul3(alb, 1 + o.streak[2] * Math.cos((x * o.streak[0] + y * o.streak[1])));
      let c = lit(alb, n, o.gloss ?? 0.18, o.sheen ?? 0.14, o.ao ? o.ao(x, y) : 1);
      c = mul3(c, 1 - 0.16 * smoothstep(0.004, 0.0, sd));
      if (o.dim) c = mix3(mul3(c, 1 - o.dim * 0.5), [0.05, 0.14, 0.22], o.dim * 0.22);
      c = tone(c);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = alpha;
      return true;
    },
  };
}

function buildShark(id, opts, K) {
  const sp = BY_ID.get(id);
  const S = opts.px ?? K.lenPx;
  const ss = opts.ss ?? K.ss ?? 2;
  const px = 1 / S;
  const pitch = px / ss;
  const seed = hashStr(id) & 0xffff;
  const body = makeBody(K.body, px);
  const F = {};
  for (const [name, pts] of Object.entries(K.fins)) F[name] = makeSdf(outline(pts, 8), 0.6 * px, 0.04);
  const P = K.paint({ sp, seed, body, F, px, pitch });

  // ---- body layer: everything except the near pectoral fin
  const medianFins = ['caudal', 'dorsal1', 'dorsal2', 'anal'];
  const G = { n: [0, 0, 1] };
  const gills = K.gills;
  const M = K.mouth;
  const bodyFn = (x, y, out) => {
    const sd = body.sdf.at(x, y);
    if (sd <= -0.5 * pitch) return false;
    let alpha = clamp(0.5 + sd / pitch);
    body.geom(x, y, G);
    const n = G.n;
    const s = G.s;
    let alb = P.skin(x, y, s);
    let ao = 0.8 + 0.2 * smoothstep(-1.0, -0.45, s);
    let over = null;
    // ---- gill slits: a rounded flap edge in front, a dark opening, a soft shadow behind
    if (x > gills.x0 && x < gills.x1 && y > gills.y0 && y < gills.y1) {
      for (let i = 0; i < gills.n; i++) {
        const yb = gills.bot[0] + gills.bot[1] * i;
        const yt = gills.top[0] + gills.top[1] * i;
        const t = (y - yb) / (yt - yb);
        if (t < -0.05 || t > 1.05) continue;
        const cx = gills.x + gills.dx * i + gills.slant * (t - 0.5) - gills.bow * Math.sin(PI * clamp(t));
        const q = (cx - x) / gills.w; // + behind the slit
        if (q < -4 || q > 7) continue;
        const k = smoothstep(-0.02, 0.14, t) * smoothstep(1.02, 0.86, t);
        const core = Math.exp(-Math.pow((q - 0.35) / 0.8, 2)) * k;
        const lip = Math.exp(-Math.pow((q + 1.5) / 1.0, 2)) * k;
        const sh = (q > 0.5 ? Math.exp(-(q - 0.5) / 2.2) : 0) * k;
        nudge(n, -0.55 * lip + 0.38 * sh, 0);
        alb = mul3(alb, (1 - 0.82 * core) * (1 - 0.2 * sh) * (1 + 0.12 * lip));
        ao *= 1 - 0.5 * core;
      }
    }
    // ---- mouth: upper jaw line, dark opening with a hint of teeth, lower jaw
    if (x > M.xc - 0.03 && x < M.xf + 0.004 && y < M.yf + 0.02 && y > M.yc - 0.03) {
      const t = (M.xf - x) / (M.xf - M.xc);
      if (t >= 0 && t <= 1) {
        const yU = lerp(M.yf, M.yc, t) + M.bow * Math.sin(PI * t);
        const gap = M.gap * Math.pow(1 - t, 0.75) * smoothstep(1.0, 0.86, t) + 0.6 * px;
        const yL = yU - gap;
        if (y < yU && y > yL) {
          // inside the mouth
          let mc = mix3(M.inner, mul3(M.inner, 0.35), smoothstep(yL, yU, y));
          const tw = M.tooth;
          const fx = (M.xf - x) / tw + 0.15;
          const tx = Math.abs(fract(fx) - 0.5) * 2; // 0 at the tooth axis .. 1 between teeth
          const th = tw * 0.95 * (1 - 0.45 * t);
          const du = (yU - y) / th;
          if (du < 1 - tx * 0.98) mc = mix3(mul3(M.teeth, 0.62 + 0.38 * du), M.teeth, 0.3);
          const fx2 = fx + 0.5;
          const tx2 = Math.abs(fract(fx2) - 0.5) * 2;
          const dl = (y - yL) / (th * 0.62);
          if (dl < 1 - tx2 * 1.05) mc = mul3(M.teeth, 0.6 + 0.3 * dl);
          over = mc;
        } else {
          // lips: a dark line above the teeth, shading on the lower jaw rim
          const dU = (y - yU) / px;
          if (dU >= 0 && dU < 2.2) alb = mul3(alb, 1 - 0.55 * smoothstep(2.2, 0.2, dU) * smoothstep(1.0, 0.9, t));
          const dL = (yL - y) / px;
          if (dL >= 0 && dL < 3) {
            alb = mul3(alb, 1 - 0.3 * smoothstep(3, 0, dL));
            nudge(n, 0, 0.3 * smoothstep(3, 0, dL));
          }
        }
      }
      // labial furrow and jaw hinge crease behind the mouth corner
      for (const f of M.furrows) {
        const [d, ft] = segDist(x, y, f[0], f[1], f[2], f[3]);
        const k = smoothstep(1.3 * px, 0.2 * px, d) * (1 - ft * 0.7) * f[4];
        alb = mul3(alb, 1 - 0.5 * k);
      }
    }
    if (P.detail) alb = P.detail(alb, x, y, s, n, G);
    let c;
    if (over) c = tone(mul3(over, 0.9));
    else c = skin(alb, n, K.gloss ?? 0.26, K.sheen ?? 0.2, ao, 0.2);
    // ---- eye
    const E = K.eye;
    const ex = (x - E.x) / E.r;
    const ey = (y - E.y) / E.r;
    if (Math.abs(ex) < 2 && Math.abs(ey) < 2) {
      if (E.ring) {
        const ed = Math.hypot(ex, ey);
        c = mix3(c, mul3(c, 1.35), E.ring * smoothstep(1.55, 1.2, ed) * smoothstep(0.95, 1.1, ed));
      }
      c = eyeOver(c, ex, ey, E);
    }
    // ---- melt into the fins that grow out of the trunk
    if (sd < K.blend) {
      let behind = 0;
      for (const name of medianFins) {
        const f = F[name];
        if (!f) continue;
        const b = f.box;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        behind = Math.max(behind, clamp(0.5 + f.at(x, y) / (K.blend * 0.5)));
      }
      if (behind > 0) alpha *= lerp(1, smoothstep(0, K.blend, sd), behind);
    }
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = alpha;
    return true;
  };

  const layers = [];
  if (F.pectFar) layers.push(sharkFin(F.pectFar, pitch, P.fin.pectFar));
  if (F.pelvicFar) layers.push(sharkFin(F.pelvicFar, pitch, P.fin.pelvicFar));
  for (const name of medianFins) if (F[name]) layers.push(sharkFin(F[name], pitch, P.fin[name]));
  layers.push({ box: body.box, fn: bodyFn });
  if (F.pelvic) layers.push(sharkFin(F.pelvic, pitch, P.fin.pelvic));

  const ext = unionBox([body.box, ...Object.entries(F).filter(([k]) => k !== 'pect').map(([, f]) => f.box)], 2 * px);
  const view = makeView(S, ext);
  const img = paint(view, ss, layers);
  const parts = sliceRig(view, img, K.rig);

  // ---- near pectoral fin (own part so the device can flap it)
  const pv = makeView(S, unionBox([F.pect.box], 2 * px));
  const pimg = paint(pv, ss, [sharkFin(F.pect, pitch, P.fin.pect)]);
  const piv = [Math.round(pv.ox + K.pectPivot[0] * S), Math.round(pv.oy - K.pectPivot[1] * S)];
  const pp = partFrom(pimg, piv, [pv.ox, pv.oy], { kind: 'flap', amp: K.pectFlap[0], rate: K.pectFlap[1], phase: K.pectFlap[2] });
  parts.push(pp);
  return { lenPx: S, anchor: 'center', parts };
}

// ---- great white -------------------------------------------------------------------------------
const GREAT_WHITE = {
  lenPx: 640,
  ss: 2,
  body: {
    pts: [
      // back, snout to tail
      [0.5, 0.004], [0.496, 0.014], [0.486, 0.024], [0.468, 0.036], [0.44, 0.05], [0.4, 0.064], [0.34, 0.08], [0.27, 0.092], [0.19, 0.099],
      [0.12, 0.1], [0.04, 0.094], [-0.04, 0.081], [-0.12, 0.063], [-0.19, 0.044], [-0.24, 0.032], [-0.28, 0.025], [-0.305, 0.02],
      [-0.325, 0.002],
      // belly, tail to snout
      [-0.305, -0.018], [-0.27, -0.023], [-0.22, -0.034], [-0.16, -0.055], [-0.09, -0.077], [-0.01, -0.094], [0.07, -0.103], [0.15, -0.104],
      [0.23, -0.1], [0.3, -0.09], [0.36, -0.075], [0.4, -0.062], [0.43, -0.05], [0.444, -0.043], [0.45, -0.036], [0.447, -0.03, 1],
      [0.458, -0.024], [0.475, -0.017], [0.49, -0.008], [0.498, -0.002],
    ],
    ratio: [[0.5, 0.95], [0.4, 0.9], [0.2, 0.88], [0, 0.86], [-0.2, 0.95], [-0.3, 1.2]],
    mid: [[0.5, 0.42], [0.4, 0.4], [0.2, 0.46], [0, 0.5], [-0.33, 0.5]],
    pT: 2.0,
    pB: 2.35,
  },
  fins: {
    dorsal1: [[0.152, 0.086], [0.118, 0.132], [0.085, 0.168], [0.06, 0.19], [0.042, 0.201, 1], [0.037, 0.178], [0.038, 0.15], [0.033, 0.126], [0.012, 0.105, 1], [0.03, 0.092], [0.05, 0.08]],
    dorsal2: [[-0.166, 0.044], [-0.182, 0.062], [-0.192, 0.07, 1], [-0.196, 0.058], [-0.208, 0.05, 1], [-0.2, 0.036]],
    anal: [[-0.2, -0.038], [-0.216, -0.056], [-0.226, -0.064, 1], [-0.23, -0.052], [-0.242, -0.044, 1], [-0.234, -0.03]],
    pelvic: [[-0.03, -0.082], [-0.055, -0.108], [-0.078, -0.122, 1], [-0.092, -0.108], [-0.108, -0.098, 1], [-0.1, -0.076]],
    caudal: [
      [-0.258, 0.03], [-0.3, 0.044], [-0.345, 0.074], [-0.4, 0.114], [-0.455, 0.148], [-0.499, 0.166, 1],
      [-0.491, 0.14], [-0.478, 0.12], [-0.468, 0.11, 1], [-0.47, 0.1], [-0.442, 0.072], [-0.41, 0.036], [-0.392, 0.002],
      [-0.396, -0.034], [-0.414, -0.07], [-0.438, -0.1], [-0.462, -0.124, 1], [-0.428, -0.104], [-0.378, -0.068], [-0.322, -0.038], [-0.258, -0.026],
    ],
    pectFar: [[0.3, -0.07], [0.285, -0.11], [0.262, -0.15], [0.238, -0.182], [0.222, -0.198, 1], [0.226, -0.17], [0.236, -0.13], [0.246, -0.1], [0.24, -0.075]],
    pect: [
      [0.272, -0.046], [0.244, -0.094], [0.2, -0.158], [0.146, -0.212], [0.106, -0.238, 1], [0.118, -0.202], [0.138, -0.158], [0.152, -0.12],
      [0.142, -0.098, 1], [0.168, -0.088], [0.194, -0.056],
    ],
  },
  pectPivot: [0.236, -0.062],
  pectFlap: [3.5, 0.45, 0.6],
  eye: { x: 0.436, y: 0.014, r: 0.0092, iris: [0.012, 0.018, 0.032], pr: 0.8, socket: 0.3, ring: 0.5, seed: 3 },
  gills: { n: 5, x: 0.332, dx: -0.0165, slant: -0.007, bow: 0.004, w: 0.0036, top: [0.036, -0.001], bot: [-0.062, 0.004], x0: 0.22, x1: 0.36, y0: -0.07, y1: 0.045 },
  mouth: {
    xf: 0.447, yf: -0.03, xc: 0.39, yc: -0.038, bow: 0.0035, gap: 0.0105, tooth: 0.0078,
    inner: [0.035, 0.016, 0.02], teeth: [0.95, 0.93, 0.86],
    furrows: [[0.39, -0.038, 0.376, -0.033, 0.9], [0.39, -0.038, 0.382, -0.052, 0.6]],
  },
  blend: 0.011,
  gloss: 0.28,
  sheen: 0.2,
  rig: { xTail: -0.285, xStart: 0.1, strips: 6, ampPed: 0.0135, lagPed: 4.2, pow: 1.5, rot: 7, squash: 0.28 },
  paint: ({ sp, seed, body, F, px }) => {
    const [A, B, C] = sp.palette.map(hex);
    const top = mul3(A, 0.58);
    const flank = mul3(A, 0.9);
    const white = mul3(B, 0.97);
    // counter-shading line: sharp and ragged, dipping to the pectoral base, rising to the keel
    const line = curve1([[0.5, 0.001], [0.47, -0.004], [0.435, -0.007], [0.4, -0.012], [0.36, -0.016], [0.32, -0.02], [0.285, -0.032], [0.255, -0.05], [0.22, -0.056], [0.18, -0.048], [0.12, -0.041], [0.04, -0.04], [-0.03, -0.043], [-0.08, -0.05], [-0.12, -0.038], [-0.18, -0.022], [-0.24, -0.011], [-0.33, -0.004]]);
    const ragged = (x) => {
      const k = smoothstep(0.46, 0.34, x);
      return line(x) + k * (0.02 * (fbm(x * 16 + 3.1, 1.7, 3, seed) - 0.5) + 0.009 * (vnoise(x * 62, 9.3, seed + 3) - 0.5) + 0.004 * (vnoise(x * 150, 4.1, seed + 5) - 0.5));
    };
    const grey = (x, y, s) => {
      let g = mix3(flank, top, smoothstep(-0.1, 0.95, s));
      g = mul3(g, 0.94 + 0.12 * organic(x * 26, y * 26, seed + 11, 3));
      return g;
    };
    const skinCol = (x, y, s) => {
      const k = smoothstep(-0.9 * px, 0.9 * px, y - ragged(x));
      let c = mix3(white, grey(x, y, s), k);
      // dusky smudge where the pectoral fin joins the flank
      c = mul3(c, 1 - 0.45 * gauss(Math.hypot((x - 0.196) / 0.022, (y + 0.07) / 0.013), 1));
      return c;
    };
    const finGrey = (x, y, sd, k = 0.82) => mul3(grey(x, y, 0.7), k * (0.82 + 0.18 * smoothstep(0, 0.02, sd)));
    return {
      skin: skinCol,
      detail: (alb, x, y, s, n) => {
        // nostril
        const nd = Math.hypot((x - 0.4695 + (y + 0.005) * 0.5) / 0.0052, (y + 0.005) / 0.0021);
        alb = mul3(alb, 1 - 0.8 * smoothstep(1.2, 0.6, nd));
        // ampullae of Lorenzini: pin-prick pores scattered over the snout
        if (x > 0.42) {
          const w = worley(x * 210, y * 210, seed + 21);
          alb = mul3(alb, 1 - 0.5 * smoothstep(0.2, 0.08, w.f1) * (w.id > 0.45 ? 1 : 0) * smoothstep(0.425, 0.455, x));
        }
        // caudal keel: a lateral ridge along the peduncle
        const kx = smoothstep(-0.2, -0.24, x);
        if (kx > 0) {
          const q = (y - 0.003) / 0.0052;
          nudge(n, 0, 0.9 * kx * q * Math.exp(-q * q));
          alb = mul3(alb, 1 + 0.1 * kx * Math.exp(-q * q));
        }
        return alb;
      },
      fin: {
        dorsal1: { alb: (x, y, sd) => mul3(finGrey(x, y, sd, 0.8), 1 - 0.3 * smoothstep(0.15, 0.2, y)), streak: [520, 230, 0.03], tilt: [-0.05, 0.05] },
        dorsal2: { alb: (x, y, sd) => finGrey(x, y, sd, 0.74), rimW: 0.004, swellW: 0.012 },
        anal: { alb: (x, y, sd) => mix3(white, finGrey(x, y, sd, 0.8), 0.25), rimW: 0.004, swellW: 0.012, ao: () => 0.8 },
        pelvic: { alb: (x, y, sd) => mix3(white, finGrey(x, y, sd, 0.8), 0.12 + 0.4 * smoothstep(-0.1, -0.08, y)), rimW: 0.005, swellW: 0.015, ao: () => 0.82, root: (x, y) => smoothstep(-0.082, -0.094, y) },
        caudal: {
          alb: (x, y, sd) => {
            let c = finGrey(x, y, sd, 0.78);
            c = mul3(c, 1 - 0.28 * smoothstep(0.02, 0.0, sd) * smoothstep(-0.3, -0.36, x));
            return mix3(c, mul3(c, 1.25), smoothstep(0.0, -0.08, y) * 0.5);
          },
          streak: [0, 420, 0.03], swell: 0.5, swellW: 0.04, tilt: [-0.04, 0],
        },
        pectFar: { alb: (x, y) => mix3(white, C, 0.75 * smoothstep(-0.15, -0.19, y)), dim: 0.75, ao: () => 0.7 },
        pect: {
          alb: (x, y, sd) => {
            let c = finGrey(x, y, sd, 0.84);
            c = mix3(c, mul3(c, 0.62), smoothstep(-0.17, -0.235, y));
            return mix3(c, mul3(white, 0.8), 0.22 * smoothstep(0.012, 0.0, sd) * smoothstep(0.2, 0.12, x));
          },
          streak: [330, 330, 0.03], tilt: [-0.08, 0.1], swell: 0.45, swellW: 0.035,
          root: (x, y) => smoothstep(-0.052, -0.08, y - (x - 0.24) * 0.32),
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------- module contract
const BUILDERS = {
  greatWhite: (id, opts) => buildShark(id, opts, GREAT_WHITE),
};

export const IDS = ['greatWhite', 'blacktipShark', 'whitemouthMoray', 'blackfinBarracuda', 'humpheadWrasse', 'crocNeedlefish'];

/**
 * Build the rigged sprite for one species.
 * @param id   one of IDS
 * @param opts { px?: authored body length in pixels (default per species), ss?: supersampling }
 * @returns SpriteDef { lenPx, anchor: 'center', parts: [{ img, pivot, at, anim }] } (see lib/sprite.mjs)
 */
export function build(id, opts = {}) {
  const fn = BUILDERS[id];
  if (!fn) throw new Error(`Unknown predator ${id}`);
  return fn(id, opts);
}
