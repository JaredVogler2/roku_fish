/**
 * Dedicated sprite renderer for the six big / slender hunters that the generic fish generator
 * (fish.mjs) cannot do justice: great white, blacktip reef shark, whitemouth moray, blackfin
 * barracuda, humphead wrasse and crocodile needlefish.
 *
 * Same look as fish.mjs and critters.mjs (shared light rig in lib/light.mjs, linear light, filmic
 * tone curve, core.shade() supersampling), but every animal has its own anatomy:
 *  - the trunk is a smooth closed outline (centripetal Catmull-Rom through hand-placed points)
 *    lofted into a rounded height field -> per-pixel normal -> lit();
 *  - fins are smooth polygons with a signed distance field: shark fins and the moray's fin fold are
 *    shaded as thick foils (lit(), melted into the trunk), ray fins as translucent tissue (membrane());
 *  - gill slits, jaws, teeth, eyes, keels and scale rows are painted into the albedo and the normal.
 *
 * Authoring conventions
 *  - Model units: 1 = body length (snout tip to tail tip), x right, y UP, origin = body centre on
 *    the swimming axis, animals face +x (snout at x = +0.5, tail tip at x = -0.5).
 *  - Edges are anti-aliased analytically from the distance fields, so ss = 2 is already clean;
 *    species with hair-thin features (teeth, beak, small spots) default to ss = 3.
 *  - Rig (see lib/sprite.mjs and DrawCreature in channel/source/render.brs), back to front:
 *    tail (rotates, narrows, follows the body wave), wave strips from the tail joint forward,
 *    static front body, near-side pectoral fin (flap). Parts are cropped to their content plus a
 *    3 px transparent margin, pivots are whole pixels on a 4 px grid (they stay exact on the
 *    device's half and quarter size copies), and the strips are cut so that the neutral pose
 *    composites back to the un-sliced render (to rounding), also through translucent fins.
 *  - Everything is deterministic: noise seeds derive from the species id.
 */
import fs from 'node:fs';
import {
  Img, shade, bounds, crop, hex, mix3, mul3, add3, clamp, lerp, smoothstep, fract, vnoise, fbm, worley, saturate, tone, hashStr,
} from './lib/core.mjs';
import { lit, membrane } from './lib/light.mjs';

const PI = Math.PI;
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
/** Raise a rounded bump under a normal: centre, radii, height (all model units). */
function bump(n, x, y, cx, cy, a, b, h) {
  const dx = (x - cx) / a;
  const dy = (y - cy) / b;
  const v = h * Math.exp(-(dx * dx + dy * dy));
  if (v < 1e-6 && v > -1e-6) return 0;
  nudge(n, (2 * dx * v) / a, (2 * dy * v) / b);
  return v / h;
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
    t[i] = b[0] > a[0] ? a[1] + (b[1] - a[1]) * clamp((x - a[0]) / (b[0] - a[0])) : a[1];
  }
  return (x) => {
    const f = clamp((x - xa) / (xb - xa)) * N;
    const i = Math.min(N - 1, Math.floor(f));
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  };
}

/** An open smooth stroke (creases, eye lines): dist(x, y) -> [distance, t along 0..1]. */
function makeStroke(pts, per = 8) {
  const pl = catmull(pts, per, false);
  const bb = polyBox(pl);
  const m = pl.length - 1;
  return {
    box: bb,
    dist: (x, y) => {
      let best = 1e9;
      let bt = 0;
      for (let i = 0; i < m; i++) {
        const a = pl[i];
        const b = pl[i + 1];
        const r = segDist(x, y, a[0], a[1], b[0], b[1]);
        if (r[0] < best) {
          best = r[0];
          bt = (i + r[1]) / m;
        }
      }
      return [best, bt];
    },
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
 * bilinearly. It gives every shape analytic edge anti-aliasing, an inward gradient for rounded
 * rims and cheap "how far from the outline" queries.
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

// ---------------------------------------------------------------------------- lofted trunk
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
    const i1 = Math.min(N + 1, Math.floor((bx - xa) * inv + 1e-9));
    for (let k = i0; k <= i1; k++) {
      const x = xa + k / inv;
      const f = bx > ax ? clamp((x - ax) / (bx - ax)) : 0.5;
      const y = ay + (by - ay) * f;
      if (y > T[k]) T[k] = y;
      if (y < Bt[k]) Bt[k] = y;
    }
  }
  let last = 0;
  for (let k = 0; k <= N + 1; k++) {
    if (T[k] < Bt[k]) {
      T[k] = last;
      Bt[k] = last;
    } else last = (T[k] + Bt[k]) / 2;
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
  const ct = {};
  const e = (o.e ?? 1.0) * px;
  const geom = (x, y, G) => {
    col(x, c0);
    col(x - e, c1);
    col(x + e, c2);
    if (!c0.ok) {
      G.top = G.bot = G.mid = G.w = G.z = G.s = 0;
      G.n[0] = G.n[1] = 0;
      G.n[2] = 1;
      return G;
    }
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
  const top = (x) => (col(x, ct).ok ? ct.top : 0);
  const bot = (x) => (col(x, ct).ok ? ct.bot : 0);
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
 * Glossy eye painted over what is already in `c` (linear, tone mapped). ex, ey: offset from the
 * eye centre in eye radii. o: iris, pr (pupil radius 0..1), slit (vertical slit pupil), socket.
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
    const p = o.slit ? smoothstep(pr * 0.5 + 0.08, pr * 0.5 - 0.06, Math.abs(ex)) * smoothstep(0.92, 0.74, Math.abs(ey)) : smoothstep(pr + 0.05, pr - 0.04, ed);
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

/**
 * Thick, opaque fin (sharks, the moray's fin fold): a foil with a rounded rim and a gentle dome
 * across the chord, lit by the shared rig.
 * o.alb(x, y, sd) -> albedo; o.dim darkens far-side fins; o.root(x, y) -> 0..1 fades the base in.
 */
function foilFin(sdf, pitch, o) {
  const e = pitch * 1.5;
  const n = [0, 0, 1];
  const b = sdf.box;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const hw = (b[2] - b[0]) / 2;
  const hh = (b[3] - b[1]) / 2;
  const dome = o.dome ?? [0.3, 0.12];
  const tilt = o.tilt ?? [0, 0];
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
      const k = (o.rim ?? 1.0) * Math.exp(-d / (o.rimW ?? 0.0045));
      n[0] = -gx * k + tilt[0] + (dome[0] * (x - cx)) / hw;
      n[1] = -gy * k + tilt[1] + (dome[1] * (y - cy)) / hh;
      n[2] = 1;
      const l = Math.hypot(n[0], n[1], 1);
      n[0] /= l;
      n[1] /= l;
      n[2] /= l;
      let alb = o.alb(x, y, sd);
      if (o.streak) alb = mul3(alb, 1 + o.streak[2] * Math.cos(x * o.streak[0] + y * o.streak[1]));
      let c = lit(alb, n, o.gloss ?? 0.16, o.sheen ?? 0.14, o.ao ? o.ao(x, y) : 1);
      c = mul3(c, 1 - 0.14 * smoothstep(0.0035, 0.0, sd));
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

/**
 * Translucent ray fin in the house style (lib/light membrane): ribs fan out from o.fan, the tissue
 * is brighter toward the thin edge and has a pale rim; the base is shaded where it meets the body.
 * o.fan [x, y] ray origin, o.r0 / o.len distance from the origin to the fin base / base to tip,
 * o.rays ribs per radian, o.col(x, y, r, ang) -> colour, o.alpha [base, edge], o.spiny,
 * o.scallop depth of the notches between ray tips, o.rOf(x, y) custom base-to-edge coordinate.
 */
function rayFin(sdf, pitch, o) {
  const fx = o.fan[0];
  const fy = o.fan[1];
  const r0 = o.r0 ?? 0;
  const rays = o.rays ?? 30;
  const aB = o.alpha ? o.alpha[0] : 0.97;
  const aE = o.alpha ? o.alpha[1] : 0.86;
  return {
    box: sdf.box,
    fn: (x, y, out) => {
      let sd = sdf.at(x, y);
      if (sd <= -0.5 * pitch) return false;
      const dx = x - fx;
      const dy = y - fy;
      const ang = Math.atan2(dy, dx);
      const r = o.rOf ? o.rOf(x, y) : clamp((Math.hypot(dx, dy) - r0) / o.len);
      const phase = ang * rays;
      if (o.scallop) {
        sd -= o.scallop * (0.5 - 0.5 * Math.cos(phase)) * smoothstep(0.45, 0.9, r);
        if (sd <= -0.5 * pitch) return false;
      }
      const base = o.col(x, y, r, ang);
      const edge = smoothstep(o.edgeW ?? 0.012, 0.0, sd) * smoothstep(0.1, 0.3, r);
      let c = membrane(base, phase + (o.spiny ? PI : 0), r, edge * (o.edge ?? 1), !!o.spiny);
      c = mul3(c, 0.72 + 0.28 * smoothstep(0.0, 0.3, r));
      if (o.post) c = o.post(c, x, y, r, sd);
      c = tone(c);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = clamp(0.5 + sd / pitch) * lerp(aB, aE, smoothstep(0.05, 0.8, r));
      return true;
    },
  };
}

/** How much of a trunk sample should give way to the foil fins behind it (smooth junction). */
function melt(sd, x, y, fins, blend) {
  if (sd >= blend) return 1;
  let behind = 0;
  for (let i = 0; i < fins.length; i++) {
    const f = fins[i];
    const b = f.box;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    const v = clamp(0.5 + f.at(x, y) / (blend * 0.5));
    if (v > behind) behind = v;
  }
  return behind > 0 ? lerp(1, smoothstep(0, blend, sd), behind) : 1;
}

/**
 * Overlapping "roof tile" scales on a staggered lattice (free edges point to the tail, -x).
 * Fills o with the covering scale: lx, ly (local position, scale lengths), e (distance in from its
 * free edge), sh (0..1 contact shadow from the scale in front), id (per-scale random).
 */
function tileScale(x, y, sl, rh, R, o) {
  const j0 = Math.round(y / rh);
  let bcx = -1e9, bd = 0, bdx = 0, bdy = 0, bi = 0, bj = 0;
  const cand = tileScale.c;
  let nc = 0;
  for (let j = j0 - 1; j <= j0 + 1; j++) {
    const off = j & 1 ? 0.5 : 0;
    const i0 = Math.round(x / sl - off);
    for (let i = i0 - 1; i <= i0 + 2; i++) {
      const cx = (i + off) * sl;
      const dx = (x - cx) / sl;
      const dy = (y - j * rh) / rh;
      const d = Math.hypot(dx, dy * 0.9);
      cand[nc++] = cx;
      cand[nc++] = d;
      if (d < R && cx > bcx) {
        bcx = cx;
        bd = d;
        bdx = dx;
        bdy = dy;
        bi = i;
        bj = j;
      }
    }
  }
  let outside = 1;
  for (let k = 0; k < nc; k += 2) if (cand[k] > bcx + 1e-9 && cand[k + 1] >= R && cand[k + 1] - R < outside) outside = cand[k + 1] - R;
  o.lx = bdx;
  o.ly = bdy;
  o.e = R - bd;
  o.sh = smoothstep(0.16, 0.0, outside);
  o.i = bi;
  o.j = bj;
  return o;
}
tileScale.c = new Float64Array(64);

/** Vermiculated (maze-like) lines: contours of warped noise, about one line per unit; 1 on a line. */
function maze(x, y, seed, width = 0.22) {
  const wx = x + 0.7 * (vnoise(x * 0.6 + 3.1, y * 0.6 + 1.7, seed + 1) - 0.5);
  const wy = y + 0.7 * (vnoise(x * 0.6 - 5.2, y * 0.6 + 8.3, seed + 2) - 0.5);
  const f = (a, b) => fbm(a * 0.45, b * 0.45, 2, seed) * 2.6;
  const v = f(wx, wy);
  const e = 0.05;
  const gx = (f(wx + e, wy) - v) / e;
  const gy = (f(wx, wy + e) - v) / e;
  const d = Math.abs(fract(v + 0.5) - 0.5) / Math.max(0.25, Math.hypot(gx, gy));
  return smoothstep(width, width * 0.45, d);
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
 *   feather width of the cross-fade between neighbouring parts, as a fraction of the body length (0.02)
 * Neighbouring parts share a feathered zone; the part in front fades in over the part behind, whose
 * translucent pixels are thinned by exactly the amount that makes the neutral pose identical to img.
 */
function sliceRig(view, img, R) {
  const { S, ox, oy } = view;
  const X = (x) => Math.round(ox + x * S);
  const ov = Math.max(4, Math.round(S * (R.feather ?? 0.02)));
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
  const snap = (lo, p) => lo - ((4 - ((((p - lo) % 4) + 4) % 4)) % 4);
  const x0 = snap(Math.min(b.x0, pivot[0]) - m, pivot[0]);
  const y0 = snap(Math.min(b.y0, pivot[1]) - m, pivot[1]);
  const x1 = Math.max(b.x1, pivot[0]) + m;
  const y1 = Math.max(b.y1, pivot[1]) + m;
  return {
    img: crop(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1),
    pivot: [pivot[0] - x0, pivot[1] - y0],
    at: [pivot[0] - origin[0], pivot[1] - origin[1]],
    anim,
  };
}

/**
 * Paint and rig one animal.
 * layers: body layer stack (everything except the near pectoral fin); boxes: their extents;
 * pect: { layer, pivot: [x, y], flap: [amp, rate, phase] } or null.
 */
function assemble(S, ss, layers, rig, pect) {
  const px = 1 / S;
  const view = makeView(S, unionBox(layers.map((l) => l.box), 2 * px));
  const img = paint(view, ss, layers);
  const parts = sliceRig(view, img, rig);
  if (pect) {
    const pv = makeView(S, unionBox([pect.layer.box], 2 * px));
    const pimg = paint(pv, ss, [pect.layer]);
    const piv = [Math.round(pv.ox + pect.pivot[0] * S), Math.round(pv.oy - pect.pivot[1] * S)];
    parts.push(partFrom(pimg, piv, [pv.ox, pv.oy], { kind: 'flap', amp: pect.flap[0], rate: pect.flap[1], phase: pect.flap[2] }));
  }
  return { lenPx: S, anchor: 'center', parts };
}

function context(id, opts, K) {
  const sp = BY_ID.get(id);
  const S = opts.px ?? K.lenPx;
  const ss = opts.ss ?? K.ss ?? 2;
  const px = 1 / S;
  const pal = sp.palette.map(hex);
  const body = makeBody(K.body, px);
  const F = {};
  for (const [name, pts] of Object.entries(K.fins)) F[name] = makeSdf(outline(pts, 8), 0.6 * px, K.finBand ?? 0.03);
  return { id, sp, S, ss, px, pitch: px / ss, seed: hashStr(id) & 0xffff, A: pal[0], B: pal[1], C: pal[2], body, F };
}

// ---------------------------------------------------------------------------- sharks
function buildShark(id, opts, K) {
  const ctx = context(id, opts, K);
  const { S, ss, px, pitch, body, F } = ctx;
  const P = K.look(ctx);
  const cuts = (K.cuts ?? []).map((pts) => makeSdf(outline(pts, 6), 0.5 * px, 0.01));
  const median = ['caudal', 'dorsal1', 'dorsal2', 'anal'].filter((k) => F[k]);
  const meltFins = median.map((k) => F[k]);
  const G = { n: [0, 0, 1] };
  const gills = K.gills;
  const M = K.mouth;
  const E = K.eye;
  const bodyFn = (x, y, out) => {
    const sd = body.sdf.at(x, y);
    if (sd <= -0.5 * pitch) return false;
    let alpha = clamp(0.5 + sd / pitch);
    for (let i = 0; i < cuts.length; i++) alpha *= 1 - clamp(0.5 + cuts[i].at(x, y) / pitch);
    // the peduncle runs out into the tail fin
    alpha *= smoothstep(body.xa + 0.002, body.xa + K.tailFade, x);
    if (!(alpha > 0)) return false;
    body.geom(x, y, G);
    const n = G.n;
    const s = G.s;
    let alb = P.skin(x, y, s);
    let ao = 0.8 + 0.2 * smoothstep(-1.0, -0.45, s);
    let over = null;
    // ---- gill slits: a rounded flap edge in front, a dark opening, a soft shadow behind
    if (x > gills.box[0] && x < gills.box[2] && y > gills.box[1] && y < gills.box[3]) {
      for (let i = 0; i < gills.n; i++) {
        const yb = gills.bot[0] + gills.bot[1] * i;
        const yt = gills.top[0] + gills.top[1] * i;
        const t = (y - yb) / (yt - yb);
        if (t < -0.05 || t > 1.05) continue;
        const cx = gills.x + gills.dx * i + gills.slant * (t - 0.5) - gills.bow * Math.sin(PI * clamp(t));
        const q = (cx - x) / gills.w; // + behind the slit
        if (q < -5 || q > 9) continue;
        const k = smoothstep(-0.02, 0.16, t) * smoothstep(1.02, 0.84, t);
        const core = Math.exp(-Math.pow((q - 0.3) / 0.75, 2)) * k;
        const lip = Math.exp(-Math.pow((q + 1.7) / 1.1, 2)) * k;
        const sh = (q > 0.6 ? Math.exp(-(q - 0.6) / 2.6) : 0) * k;
        nudge(n, -0.6 * lip + 0.3 * sh, 0);
        alb = mul3(alb, (1 - gills.dark * core) * (1 - 0.14 * sh));
        ao *= 1 - 0.4 * core;
      }
    }
    // ---- mouth: upper jaw line, dark opening with a hint of teeth, lower jaw
    if (x > M.xc - 0.03 && x < M.xf + 0.004 && y < M.yf + 0.02 && y > M.yc - 0.03) {
      const t = (M.xf - x) / (M.xf - M.xc);
      if (t >= 0 && t <= 1) {
        const yU = lerp(M.yf, M.yc, t) + M.bow * Math.sin(PI * t);
        const gap = M.gap * Math.pow(1 - t, 0.7) * smoothstep(1.0, 0.8, t) + 0.5 * px;
        const yL = yU - gap;
        if (y < yU && y > yL) {
          let mc = mix3(M.inner, mul3(M.inner, 0.3), smoothstep(yL, yU, y));
          const tw = M.tooth;
          const fx = (M.xf - x) / tw + 0.1;
          const th = tw * 0.9 * (1 - 0.5 * t);
          // upper teeth: triangles hanging from the jaw line; lower teeth: slimmer, between them
          const txU = Math.abs(fract(fx) - 0.5) * 2;
          const du = (yU - y) / th;
          if (du < 1 - txU * 1.02) mc = mul3(M.teeth, 0.66 + 0.34 * du);
          const txL = Math.abs(fract(fx + 0.5) - 0.5) * 2;
          const dl = (y - yL) / (th * 0.7);
          if (dl < 1 - txL * 1.5) mc = mul3(M.teeth, 0.62 + 0.3 * dl);
          over = mc;
        } else {
          const dU = (y - yU) / px;
          if (dU >= 0 && dU < 2.4) alb = mul3(alb, 1 - 0.6 * smoothstep(2.4, 0.2, dU) * smoothstep(1.0, 0.9, t));
          const dL = (yL - y) / px;
          if (dL >= 0 && dL < 3.5) {
            alb = mul3(alb, 1 - 0.34 * smoothstep(3.5, 0, dL));
            nudge(n, 0, 0.35 * smoothstep(3.5, 0, dL));
          }
        }
      }
      // labial furrow and jaw hinge crease behind the mouth corner
      for (const f of M.furrows) {
        const r = segDist(x, y, f[0], f[1], f[2], f[3]);
        alb = mul3(alb, 1 - 0.5 * smoothstep(1.3 * px, 0.2 * px, r[0]) * (1 - r[1] * 0.75) * f[4]);
      }
    }
    if (P.detail) alb = P.detail(alb, x, y, s, n, G);
    let c = over ? tone(mul3(over, 0.9)) : skin(alb, n, K.gloss, K.sheen, ao, 0.2);
    // ---- eye
    const ex = (x - E.x) / E.r;
    const ey = (y - E.y) / E.r;
    if (Math.abs(ex) < 2 && Math.abs(ey) < 2) {
      const ed = Math.hypot(ex, ey);
      if (E.ring) c = mix3(c, mul3(c, 1.4), E.ring * smoothstep(1.6, 1.25, ed) * smoothstep(0.95, 1.12, ed));
      c = eyeOver(c, ex, ey, E);
    }
    alpha *= melt(sd, x, y, meltFins, K.blend);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = alpha;
    return true;
  };
  const layers = [];
  for (const k of ['pectFar', 'pelvicFar', ...median]) if (F[k]) layers.push(foilFin(F[k], pitch, P.fin[k]));
  layers.push({ box: body.box, fn: bodyFn });
  if (F.pelvic) layers.push(foilFin(F.pelvic, pitch, P.fin.pelvic));
  return assemble(S, ss, layers, K.rig, { layer: foilFin(F.pect, pitch, P.fin.pect), pivot: K.pectPivot, flap: K.pectFlap });
}

// ---- great white -------------------------------------------------------------------------------
const GREAT_WHITE = {
  lenPx: 640,
  ss: 2,
  body: {
    pts: [
      // back, snout to tail
      [0.5, 0.003], [0.496, 0.012], [0.484, 0.023], [0.466, 0.035], [0.44, 0.048], [0.4, 0.063], [0.34, 0.08], [0.27, 0.092], [0.19, 0.099],
      [0.12, 0.1], [0.04, 0.094], [-0.04, 0.081], [-0.12, 0.063], [-0.19, 0.044], [-0.24, 0.032], [-0.275, 0.025], [-0.3, 0.021],
      [-0.335, 0.004],
      // belly, tail to snout
      [-0.3, -0.018], [-0.27, -0.023], [-0.22, -0.034], [-0.16, -0.055], [-0.09, -0.077], [-0.01, -0.094], [0.07, -0.103], [0.15, -0.104],
      [0.23, -0.1], [0.3, -0.09], [0.36, -0.076], [0.4, -0.064], [0.43, -0.052], [0.446, -0.042], [0.458, -0.032], [0.472, -0.022],
      [0.486, -0.012], [0.496, -0.004],
    ],
    ratio: [[0.5, 0.95], [0.4, 0.9], [0.2, 0.88], [0, 0.86], [-0.2, 0.95], [-0.3, 1.2]],
    mid: [[0.5, 0.42], [0.4, 0.4], [0.2, 0.46], [0, 0.5], [-0.34, 0.5]],
    pT: 2.0,
    pB: 2.35,
  },
  // the lower jaw stops short of the snout: a small bite out of the silhouette in front of the chin
  cuts: [[[0.4492, -0.0318, 1], [0.449, -0.039], [0.452, -0.046], [0.46, -0.052, 1], [0.475, -0.04, 1], [0.462, -0.0305, 1]]],
  fins: {
    dorsal1: [[0.152, 0.086], [0.118, 0.132], [0.085, 0.168], [0.06, 0.19], [0.044, 0.2], [0.037, 0.196], [0.036, 0.176], [0.038, 0.15], [0.033, 0.126], [0.012, 0.105, 1], [0.03, 0.092], [0.05, 0.08]],
    dorsal2: [[-0.166, 0.044], [-0.182, 0.06], [-0.193, 0.067, 1], [-0.197, 0.057], [-0.209, 0.05, 1], [-0.2, 0.036]],
    anal: [[-0.2, -0.036], [-0.215, -0.052], [-0.226, -0.059, 1], [-0.23, -0.049], [-0.242, -0.043, 1], [-0.234, -0.028]],
    pelvic: [[-0.026, -0.08], [-0.05, -0.1], [-0.076, -0.112, 1], [-0.09, -0.1], [-0.108, -0.093, 1], [-0.1, -0.07]],
    caudal: [
      [-0.25, 0.03], [-0.3, 0.044], [-0.345, 0.074], [-0.4, 0.114], [-0.455, 0.148], [-0.499, 0.166, 1],
      [-0.491, 0.14], [-0.478, 0.12], [-0.468, 0.11, 1], [-0.47, 0.1], [-0.442, 0.072], [-0.41, 0.036], [-0.392, 0.002],
      [-0.398, -0.036], [-0.418, -0.074], [-0.444, -0.106], [-0.47, -0.132, 1], [-0.432, -0.108], [-0.378, -0.07], [-0.322, -0.04], [-0.25, -0.026],
    ],
    pectFar: [[0.292, -0.07], [0.276, -0.11], [0.25, -0.15], [0.222, -0.182], [0.202, -0.198, 1], [0.21, -0.17], [0.224, -0.13], [0.236, -0.1], [0.232, -0.075]],
    pect: [
      [0.272, -0.046], [0.244, -0.094], [0.2, -0.158], [0.146, -0.212], [0.106, -0.238, 1], [0.118, -0.202], [0.138, -0.158], [0.152, -0.12],
      [0.142, -0.098, 1], [0.168, -0.088], [0.194, -0.056],
    ],
  },
  pectPivot: [0.236, -0.062],
  pectFlap: [3.5, 0.45, 0.6],
  eye: { x: 0.436, y: 0.013, r: 0.0092, iris: [0.012, 0.018, 0.032], pr: 0.8, socket: 0.3, ring: 0.5, seed: 3 },
  gills: { n: 5, x: 0.332, dx: -0.0165, slant: -0.008, bow: 0.0045, w: 0.0025, dark: 0.8, top: [0.036, -0.001], bot: [-0.062, 0.004], box: [0.22, -0.07, 0.36, 0.045] },
  mouth: {
    xf: 0.458, yf: -0.0305, xc: 0.386, yc: -0.041, bow: 0.0042, gap: 0.0115, tooth: 0.0074,
    inner: [0.03, 0.014, 0.018], teeth: [0.95, 0.93, 0.86],
    furrows: [[0.386, -0.041, 0.372, -0.036, 0.9], [0.386, -0.041, 0.378, -0.055, 0.55]],
  },
  blend: 0.011,
  tailFade: 0.05,
  gloss: 0.28,
  sheen: 0.2,
  rig: { xTail: -0.285, xStart: 0.1, strips: 6, ampPed: 0.0135, lagPed: 4.2, pow: 1.5, rot: 7, squash: 0.28 },
  look: ({ A, B, C, seed, px }) => {
    const top = mul3(A, 0.58);
    const flank = mul3(A, 0.9);
    const white = mul3(B, 0.97);
    // counter-shading line: sharp and ragged, dipping to the pectoral base, running out under the keel
    const line = curve1([[0.5, 0.0], [0.47, -0.004], [0.435, -0.007], [0.4, -0.012], [0.36, -0.016], [0.32, -0.02], [0.285, -0.032], [0.255, -0.05], [0.22, -0.056], [0.18, -0.05], [0.12, -0.044], [0.04, -0.043], [-0.03, -0.045], [-0.08, -0.05], [-0.12, -0.04], [-0.18, -0.026], [-0.23, -0.02], [-0.27, -0.022], [-0.3, -0.03], [-0.34, -0.04]]);
    const ragged = (x) => {
      const k = smoothstep(0.46, 0.34, x) * smoothstep(-0.3, -0.22, x);
      return line(x) + k * (0.022 * (fbm(x * 13 + 3.1, 1.7, 2, seed) - 0.5) + 0.008 * (vnoise(x * 48, 9.3, seed + 3) - 0.5) + 0.0025 * (vnoise(x * 120, 4.1, seed + 5) - 0.5));
    };
    const grey = (x, y, s) => mul3(mix3(flank, top, smoothstep(-0.1, 0.95, s)), 0.94 + 0.12 * organic(x * 26, y * 26, seed + 11, 3));
    const skinCol = (x, y, s) => {
      let c = mix3(white, grey(x, y, s), smoothstep(-0.9 * px, 0.9 * px, y - ragged(x)));
      // dusky smudge where the pectoral fin joins the flank
      c = mul3(c, 1 - 0.4 * gauss(Math.hypot((x - 0.196) / 0.022, (y + 0.07) / 0.013), 1));
      return c;
    };
    const finGrey = (x, y, sd, k = 0.82) => mul3(grey(x, y, 0.7), k * (0.84 + 0.16 * smoothstep(0, 0.02, sd)));
    return {
      skin: skinCol,
      detail: (alb, x, y, s, n) => {
        // nostril
        const nd = Math.hypot((x - 0.4712 + (y + 0.0045) * 0.5) / 0.005, (y + 0.0045) / 0.002);
        alb = mul3(alb, 1 - 0.8 * smoothstep(1.2, 0.6, nd));
        // ampullae of Lorenzini: pin-prick pores scattered over the snout
        if (x > 0.42) {
          const w = worley(x * 190, y * 190, seed + 21);
          alb = mul3(alb, 1 - 0.4 * smoothstep(0.2, 0.08, w.f1) * (w.id > 0.5 ? 1 : 0) * smoothstep(0.43, 0.46, x));
        }
        // caudal keel: a lateral ridge along the peduncle
        const kx = smoothstep(-0.2, -0.25, x);
        if (kx > 0) {
          const q = (y - 0.003) / 0.0055;
          nudge(n, 0, 0.3 * kx * q * Math.exp(-q * q));
        }
        return alb;
      },
      fin: {
        dorsal1: { alb: (x, y, sd) => mul3(finGrey(x, y, sd, 0.8), 1 - 0.28 * smoothstep(0.15, 0.2, y)), streak: [520, 230, 0.03], dome: [0.34, 0.1] },
        dorsal2: { alb: (x, y, sd) => finGrey(x, y, sd, 0.74), rimW: 0.003, dome: [0.2, 0.1] },
        anal: { alb: (x, y, sd) => mix3(white, finGrey(x, y, sd, 0.8), 0.3), rimW: 0.003, ao: () => 0.72, dome: [0.2, 0.1] },
        pelvic: { alb: (x, y, sd) => mix3(white, finGrey(x, y, sd, 0.8), 0.15 + 0.3 * smoothstep(-0.1, -0.08, y)), rimW: 0.004, ao: () => 0.74, root: (x, y) => smoothstep(-0.078, -0.092, y), dome: [0.2, 0.1] },
        caudal: {
          alb: (x, y, sd) => {
            let c = finGrey(x, y, sd, 0.78);
            c = mul3(c, 1 - 0.3 * smoothstep(0.02, 0.0, sd) * smoothstep(-0.3, -0.36, x));
            // the white of the belly runs out along the root of the lower lobe
            const k = smoothstep(-0.31, -0.25, x) * smoothstep(-0.9 * px, 0.9 * px, ragged(x) - y);
            return mix3(c, white, k);
          },
          streak: [0, 420, 0.03], dome: [0.25, 0.3],
        },
        pectFar: { alb: (x, y) => mix3(mul3(white, 0.8), C, 0.8 * smoothstep(-0.14, -0.19, y)), dim: 0.85, ao: () => 0.6, dome: [0.2, 0.1] },
        pect: {
          alb: (x, y, sd) => {
            let c = finGrey(x, y, sd, 0.84);
            c = mix3(c, mul3(c, 0.62), smoothstep(-0.17, -0.235, y));
            return mix3(c, mul3(white, 0.8), 0.22 * smoothstep(0.012, 0.0, sd) * smoothstep(0.2, 0.12, x));
          },
          streak: [330, 330, 0.03], tilt: [-0.06, 0.08], dome: [0.3, 0.16],
          root: (x, y) => smoothstep(-0.052, -0.08, y - (x - 0.24) * 0.32),
        },
      },
    };
  },
};

// ---- blacktip reef shark -----------------------------------------------------------------------
const BLACKTIP = {
  lenPx: 440,
  ss: 2,
  body: {
    pts: [
      [0.5, -0.002], [0.495, 0.007], [0.482, 0.016], [0.46, 0.026], [0.43, 0.036], [0.39, 0.047], [0.33, 0.059], [0.26, 0.068], [0.19, 0.073],
      [0.11, 0.073], [0.03, 0.068], [-0.05, 0.058], [-0.12, 0.046], [-0.18, 0.034], [-0.22, 0.027], [-0.245, 0.023], [-0.27, 0.019],
      [-0.3, 0.004],
      [-0.27, -0.015], [-0.245, -0.019], [-0.2, -0.027], [-0.14, -0.042], [-0.07, -0.057], [0.01, -0.068], [0.09, -0.073], [0.17, -0.073],
      [0.25, -0.068], [0.31, -0.06], [0.36, -0.05], [0.4, -0.041], [0.43, -0.033], [0.45, -0.027], [0.465, -0.021], [0.48, -0.015],
      [0.492, -0.009], [0.498, -0.006],
    ],
    ratio: [[0.5, 1.05], [0.4, 0.95], [0.2, 0.9], [0, 0.86], [-0.2, 0.9], [-0.3, 1.0]],
    mid: [[0.5, 0.36], [0.4, 0.4], [0.2, 0.46], [0, 0.5], [-0.3, 0.5]],
    pT: 2.0,
    pB: 2.3,
  },
  cuts: [[[0.4555, -0.0235, 1], [0.455, -0.029], [0.458, -0.035], [0.465, -0.04, 1], [0.478, -0.03, 1], [0.466, -0.0225, 1]]],
  fins: {
    dorsal1: [[0.2, 0.06], [0.166, 0.11], [0.132, 0.148], [0.106, 0.17], [0.09, 0.179], [0.085, 0.172], [0.087, 0.15], [0.089, 0.128], [0.083, 0.104], [0.06, 0.081, 1], [0.08, 0.068], [0.1, 0.055]],
    dorsal2: [[-0.113, 0.04], [-0.13, 0.062], [-0.145, 0.075, 1], [-0.151, 0.06], [-0.176, 0.047, 1], [-0.162, 0.028]],
    anal: [[-0.123, -0.038], [-0.14, -0.06], [-0.155, -0.072, 1], [-0.161, -0.057], [-0.184, -0.045, 1], [-0.17, -0.026]],
    pelvic: [[0.008, -0.062], [-0.018, -0.086], [-0.044, -0.1, 1], [-0.054, -0.086], [-0.07, -0.076, 1], [-0.06, -0.054]],
    caudal: [
      [-0.228, 0.026], [-0.27, 0.036], [-0.32, 0.066], [-0.38, 0.108], [-0.44, 0.148], [-0.5, 0.184, 1],
      [-0.489, 0.156], [-0.47, 0.135], [-0.457, 0.124, 1], [-0.453, 0.11], [-0.42, 0.078], [-0.385, 0.045], [-0.352, 0.012],
      [-0.336, -0.016], [-0.34, -0.048], [-0.352, -0.082], [-0.366, -0.11, 1], [-0.338, -0.086], [-0.3, -0.05], [-0.265, -0.03], [-0.228, -0.021],
    ],
    pectFar: [[0.318, -0.052], [0.3, -0.09], [0.272, -0.13], [0.244, -0.16], [0.224, -0.174, 1], [0.234, -0.146], [0.25, -0.11], [0.262, -0.08], [0.262, -0.058]],
    pect: [
      [0.298, -0.036], [0.272, -0.08], [0.235, -0.13], [0.195, -0.172], [0.168, -0.192, 1], [0.18, -0.16], [0.198, -0.12], [0.212, -0.09],
      [0.205, -0.072, 1], [0.228, -0.064], [0.246, -0.042],
    ],
  },
  pectPivot: [0.262, -0.05],
  pectFlap: [3.5, 0.5, 0.6],
  eye: { x: 0.436, y: 0.007, r: 0.0108, iris: [0.5, 0.47, 0.33], pr: 0.5, slit: true, socket: 0.34, ring: 0.3, seed: 5 },
  gills: { n: 5, x: 0.326, dx: -0.0128, slant: -0.005, bow: 0.003, w: 0.0026, dark: 0.74, top: [0.022, -0.0006], bot: [-0.022, 0.002], box: [0.25, -0.03, 0.345, 0.03] },
  mouth: {
    xf: 0.466, yf: -0.0225, xc: 0.4, yc: -0.03, bow: 0.004, gap: 0.0062, tooth: 0.0062,
    inner: [0.03, 0.014, 0.018], teeth: [0.95, 0.93, 0.86],
    furrows: [[0.4, -0.03, 0.388, -0.026, 0.8]],
  },
  blend: 0.01,
  tailFade: 0.05,
  gloss: 0.26,
  sheen: 0.13,
  rig: { xTail: -0.255, xStart: 0.1, strips: 6, ampPed: 0.015, lagPed: 4.2, pow: 1.4, rot: 8, squash: 0.28 },
  look: ({ A, B, C, seed, px }) => {
    const bronze = mix3(A, hex('#9a7e5c'), 0.6);
    const top = mul3(bronze, 0.62);
    const flank = mul3(bronze, 0.96);
    const white = mul3(B, 0.97);
    const black = mul3(C, 0.9);
    const line = curve1([[0.5, -0.006], [0.47, -0.009], [0.436, -0.011], [0.4, -0.013], [0.35, -0.015], [0.31, -0.018], [0.285, -0.03], [0.25, -0.04], [0.2, -0.036], [0.12, -0.03], [0.04, -0.03], [-0.04, -0.03], [-0.1, -0.024], [-0.16, -0.016], [-0.22, -0.012], [-0.27, -0.016], [-0.31, -0.03]]);
    const wav = (x) => line(x) + 0.006 * (fbm(x * 11 + 1.3, 2.9, 2, seed) - 0.5) * smoothstep(0.45, 0.3, x);
    const grey = (x, y, s) => mul3(mix3(flank, top, smoothstep(-0.2, 0.95, s)), 0.94 + 0.12 * organic(x * 30, y * 30, seed + 11, 3));
    // pale flank band: a wedge of the belly colour pushing forward into the bronze above the pelvic fins
    const band = (x, y) => {
      const t = clamp((0.2 - x) / 0.32);
      const yc = lerp(0.006, -0.02, t);
      return smoothstep(0.0, 0.25, t) * 0.8 * gauss(y - yc, 0.002 + 0.011 * t);
    };
    const skinCol = (x, y, s) => {
      let c = grey(x, y, s);
      c = mix3(c, mul3(white, 0.93), band(x, y));
      c = mix3(white, c, smoothstep(-1.4 * px, 1.4 * px, y - wav(x)));
      return c;
    };
    const finCol = (x, y, sd, k = 0.84) => mul3(grey(x, y, 0.6), k * (0.86 + 0.14 * smoothstep(0, 0.02, sd)));
    /** Ink-dipped tip: 1 beyond the line through (px, py) with normal (nx, ny), ragged by a little noise. */
    const tip = (x, y, px0, py0, nx, ny, w = 0.006) => smoothstep(-w, w, (x - px0) * nx + (y - py0) * ny + 0.008 * (organic(x * 60, y * 60, seed + 31, 2) - 0.5));
    return {
      skin: skinCol,
      detail: (alb, x, y) => {
        const nd = Math.hypot((x - 0.474 + (y + 0.011) * 0.4) / 0.0055, (y + 0.011) / 0.0022);
        return mul3(alb, 1 - 0.75 * smoothstep(1.2, 0.6, nd));
      },
      fin: {
        dorsal1: {
          alb: (x, y, sd) => {
            let c = finCol(x, y, sd);
            // black apex with the pale band below it
            const k = tip(x, y, 0.1, 0.148, -0.25, 0.97);
            const pale = tip(x, y, 0.1, 0.127, -0.25, 0.97) * (1 - k);
            c = mix3(c, mul3(white, 0.86), pale * 0.85);
            return mix3(c, black, k);
          },
          streak: [520, 230, 0.03], dome: [0.34, 0.1],
        },
        dorsal2: { alb: (x, y, sd) => mix3(finCol(x, y, sd, 0.8), black, tip(x, y, -0.14, 0.064, -0.4, 0.92, 0.004)), rimW: 0.003, dome: [0.2, 0.1] },
        anal: { alb: (x, y, sd) => mix3(mix3(white, finCol(x, y, sd, 0.8), 0.3), black, tip(x, y, -0.15, -0.062, -0.4, -0.92, 0.004)), rimW: 0.003, ao: () => 0.74, dome: [0.2, 0.1] },
        pelvic: {
          alb: (x, y, sd) => mix3(mix3(white, finCol(x, y, sd, 0.8), 0.2 + 0.3 * smoothstep(-0.08, -0.06, y)), black, tip(x, y, -0.04, -0.09, -0.45, -0.89, 0.004)),
          rimW: 0.004, ao: () => 0.76, root: (x, y) => smoothstep(-0.058, -0.072, y), dome: [0.2, 0.1],
        },
        caudal: {
          alb: (x, y, sd) => {
            let c = finCol(x, y, sd, 0.8);
            const k = smoothstep(-0.29, -0.235, x) * smoothstep(-1.4 * px, 1.4 * px, wav(x) - y);
            c = mix3(c, white, k);
            // black trailing margin, broad black tip on the lower lobe, dark tip on the upper
            const margin = smoothstep(0.011, 0.004, sd) * smoothstep(-0.3, -0.34, x) * smoothstep(0.2, 0.6, organic(x * 40, y * 40, seed + 7, 2) + 0.35);
            const low = tip(x, y, -0.345, -0.07, -0.35, -0.94, 0.007);
            const up = tip(x, y, -0.468, 0.15, -0.8, 0.6, 0.007);
            return mix3(c, black, Math.max(margin * 0.9, low, up));
          },
          streak: [0, 520, 0.03], dome: [0.25, 0.3],
        },
        pectFar: { alb: (x, y) => mix3(mul3(white, 0.8), black, tip(x, y, 0.245, -0.14, -0.5, -0.87)), dim: 0.85, ao: () => 0.6, dome: [0.2, 0.1] },
        pect: {
          alb: (x, y, sd) => mix3(finCol(x, y, sd, 0.88), black, tip(x, y, 0.2, -0.15, -0.55, -0.83)),
          streak: [330, 330, 0.03], tilt: [-0.06, 0.08], dome: [0.3, 0.16],
          root: (x, y) => smoothstep(-0.04, -0.066, y - (x - 0.27) * 0.32),
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------- whitemouth moray
const MORAY = {
  lenPx: 400,
  ss: 3,
  body: {
    pts: [
      // back, blunt snout to tail tip (authored straight: the wave rig bends it)
      [0.497, 0.006], [0.494, 0.018], [0.484, 0.028], [0.462, 0.036], [0.43, 0.041], [0.39, 0.044], [0.34, 0.045], [0.25, 0.044], [0.1, 0.043],
      [-0.05, 0.041], [-0.2, 0.037], [-0.32, 0.031], [-0.4, 0.024], [-0.45, 0.016], [-0.485, 0.007], [-0.497, 0.0],
      // belly, tail tip to chin (swollen throat, the lower jaw hangs open)
      [-0.485, -0.007], [-0.45, -0.016], [-0.4, -0.024], [-0.32, -0.032], [-0.2, -0.038], [-0.05, -0.042], [0.1, -0.044], [0.25, -0.045],
      [0.34, -0.049], [0.39, -0.051], [0.43, -0.05], [0.46, -0.046], [0.48, -0.04], [0.49, -0.033], [0.4945, -0.022],
    ],
    ratio: [[0.5, 0.9], [0.3, 0.92], [0, 0.85], [-0.3, 0.72], [-0.5, 0.5]],
    mid: 0.5,
  },
  fins: {
    // one continuous fleshy fold: dorsal fin from the nape, round the tail tip, anal fin to mid body
    fold: [
      [0.385, 0.028], [0.362, 0.05], [0.33, 0.06], [0.28, 0.064], [0.18, 0.064], [0.05, 0.062], [-0.1, 0.058], [-0.24, 0.052], [-0.35, 0.042],
      [-0.43, 0.03], [-0.48, 0.016], [-0.5, 0.0], [-0.48, -0.015], [-0.43, -0.028], [-0.35, -0.04], [-0.24, -0.048], [-0.1, -0.053],
      [0.0, -0.052], [0.06, -0.047], [0.1, -0.036],
    ],
  },
  rig: { xTail: -0.43, xStart: 0.37, strips: 10, ampPed: 0.028, lagPed: 5.2, pow: 1.2, rot: 4, squash: 0.1, feather: 0.036 },
};

function buildMoray(id, opts) {
  const K = MORAY;
  const ctx = context(id, opts, K);
  const { S, ss, px, pitch, body, F, A, B, seed } = ctx;
  const HALF_PI = PI / 2;
  const cream = mul3(B, 0.95);
  // ---- skin: dark chocolate with small dark-edged white spots, unwrapped round the trunk so the
  // spots crowd toward the back and belly lines as they would on a cylinder
  const unwrap = (x, y) => {
    const t = body.top(x);
    const b = body.bot(x);
    const m = (t + b) / 2;
    const h = (t - b) / 2;
    if (y >= t) return m + h * HALF_PI + (y - t);
    if (y <= b) return m - h * HALF_PI - (b - y);
    return m + h * Math.asin(clamp((y - m) / Math.max(h, 1e-6), -1, 1));
  };
  const skinCol = (x, y) => {
    const V = unwrap(x, y);
    const dens = 52 + 150 * Math.max(0, x - 0.3); // finer spots on the head
    const X = 52 * x + 75 * Math.pow(Math.max(0, x - 0.3), 2);
    let c = mul3(A, 0.62 + 0.4 * organic(x * 14, V * 14, seed, 3));
    c = saturate([c[0] * 1.1, c[1] * 0.98, c[2] * 0.86], 1.3);
    const w = worley(X, V * dens, seed + 3);
    if (w.id > 0.06) {
      const rad = 0.15 + 0.14 * fract(w.id * 7.13);
      c = mul3(c, 1 - 0.5 * smoothstep(rad + 0.17, rad + 0.03, w.f1));
      c = mix3(c, cream, smoothstep(rad + 0.035, rad - 0.035, w.f1));
    }
    // white tail tip
    return mix3(c, cream, smoothstep(-0.484, -0.495, x));
  };
  // ---- open mouth: white lining between the lips, a small notch between the jaw tips
  const xc = 0.41;
  const xu = 0.4945;
  const lipU = (t) => lerp(-0.012, 0.001, t) - 0.003 * Math.sin(PI * t);
  const lipL = (t) => lerp(-0.012, -0.0205, t) - 0.002 * Math.sin(PI * t);
  const notch = makeSdf(outline([[0.478, -0.0095, 1], [0.5, 0.003, 1], [0.5, -0.0205, 1]], 4), 0.5 * px, 0.01);
  const eye = { x: 0.461, y: 0.0195, r: 0.0105, iris: [0.86, 0.8, 0.5], pr: 0.5, socket: 0.45, seed: 9 };
  const G = { n: [0, 0, 1] };
  const bodyFn = (x, y, out) => {
    const sd = body.sdf.at(x, y);
    if (sd <= -0.5 * pitch) return false;
    let alpha = clamp(0.5 + sd / pitch) * (1 - clamp(0.5 + notch.at(x, y) / pitch));
    if (!(alpha > 0)) return false;
    body.geom(x, y, G);
    const n = G.n;
    const s = G.s;
    let alb = skinCol(x, y);
    let ao = 0.78 + 0.22 * smoothstep(-1.0, -0.4, s);
    let c = null;
    if (x > xc - 0.02) {
      const t = (x - xc) / (xu - xc);
      if (t > 0 && t < 1.08) {
        const yU = lipU(t);
        const yL = lipL(t);
        if (y < yU && y > yL) {
          // the white mouth lining: shaded under the upper jaw and toward the hinge
          let m = mix3([0.93, 0.9, 0.86], [0.8, 0.6, 0.56], 0.45 * smoothstep(0.5, 0.0, t));
          m = mul3(m, (0.55 + 0.45 * smoothstep(yU, yL, y)) * (0.5 + 0.5 * smoothstep(0.0, 0.45, t)));
          // needle teeth on both jaws
          const tw = 0.012;
          const fu = (x - 0.4385) / tw;
          const fl = fu + 0.5;
          const len = 0.0085 * smoothstep(0.15, 0.5, t);
          const du = (yU - y) / len;
          const dl = (y - yL) / len;
          const wu = Math.abs(fract(fu) - 0.5) * tw;
          const wl = Math.abs(fract(fl) - 0.5) * tw;
          if (x > 0.433 && du < 1 && wu < 0.0023 * (1 - du)) m = mul3([1.0, 0.96, 0.84], 0.72 + 0.3 * du);
          else if (x > 0.433 && dl < 1 && wl < 0.0023 * (1 - dl)) m = mul3([1.0, 0.96, 0.84], 0.72 + 0.3 * dl);
          c = tone(mul3(m, 0.96));
        } else {
          // rounded lips: the lower one catches the light, the upper one is in its own shadow
          const dU = (y - yU) / px;
          const dL = (yL - y) / px;
          if (dU >= 0 && dU < 3) {
            nudge(n, 0, -0.5 * smoothstep(3, 0, dU));
            alb = mul3(alb, 1 - 0.35 * smoothstep(1.4, 0, dU));
          }
          if (dL >= 0 && dL < 3) {
            nudge(n, 0, 0.6 * smoothstep(3, 0, dL));
            alb = mul3(alb, 1 - 0.3 * smoothstep(1.2, 0, dL));
          }
        }
      }
    }
    if (!c) {
      // jaw muscle swell behind the eye, throat pleats, the small dark gill opening
      bump(n, x, y, 0.4, 0.014, 0.035, 0.022, 0.004);
      if (x > 0.3 && x < 0.455 && s < -0.25) {
        const pl = Math.sin((s + 1) * 26);
        const k = smoothstep(0.3, 0.33, x) * smoothstep(0.455, 0.42, x) * smoothstep(-0.25, -0.45, s);
        nudge(n, 0, 0.16 * k * pl);
        alb = mul3(alb, 1 - 0.1 * k * (0.5 + 0.5 * pl));
      }
      const gd = Math.hypot((x - 0.33) / 0.0068, (y + 0.006) / 0.0046);
      alb = mul3(alb, 1 - 0.85 * smoothstep(1.15, 0.7, gd) - 0.25 * smoothstep(2.6, 1.0, gd) * smoothstep(0.7, 1.15, gd));
      c = skin(alb, n, 0.46, 0.2, ao, 0.2);
    }
    const ex = (x - eye.x) / eye.r;
    const ey = (y - eye.y) / eye.r;
    if (Math.abs(ex) < 2 && Math.abs(ey) < 2) c = eyeOver(c, ex, ey, eye);
    alpha *= melt(sd, x, y, [F.fold], 0.009);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = alpha;
    return true;
  };
  // ---- tube nostril on the snout tip
  const nb = [0.4915, 0.0125, 0.5005, 0.016, 0.003];
  const nostril = {
    box: [nb[0] - nb[4], nb[1] - nb[4], nb[2] + nb[4], nb[3] + nb[4]],
    fn: (x, y, out) => {
      const r = segDist(x, y, nb[0], nb[1], nb[2], nb[3]);
      const d = nb[4] * (1 - 0.2 * r[1]) - r[0];
      if (d <= -0.5 * pitch) return false;
      const q = clamp(1 - d / nb[4]);
      const ux = nb[2] - nb[0];
      const uy = nb[3] - nb[1];
      const side = Math.sign((x - nb[0]) * -uy + (y - nb[1]) * ux) || 1;
      const l = Math.hypot(ux, uy);
      const nn = [(-uy / l) * side * q, (ux / l) * side * q, Math.sqrt(Math.max(0.02, 1 - q * q))];
      const c = skin(mix3(mul3(A, 0.9), cream, 0.08 + 0.3 * r[1]), nn, 0.4, 0.2, 1, 0.3);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = clamp(0.5 + d / pitch);
      return true;
    },
  };
  const fold = foilFin(F.fold, pitch, {
    alb: (x, y, sd) => mul3(skinCol(x, y), 0.74 + 0.16 * smoothstep(0, 0.012, sd)),
    dome: [0, 0], rim: 0.8, rimW: 0.004, gloss: 0.4, sheen: 0.18,
    ao: (x, y) => 0.78 + 0.22 * smoothstep(0, 0.014, -body.sdf.at(x, y)),
  });
  return assemble(S, ss, [fold, { box: body.box, fn: bodyFn }, nostril], K.rig, null);
}

// ---------------------------------------------------------------------------- blackfin barracuda
/** Fine overlapping scale rows (as fish.mjs): darker rims in the albedo, a small tilt in the normal. */
function fineScales(alb, n, u, s, nu, nv, k) {
  if (!(k > 0)) return alb;
  const row = (Math.asin(clamp(s, -1, 1)) / (PI / 2)) * nv;
  const ri = Math.floor(row);
  const cx = fract(u * nu + (ri & 1 ? 0.5 : 0)) - 0.5;
  const cy = row - ri - 0.5;
  const rim = smoothstep(0.3, 0.52, Math.hypot(cx * 1.15 - 0.12, cy));
  nudge(n, cx * 0.2 * k, cy * 0.16 * k);
  return mul3(alb, 1 - 0.12 * rim * k);
}

const BARRACUDA = {
  lenPx: 330,
  ss: 3,
  body: {
    pts: [
      // back, upper jaw tip to tail
      [0.488, 0.001], [0.47, 0.007], [0.44, 0.014], [0.4, 0.021], [0.35, 0.029], [0.3, 0.036], [0.24, 0.043], [0.17, 0.05], [0.09, 0.055],
      [0.0, 0.056], [-0.09, 0.053], [-0.18, 0.046], [-0.26, 0.036], [-0.33, 0.026], [-0.375, 0.021], [-0.4, 0.019], [-0.418, 0.0],
      // belly, tail to the jutting lower jaw
      [-0.4, -0.019], [-0.375, -0.021], [-0.33, -0.027], [-0.26, -0.038], [-0.18, -0.049], [-0.09, -0.057], [0.0, -0.06], [0.09, -0.059],
      [0.17, -0.054], [0.24, -0.048], [0.3, -0.041], [0.35, -0.035], [0.4, -0.029], [0.44, -0.024], [0.47, -0.019], [0.49, -0.014],
      [0.4985, -0.0095], [0.5, -0.005, 1], [0.495, -0.002], [0.489, -0.0015, 1],
    ],
    ratio: 0.88,
    mid: 0.5,
  },
  fins: {
    dorsal1: [[0.118, 0.05], [0.102, 0.098], [0.094, 0.118, 1], [0.082, 0.096], [0.07, 0.074], [0.058, 0.06, 1], [0.064, 0.048]],
    dorsal2: [[-0.12, 0.045], [-0.135, 0.084], [-0.15, 0.11, 1], [-0.16, 0.086], [-0.172, 0.068], [-0.19, 0.058], [-0.207, 0.054, 1], [-0.192, 0.038]],
    anal: [[-0.13, -0.048], [-0.146, -0.086], [-0.162, -0.11, 1], [-0.172, -0.086], [-0.184, -0.068], [-0.2, -0.059], [-0.216, -0.056, 1], [-0.202, -0.04]],
    pelvic: [[0.126, -0.052], [0.106, -0.084], [0.086, -0.098, 1], [0.083, -0.08], [0.094, -0.054]],
    caudal: [
      [-0.38, 0.022], [-0.42, 0.045], [-0.46, 0.078], [-0.5, 0.104, 1], [-0.478, 0.06], [-0.455, 0.025], [-0.442, 0.0], [-0.455, -0.025],
      [-0.478, -0.06], [-0.5, -0.104, 1], [-0.46, -0.08], [-0.42, -0.046], [-0.38, -0.022],
    ],
    pect: [[0.246, -0.008], [0.216, -0.02], [0.186, -0.038], [0.164, -0.056, 1], [0.182, -0.06], [0.212, -0.047], [0.242, -0.03]],
  },
  rig: { xTail: -0.39, xStart: 0.1, strips: 6, ampPed: 0.013, lagPed: 4.2, pow: 1.4, rot: 8, squash: 0.28 },
};

function buildBarracuda(id, opts) {
  const K = BARRACUDA;
  const ctx = context(id, opts, K);
  const { S, ss, px, pitch, body, F, A, B, C, seed } = ctx;
  const back = mul3(mix3(A, hex('#27485e'), 0.6), 0.72);
  const silver = mul3(C, 0.96);
  const belly = [0.93, 0.95, 0.96];
  const dark = mul3(B, 0.75);
  const yLL = 0.005;
  const opercle = makeStroke([[0.264, 0.032], [0.247, 0.012], [0.243, -0.008], [0.252, -0.028], [0.268, -0.042]]);
  const preop = makeStroke([[0.313, 0.022], [0.303, 0.0], [0.306, -0.02], [0.32, -0.034]]);
  const eye = { x: 0.35, y: 0.0085, r: 0.019, iris: [0.84, 0.78, 0.56], pr: 0.5, socket: 0.3, seed: 4 };
  const mouthY = (t) => lerp(-0.0015, -0.016, t) + 0.0022 * Math.sin(PI * t);
  const G = { n: [0, 0, 1] };
  const bodyFn = (x, y, out) => {
    const sd = body.sdf.at(x, y);
    if (sd <= -0.5 * pitch) return false;
    const alpha = clamp(0.5 + sd / pitch);
    body.geom(x, y, G);
    const n = G.n;
    const s = G.s;
    const u = 0.5 - x;
    let alb = mix3(silver, back, smoothstep(0.3, 0.9, s));
    alb = mix3(alb, belly, smoothstep(-0.2, -0.8, s));
    // 20-odd dark chevrons on the upper flank, their points on the lateral line facing the head
    if (x < 0.27 && x > -0.4) {
      const f = fract((0.262 - x - (y > yLL ? 0.75 : 0.5) * Math.abs(y - yLL)) / 0.0305);
      const bar = smoothstep(0.3, 0.42, f) * smoothstep(0.78, 0.66, f);
      const m = smoothstep(yLL - 0.02, yLL - 0.006, y) * smoothstep(0.27, 0.245, x) * smoothstep(-0.4, -0.375, x);
      alb = mix3(alb, mul3(dark, 0.55), 0.85 * bar * m);
    }
    const bodyK = smoothstep(0.255, 0.225, x) * smoothstep(-0.41, -0.38, x) * smoothstep(1.0, 0.75, Math.abs(s));
    alb = fineScales(alb, n, u, s, 120, 15, bodyK);
    // lateral line
    alb = mul3(alb, 1 - 0.22 * gauss(y - yLL + 0.002 * Math.sin(x * 9), 0.0016) * bodyK);
    let ao = 0.8 + 0.2 * smoothstep(-1.0, -0.45, s);
    let c = null;
    if (x > 0.2) {
      // gill cover and cheek plate: a crease with a lit edge in front of it
      const o1 = opercle.dist(x, y);
      const o0 = opercle.dist(x + 1.6 * px, y);
      alb = mul3(alb, 1 - 0.5 * smoothstep(1.5 * px, 0.3 * px, o1[0]));
      nudge(n, 0.35 * (smoothstep(2.5 * px, 0, o0[0]) - smoothstep(2.5 * px, 0, o1[0])), 0);
      alb = mul3(alb, 1 - 0.22 * smoothstep(1.4 * px, 0.3 * px, preop.dist(x, y)[0]));
      // jaws: the lower one juts out; a slightly open mouth shows the teeth line
      const t = (0.489 - x) / (0.489 - 0.39);
      if (t > -0.12 && t < 1.05) {
        const tt = clamp(t);
        const yU = mouthY(tt);
        const gap = 0.0085 * Math.pow(1 - tt, 0.5) * smoothstep(1.0, 0.82, tt) + 0.7 * px;
        const yL = yU - gap;
        if (y < yU && y > yL && t > 0) {
          let m = [0.035, 0.02, 0.025];
          const tw = 0.0088;
          const fu = (0.489 - x) / tw;
          const du = (yU - y) / (gap * 0.72);
          const dl = (y - yL) / (gap * (x > 0.468 ? 1.05 : 0.6));
          if (du < 1 - Math.abs(fract(fu) - 0.5) * 2.3) m = mul3([0.97, 0.96, 0.9], 0.7 + 0.3 * du);
          else if (dl < 1 - Math.abs(fract(fu + 0.5) - 0.5) * 2.5) m = mul3([0.97, 0.96, 0.9], 0.7 + 0.3 * dl);
          c = tone(m);
        } else {
          const dU = (y - yU) / px;
          const dL = (yL - y) / px;
          if (dU >= 0 && dU < 2) alb = mul3(alb, 1 - 0.45 * smoothstep(2, 0.2, dU));
          if (dL >= 0 && dL < 2.5) {
            alb = mul3(alb, 1 - 0.3 * smoothstep(2.5, 0.2, dL));
            nudge(n, 0, 0.3 * smoothstep(2.5, 0, dL));
          }
        }
      }
      // maxilla end under the eye, nostril
      const mx = segDist(x, y, 0.39, -0.016, 0.372, -0.0235);
      alb = mul3(alb, 1 - 0.35 * smoothstep(1.2 * px, 0.2 * px, mx[0]));
      alb = mul3(alb, 1 - 0.6 * smoothstep(1.2, 0.5, Math.hypot((x - 0.402) / 0.0045, (y - 0.0135) / 0.0022)));
    }
    if (!c) c = skin(alb, n, 0.55, 0.26, ao, 0.2);
    const ex = (x - eye.x) / eye.r;
    const ey = (y - eye.y) / eye.r;
    if (Math.abs(ex) < 2 && Math.abs(ey) < 2) c = eyeOver(c, ex, ey, eye);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = alpha;
    return true;
  };
  const finDark = (k) => () => mul3(mix3(dark, back, 0.3), k);
  const layers = [
    rayFin(F.caudal, pitch, { fan: [-0.35, 0], r0: 0.035, len: 0.14, rays: 30, col: finDark(0.7), alpha: [0.99, 0.94], edge: 0.5 }),
    rayFin(F.dorsal1, pitch, { fan: [0.086, 0.025], r0: 0.03, len: 0.075, rays: 44, spiny: true, col: finDark(1.25), alpha: [0.97, 0.86] }),
    rayFin(F.dorsal2, pitch, { fan: [-0.165, 0.01], r0: 0.04, len: 0.075, rays: 60, col: finDark(0.8), alpha: [0.98, 0.9], edge: 0.6 }),
    rayFin(F.anal, pitch, { fan: [-0.175, -0.012], r0: 0.04, len: 0.075, rays: 60, col: finDark(0.8), alpha: [0.98, 0.9], edge: 0.6 }),
    rayFin(F.pelvic, pitch, { fan: [0.122, -0.048], r0: 0.006, len: 0.05, rays: 34, col: () => mix3(silver, dark, 0.3), alpha: [0.96, 0.84] }),
    { box: body.box, fn: bodyFn },
  ];
  const pect = rayFin(F.pect, pitch, { fan: [0.25, -0.016], r0: 0.006, len: 0.09, rays: 40, col: () => mix3(silver, dark, 0.55), alpha: [0.95, 0.78] });
  return assemble(S, ss, layers, K.rig, { layer: pect, pivot: [0.242, -0.018], flap: [11, 1.6, 0.6] });
}

// ---------------------------------------------------------------------------- humphead wrasse
const HUMPHEAD = {
  lenPx: 380,
  ss: 2,
  body: {
    pts: [
      // upper lip, steep forehead, the hump over the eyes, back, peduncle
      [0.497, -0.03], [0.493, -0.016], [0.48, -0.004], [0.464, 0.016], [0.45, 0.044], [0.438, 0.078], [0.424, 0.118], [0.404, 0.156],
      [0.376, 0.188], [0.34, 0.208], [0.298, 0.212], [0.256, 0.2], [0.218, 0.188], [0.17, 0.188], [0.11, 0.189], [0.04, 0.182], [-0.04, 0.166],
      [-0.12, 0.14], [-0.2, 0.105], [-0.26, 0.078], [-0.3, 0.066], [-0.33, 0.062], [-0.35, 0.056],
      [-0.359, 0.032], [-0.361, 0.004], [-0.359, -0.024],
      // peduncle, belly, throat, lower lip
      [-0.35, -0.048], [-0.33, -0.054], [-0.3, -0.058], [-0.25, -0.07], [-0.18, -0.094], [-0.1, -0.122], [-0.02, -0.145], [0.06, -0.16],
      [0.14, -0.166], [0.22, -0.164], [0.29, -0.154], [0.35, -0.137], [0.4, -0.114], [0.435, -0.092], [0.462, -0.074], [0.48, -0.064],
      [0.491, -0.052], [0.4945, -0.042],
    ],
    ratio: 0.52,
    mid: 0.5,
    band: 0.03,
  },
  fins: {
    dorsal: [
      [0.215, 0.17], [0.2, 0.214], [0.165, 0.232], [0.1, 0.236], [0.03, 0.228], [-0.04, 0.218], [-0.1, 0.208], [-0.16, 0.196], [-0.22, 0.178],
      [-0.275, 0.152], [-0.31, 0.13], [-0.332, 0.108, 1], [-0.312, 0.096], [-0.296, 0.076], [-0.29, 0.05],
    ],
    anal: [[-0.04, -0.13], [-0.06, -0.185], [-0.1, -0.2], [-0.16, -0.194], [-0.22, -0.172], [-0.275, -0.142], [-0.31, -0.12], [-0.332, -0.1, 1], [-0.312, -0.088], [-0.296, -0.07], [-0.29, -0.045]],
    pelvic: [[0.205, -0.155], [0.175, -0.2], [0.135, -0.236], [0.108, -0.25, 1], [0.112, -0.222], [0.14, -0.18], [0.165, -0.152]],
    caudal: [[-0.33, 0.064], [-0.37, 0.088], [-0.42, 0.104], [-0.465, 0.092], [-0.492, 0.05], [-0.5, 0.0], [-0.492, -0.046], [-0.465, -0.086], [-0.42, -0.098], [-0.37, -0.082], [-0.33, -0.056]],
    pect: [[0.214, -0.012], [0.17, -0.004], [0.122, -0.012], [0.088, -0.036], [0.082, -0.066], [0.106, -0.09], [0.15, -0.096], [0.195, -0.076], [0.214, -0.05]],
  },
  finBand: 0.02,
  // the dorsal and anal lobes end just in front of the tail joint, so the swinging tail never tears them
  rig: { xTail: -0.345, xStart: -0.02, strips: 3, ampPed: 0.012, lagPed: 2.0, pow: 1.4, rot: 9, squash: 0.3 },
};

function buildHumphead(id, opts) {
  const K = HUMPHEAD;
  const ctx = context(id, opts, K);
  const { S, ss, px, pitch, body, F, A, B, C, seed } = ctx;
  const scaleMid = mix3(A, B, 0.24);
  const scaleEdge = mul3(A, 0.66);
  const lineCol = mul3(C, 1.1);
  const headBase = mix3(A, hex('#2a6c9a'), 0.5);
  const headLine = hex('#b9c85e');
  const yellow = hex('#d8c648');
  const opercle = makeStroke([[0.246, 0.112], [0.222, 0.06], [0.213, 0.0], [0.224, -0.06], [0.25, -0.106]]);
  const preop = makeStroke([[0.318, 0.05], [0.302, 0.0], [0.308, -0.05], [0.33, -0.09]]);
  const humpLine = makeStroke([[0.418, 0.108], [0.38, 0.122], [0.33, 0.128], [0.285, 0.146], [0.256, 0.168]]);
  const eyeL1 = makeStroke([[0.369, 0.08], [0.335, 0.1], [0.294, 0.124], [0.262, 0.137]]);
  const eyeL2 = makeStroke([[0.369, 0.066], [0.33, 0.074], [0.288, 0.087], [0.258, 0.093]]);
  const mouth = makeStroke([[0.4975, -0.0365], [0.482, -0.039], [0.468, -0.043], [0.457, -0.05]]);
  const eye = { x: 0.386, y: 0.072, r: 0.0142, iris: [0.82, 0.52, 0.16], pr: 0.5, socket: 0.4, seed: 6 };
  const xOp = (y) => 0.213 + 3.3 * y * y;
  const G = { n: [0, 0, 1] };
  const sc = {};
  const bodyFn = (x, y, out) => {
    const sd = body.sdf.at(x, y);
    if (sd <= -0.5 * pitch) return false;
    const alpha = clamp(0.5 + sd / pitch);
    body.geom(x, y, G);
    const n = G.n;
    const s = G.s;
    const headK = smoothstep(-0.006, 0.006, x - xOp(y));
    let alb;
    let gl = 0.3;
    // ---- body: big roof-tile scales, each with a few dark wavy lines
    {
      const yy = lerp(y, s * 0.176, 0.5);
      tileScale(x, yy, 0.0345, 0.0285, 0.68, sc);
      const rim = smoothstep(0.14, 0.0, sc.e);
      let b = mix3(scaleMid, scaleEdge, smoothstep(0.35, 0.0, sc.e) * 0.7);
      b = mix3(b, lineCol, 0.7 * maze(x * 78 + sc.j * 3.7, yy * 34 + sc.i * 5.3, seed, 0.26));
      b = mul3(b, (1 - 0.34 * sc.sh) * (1 + 0.3 * rim));
      const bk = 1 - headK;
      if (bk > 0 && sc.e < 0.3) {
        const l = Math.hypot(sc.lx, sc.ly) || 1;
        nudge(n, (sc.lx / l) * 0.3 * rim * bk, (sc.ly / l) * 0.3 * rim * bk);
      }
      alb = b;
    }
    // ---- head: smooth skin with a fine yellow-green maze
    if (headK > 0) {
      let h = mul3(headBase, 0.9 + 0.2 * organic(x * 20, y * 20, seed + 3, 2));
      h = mix3(h, headLine, 0.6 * maze(x * 88, y * 88, seed + 9, 0.3) * smoothstep(0.492, 0.46, x));
      // thick fleshy lips and the hump: rounded masses of their own
      const lu = bump(n, x, y, 0.485, -0.02, 0.019, 0.013, 0.011);
      const ll = bump(n, x, y, 0.478, -0.055, 0.019, 0.0115, 0.011);
      h = mix3(h, mix3(headBase, B, 0.7), 0.9 * Math.max(lu, ll));
      bump(n, x, y, 0.335, 0.168, 0.062, 0.042, 0.016);
      const hl = humpLine.dist(x, y);
      h = mul3(h, 1 - 0.22 * smoothstep(0.006, 0.0, hl[0]) * Math.sin(PI * hl[1]));
      nudge(n, 0, -0.25 * smoothstep(0.008, 0.0, hl[0]) * Math.sin(PI * hl[1]));
      h = mul3(h, 1 - 0.7 * smoothstep(1.5 * px, 0.3 * px, mouth.dist(x, y)[0]));
      h = mul3(h, 1 - 0.2 * smoothstep(1.6 * px, 0.3 * px, preop.dist(x, y)[0]));
      // two dark lines running back from the eye
      const d1 = eyeL1.dist(x, y);
      const d2 = eyeL2.dist(x, y);
      const ln = Math.max(smoothstep(0.0042, 0.0022, d1[0]) * (1 - 0.3 * d1[1]), smoothstep(0.0042, 0.0022, d2[0]) * (1 - 0.3 * d2[1]));
      h = mix3(h, mul3(C, 0.45), 0.92 * ln);
      alb = mix3(alb, h, headK);
      gl = lerp(gl, 0.42, headK);
    }
    // gill cover edge
    const o1 = opercle.dist(x, y);
    const o0 = opercle.dist(x + 2 * px, y);
    alb = mul3(alb, 1 - 0.5 * smoothstep(1.8 * px, 0.3 * px, o1[0]));
    nudge(n, 0.4 * (smoothstep(3 * px, 0, o0[0]) - smoothstep(3 * px, 0, o1[0])), 0);
    // soft shadow under the pectoral fin
    alb = mul3(alb, 1 - 0.2 * clamp(0.5 + F.pect.at(x + 0.008, y + 0.012) / 0.016));
    const ao = 0.8 + 0.2 * smoothstep(-1.0, -0.5, s);
    let c = skin(alb, n, gl, 0.14, ao, 0.2);
    const ex = (x - eye.x) / eye.r;
    const ey = (y - eye.y) / eye.r;
    if (Math.abs(ex) < 2 && Math.abs(ey) < 2) c = eyeOver(c, ex, ey, eye);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = alpha;
    return true;
  };
  const finBase = (x, y) => mix3(mul3(A, 0.85), lineCol, 0.45 * maze(x * 70, y * 70, seed + 5, 0.22));
  const edgeBlue = mix3(B, [0.5, 0.8, 1.0], 0.35);
  const layers = [
    rayFin(F.caudal, pitch, {
      fan: [-0.25, 0.004], r0: 0.085, len: 0.165, rays: 84, alpha: [0.99, 0.93],
      col: (x, y, r) => mix3(finBase(x, y), yellow, smoothstep(0.74, 0.93, r) * 0.92),
    }),
    rayFin(F.dorsal, pitch, {
      fan: [0.25, -0.35], rays: 170, alpha: [0.99, 0.9], rOf: (x, y) => clamp((y - body.top(x)) / 0.062),
      col: (x, y, r) => mix3(finBase(x, y), edgeBlue, 0.7 * smoothstep(0.72, 1.0, r)),
    }),
    rayFin(F.anal, pitch, {
      fan: [0.2, 0.3], rays: 170, alpha: [0.99, 0.9], rOf: (x, y) => clamp((body.bot(x) - y) / 0.07),
      col: (x, y, r) => mix3(finBase(x, y), edgeBlue, 0.7 * smoothstep(0.72, 1.0, r)),
    }),
    rayFin(F.pelvic, pitch, { fan: [0.2, -0.15], r0: 0.01, len: 0.12, rays: 60, alpha: [0.98, 0.88], col: (x, y) => finBase(x, y) }),
    { box: body.box, fn: bodyFn },
  ];
  const pect = rayFin(F.pect, pitch, {
    fan: [0.224, -0.034], r0: 0.012, len: 0.135, rays: 46, alpha: [0.93, 0.66],
    col: (x, y, r) => mix3(mix3(B, [0.74, 0.7, 0.3], 0.55), mul3(A, 0.9), 0.35 * (1 - r)),
  });
  return assemble(S, ss, layers, K.rig, { layer: pect, pivot: [0.208, -0.034], flap: [16, 1.3, 0.6] });
}

// ---------------------------------------------------------------------------- crocodile needlefish
const NEEDLEFISH = {
  lenPx: 300,
  ss: 3,
  body: {
    pts: [
      // upper jaw of the beak, head, back
      [0.4985, -0.0012], [0.47, 0.004], [0.42, 0.006], [0.36, 0.0085], [0.3, 0.0115], [0.27, 0.0145], [0.25, 0.019], [0.225, 0.0225],
      [0.19, 0.025], [0.12, 0.027], [0.0, 0.028], [-0.12, 0.0275], [-0.22, 0.025], [-0.3, 0.02], [-0.36, 0.0145], [-0.395, 0.0115],
      [-0.415, 0.01], [-0.43, 0.0],
      // belly, throat, the slightly longer lower jaw
      [-0.415, -0.01], [-0.395, -0.0115], [-0.36, -0.0155], [-0.3, -0.022], [-0.22, -0.028], [-0.12, -0.031], [0.0, -0.032], [0.12, -0.031],
      [0.19, -0.029], [0.225, -0.0265], [0.25, -0.023], [0.27, -0.0185], [0.3, -0.0145], [0.36, -0.0115], [0.42, -0.009], [0.47, -0.0065],
      [0.4995, -0.0035],
    ],
    ratio: 0.9,
    mid: 0.5,
  },
  fins: {
    dorsal: [[-0.24, 0.02], [-0.252, 0.05], [-0.266, 0.064, 1], [-0.28, 0.046], [-0.3, 0.034], [-0.33, 0.028], [-0.36, 0.024], [-0.386, 0.02, 1], [-0.378, 0.01]],
    anal: [[-0.22, -0.024], [-0.235, -0.056], [-0.25, -0.072, 1], [-0.265, -0.052], [-0.29, -0.038], [-0.32, -0.03], [-0.355, -0.025], [-0.382, -0.02, 1], [-0.372, -0.01]],
    pelvic: [[-0.094, -0.028], [-0.114, -0.05], [-0.13, -0.058, 1], [-0.132, -0.044], [-0.12, -0.028]],
    caudal: [
      [-0.398, 0.011], [-0.43, 0.026], [-0.46, 0.042], [-0.487, 0.053, 1], [-0.468, 0.03], [-0.45, 0.012], [-0.44, -0.002], [-0.452, -0.02],
      [-0.474, -0.042], [-0.5, -0.065, 1], [-0.465, -0.05], [-0.43, -0.03], [-0.398, -0.011],
    ],
    pect: [[0.184, 0.002], [0.16, -0.012], [0.136, -0.03], [0.118, -0.046, 1], [0.136, -0.044], [0.16, -0.032], [0.182, -0.016]],
  },
  rig: { xTail: -0.405, xStart: 0.14, strips: 7, ampPed: 0.014, lagPed: 4.6, pow: 1.3, rot: 6, squash: 0.25 },
};

function buildNeedlefish(id, opts) {
  const K = NEEDLEFISH;
  const ctx = context(id, opts, K);
  const { S, ss, px, pitch, body, F, A, B, C, seed } = ctx;
  const back = mul3(mix3(A, C, 0.38), 0.8);
  const stripe = mul3(mix3(C, hex('#123a6a'), 0.5), 0.8);
  const silver = mul3(mix3(B, [0.72, 0.95, 0.86], 0.25), 0.95);
  const belly = [0.94, 0.96, 0.96];
  const opercle = makeStroke([[0.2, 0.018], [0.188, 0.004], [0.19, -0.012], [0.2, -0.022]]);
  const eye = { x: 0.2355, y: 0.003, r: 0.0128, iris: [0.8, 0.86, 0.78], pr: 0.6, socket: 0.3, seed: 8 };
  const G = { n: [0, 0, 1] };
  const bodyFn = (x, y, out) => {
    const sd = body.sdf.at(x, y);
    if (sd <= -0.5 * pitch) return false;
    const alpha = clamp(0.5 + sd / pitch);
    body.geom(x, y, G);
    const n = G.n;
    const s = G.s;
    // blue-green back, a dark blue line where it meets the silver flank, white belly
    let alb = mix3(silver, back, smoothstep(-0.12, 0.2, s));
    alb = mix3(alb, stripe, 0.8 * gauss(s + 0.04, 0.1) * smoothstep(0.26, 0.2, x));
    alb = mix3(alb, belly, smoothstep(-0.25, -0.8, s));
    alb = mul3(alb, 0.95 + 0.1 * organic(x * 60, y * 60, seed, 2));
    let c = null;
    if (x > 0.17) {
      alb = mul3(alb, 1 - 0.45 * smoothstep(1.5 * px, 0.3 * px, opercle.dist(x, y)[0]));
      if (x > 0.255) {
        // the beak: a dark seam between the jaws with a row of needle teeth
        const t = (x - 0.262) / (0.499 - 0.262);
        const ym = lerp(-0.0035, -0.0022, t);
        const hw = (0.0019 - 0.0007 * t) * smoothstep(0.0, 0.06, t);
        const d = (y - ym) / hw;
        if (d > -1 && d < 1 && t > 0) {
          const f = fract(x / 0.0056);
          const tooth = f < 0.42 && t > 0.06 && t < 0.97;
          c = tone(tooth ? mul3([0.97, 0.96, 0.9], 0.8 + 0.2 * (1 - Math.abs(d))) : [0.03, 0.035, 0.04]);
        } else if (Math.abs(d) < 2.2) alb = mul3(alb, 0.8);
      }
    }
    // small black keel on the tail stalk
    alb = mul3(alb, 1 - 0.6 * gauss(y - 0.0005, 0.0026) * smoothstep(-0.35, -0.375, x) * smoothstep(-0.425, -0.405, x));
    if (!c) c = skin(alb, n, 0.55, 0.24, 0.8 + 0.2 * smoothstep(-1.0, -0.45, s), 0.2);
    const ex = (x - eye.x) / eye.r;
    const ey = (y - eye.y) / eye.r;
    if (Math.abs(ex) < 2 && Math.abs(ey) < 2) c = eyeOver(c, ex, ey, eye);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = alpha;
    return true;
  };
  const finCol = (k) => () => mul3(mix3(A, C, 0.6), k);
  const layers = [
    rayFin(F.caudal, pitch, { fan: [-0.385, -0.002], r0: 0.02, len: 0.11, rays: 36, col: finCol(0.6), alpha: [0.99, 0.93], edge: 0.5 }),
    rayFin(F.dorsal, pitch, { fan: [-0.3, -0.03], r0: 0.05, len: 0.05, rays: 70, col: finCol(0.8), alpha: [0.98, 0.9], edge: 0.6 }),
    rayFin(F.anal, pitch, { fan: [-0.29, 0.03], r0: 0.055, len: 0.05, rays: 70, col: finCol(0.8), alpha: [0.98, 0.9], edge: 0.6 }),
    rayFin(F.pelvic, pitch, { fan: [-0.096, -0.026], r0: 0.004, len: 0.036, rays: 34, col: () => mix3(silver, back, 0.35), alpha: [0.95, 0.82] }),
    { box: body.box, fn: bodyFn },
  ];
  const pect = rayFin(F.pect, pitch, { fan: [0.188, -0.004], r0: 0.004, len: 0.085, rays: 44, col: () => mix3(silver, back, 0.6), alpha: [0.95, 0.78] });
  return assemble(S, ss, layers, K.rig, { layer: pect, pivot: [0.18, -0.006], flap: [12, 1.7, 0.6] });
}

// ---------------------------------------------------------------------------- module contract
const BUILDERS = {
  greatWhite: (id, opts) => buildShark(id, opts, GREAT_WHITE),
  blacktipShark: (id, opts) => buildShark(id, opts, BLACKTIP),
  whitemouthMoray: buildMoray,
  blackfinBarracuda: buildBarracuda,
  humpheadWrasse: buildHumphead,
  crocNeedlefish: buildNeedlefish,
};

/** Only finished, rigged animals are listed (the packer integrates whatever is here). */
export const IDS = ['greatWhite', 'blacktipShark', 'whitemouthMoray', 'blackfinBarracuda', 'humpheadWrasse', 'crocNeedlefish'].filter((id) => BUILDERS[id]);

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
