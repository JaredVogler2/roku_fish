/**
 * Sprite renderer for the 26 animals and food organisms that are not fish-shaped: cephalopod, rays,
 * seahorse, jellyfish, plankton, crustaceans, echinoderms, molluscs, worms, sponges, algae, seagrass
 * and coral polyps.
 *
 * Same look as fish.mjs (shared light rig in lib/light.mjs, linear light, filmic tone curve), but the
 * animals are composed from a small set of lit primitives drawn back to front on a supersampled
 * surface (Painter): round tapered tubes, ellipsoids, arbitrary height fields, oblique height fields
 * ("seen from slightly above": rays and sea stars), polygons and glossy eyes.
 *
 * Authoring conventions
 *  - Model units: 1 = the species' body length (its longest natural dimension), x right, y UP,
 *    origin = sprite origin, animals face +x. Whiskers and antennae may reach beyond the unit box.
 *  - anchor 'center' (swimmers, drifters): origin = middle of the animal, nose/front at x = +0.5.
 *    anchor 'base' (seabed animals): the ground line is y = 0 with the origin under the middle of the
 *    animal (for the burrowing worm: the burrow mouth); bases dip a few pixels below it and a soft
 *    contact shadow is baked into the rear-most static part.
 *  - Every sprite is a small rig of rigid parts (Rig.add) listed back to front; pivots sit on the
 *    anatomical joint. Phases are radians (PH2..PH5 spread parts evenly over a cycle); `bob`
 *    amplitudes are in authored pixels and scale with opts.px.
 *  - Everything is deterministic: noise seeds and the placement PRNG derive from the species id.
 */
import fs from 'node:fs';
import {
  Img, over, blur, crop, bounds, hex, mix3, mul3, add3, norm3, clamp, lerp, smoothstep, fract, hash2, vnoise, fbm, worley,
  saturate, tone, lum, rng, hashStr,
} from './lib/core.mjs';
import { lit, membrane } from './lib/light.mjs';

const PI = Math.PI;
const TAU = PI * 2;
const SPECIES = JSON.parse(fs.readFileSync(new URL('./data/species.json', import.meta.url)));
const BY_ID = new Map(SPECIES.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------- small maths
const smax = (a, b, k) => {
  const h = clamp(0.5 + (0.5 * (a - b)) / k);
  return lerp(b, a, h) + k * h * (1 - h);
};
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
const organic = (x, y, seed, oct = 4) => fbm(x * 0.8 + y * 0.6 + 7.3, y * 0.8 - x * 0.6 + 3.1, oct, seed);
/** Tabulate a smooth 1D function on [a, b] for fast repeated lookups. */
function lut1(fn, a, b, n = 1024) {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = fn(a + ((b - a) * i) / n);
  return (x) => {
    const f = clamp((x - a) / (b - a)) * n;
    const i = Math.min(n - 1, Math.floor(f));
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  };
}
/** Distance from a point to a segment, plus the parameter along it. */
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2) : 0;
  return [Math.hypot(x - ax - dx * t, y - ay - dy * t), t];
}

/** Catmull-Rom spline through control points [x, y, r?, ...]; every component is interpolated. */
function spline(ctrl, per = 8) {
  const out = [];
  const n = ctrl.length;
  const dim = ctrl[0].length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(n - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const q = [];
      for (let c = 0; c < dim; c++) {
        q.push(0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
      }
      out.push(q);
    }
  }
  out.push(ctrl[n - 1].slice());
  return out;
}
/** Point and unit tangent at arc-length fraction f of a polyline. */
function along(pts, f) {
  let total = 0;
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    seg.push(l);
    total += l;
  }
  let d = clamp(f) * total;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) {
      const t = seg[i] > 0 ? clamp(d / seg[i]) : 0;
      const a = pts[i];
      const b = pts[i + 1];
      const l = seg[i] || 1;
      const o = a.map((v, c) => v + (b[c] - v) * t);
      o.tx = (b[0] - a[0]) / l;
      o.ty = (b[1] - a[1]) / l;
      return o;
    }
    d -= seg[i];
  }
  return pts[pts.length - 1].slice();
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
function polyBox(poly, pad = 0) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
/** Closed smooth outline through control points (Chaikin corner cutting). */
function smoothPoly(pts, iters = 2) {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const o = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = o;
  }
  return p;
}

// ---------------------------------------------------------------------------- drawing surface
const scratch = { n: 0, stamp: 0 };
function getScratch(n) {
  if (scratch.n < n) {
    scratch.n = n;
    scratch.id = new Int32Array(n);
    scratch.q = new Float32Array(n);
    scratch.t = new Float32Array(n);
    scratch.ox = new Float32Array(n);
    scratch.oy = new Float32Array(n);
    scratch.s = new Float32Array(n);
    scratch.list = new Int32Array(n);
  }
  return scratch;
}

/** Final shading shared by the lit primitives: light rig, soft silhouette darkening, depth dimming, tone curve. */
function shadeOut(out, alb, n, o, ao, alpha) {
  let c = lit(alb, n, o.gloss ?? 0.25, o.sheen ?? 0.12, ao);
  const e = o.edge ?? 0.22;
  if (e > 0 && n[2] < 0.5) c = mul3(c, 1 - e * (1 - smoothstep(0.0, 0.5, n[2])) * (n[1] < 0 ? 1 : 0.4));
  if (o.dim) c = mix3(mul3(c, 1 - o.dim * 0.55), [0.05, 0.14, 0.22], o.dim * 0.3);
  if (o.post) c = o.post(c);
  c = tone(c);
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  out[3] = alpha;
}

/**
 * A supersampled premultiplied RGBA surface addressed in model units. Samples use the same rotated
 * grid as core.shade(); primitives are composited per sample, so overlapping edges stay clean.
 */
class Painter {
  constructor(view, ss) {
    this.v = view;
    this.ss = ss;
    this.hw = view.W * ss;
    this.hh = view.H * ss;
    this.d = new Float32Array(this.hw * this.hh * 4);
    this.k = 1 / (view.S * ss);
    this.px = 1 / view.S; // one output pixel in model units
  }

  /** Run fn(x, y, out) over a model-space box. mode 0 = over, 1 = under, 2 = multiply existing colour. */
  region(x0, y0, x1, y1, fn, mode = 0) {
    const { hw, hh, ss, k, d, v } = this;
    const jit = 0.17 * k;
    const X0 = Math.max(0, Math.floor((x0 - v.x0) / k) - 1);
    const X1 = Math.min(hw - 1, Math.ceil((x1 - v.x0) / k) + 1);
    const Y0 = Math.max(0, Math.floor((v.y1 - y1) / k) - 1);
    const Y1 = Math.min(hh - 1, Math.ceil((v.y1 - y0) / k) + 1);
    const out = [0, 0, 0, 0];
    for (let Y = Y0; Y <= Y1; Y++) {
      const jx = (Y % ss) % 2 ? jit : -jit;
      const yb = v.y1 - (Y + 0.5) * k;
      let i = (Y * hw + X0) * 4;
      for (let X = X0; X <= X1; X++, i += 4) {
        if (mode === 1 && d[i + 3] >= 0.999) continue;
        const x = v.x0 + (X + 0.5) * k + jx;
        const y = yb + ((X % ss) % 2 ? jit : -jit);
        out[3] = 0;
        if (fn(x, y, out) === false) continue;
        const a = out[3];
        if (!(a > 0)) continue;
        if (mode === 0) {
          const q = 1 - a;
          d[i] = out[0] * a + d[i] * q;
          d[i + 1] = out[1] * a + d[i + 1] * q;
          d[i + 2] = out[2] * a + d[i + 2] * q;
          d[i + 3] = a + d[i + 3] * q;
        } else if (mode === 1) {
          const q = (1 - d[i + 3]) * a;
          d[i] += out[0] * q;
          d[i + 1] += out[1] * q;
          d[i + 2] += out[2] * q;
          d[i + 3] += q;
        } else {
          d[i] *= 1 + (out[0] - 1) * a;
          d[i + 1] *= 1 + (out[1] - 1) * a;
          d[i + 2] *= 1 + (out[2] - 1) * a;
        }
      }
    }
    return this;
  }

  /**
   * Lit height field. zf(x, y) -> thickness toward the viewer (<= 0 outside);
   * mat(x, y, z, n) -> albedo (n may be nudged for bump detail).
   */
  field(box, zf, mat, o = {}) {
    const e = o.e ?? this.px;
    const relief = o.relief ?? 1;
    const aoF = typeof o.ao === 'function' ? o.ao : null;
    const alF = typeof o.alpha === 'function' ? o.alpha : null;
    return this.region(box[0], box[1], box[2], box[3], (x, y, out) => {
      const z = zf(x, y);
      if (!(z > 0)) return false;
      const zx = (Math.max(0, zf(x + e, y)) - Math.max(0, zf(x - e, y))) / (2 * e);
      const zy = (Math.max(0, zf(x, y + e)) - Math.max(0, zf(x, y - e))) / (2 * e);
      const n = norm3([-zx * relief, -zy * relief, 1]);
      const alb = mat(x, y, z, n);
      if (!alb) return false;
      shadeOut(out, alb, n, o, aoF ? aoF(x, y, z) : o.ao ?? 1, alF ? alF(x, y, z) : o.alpha ?? 1);
      return true;
    }, o.mode ?? 0);
  }

  /** Lit ellipsoid. mat(u, v, x, y, n) with u, v in -1..1 along the (rotated) axes. */
  blob(cx, cy, rx, ry, rot, mat, o = {}) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const R = Math.max(rx, ry);
    const rz = o.rz ?? Math.min(rx, ry);
    const aoF = typeof o.ao === 'function' ? o.ao : null;
    return this.region(cx - R, cy - R, cx + R, cy + R, (x, y, out) => {
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * c + dy * s) / rx;
      const w = (-dx * s + dy * c) / ry;
      const q = u * u + w * w;
      if (q >= 1) return false;
      const lx = u / rx;
      const ly = w / ry;
      const lz = Math.sqrt(1 - q) / rz;
      const n = norm3([lx * c - ly * s, lx * s + ly * c, lz]);
      const alb = mat(u, w, x, y, n);
      if (!alb) return false;
      shadeOut(out, alb, n, o, aoF ? aoF(u, w) : o.ao ?? 1, o.alpha ?? 1);
      return true;
    });
  }

  /**
   * Round tapered tube through pts [[x, y, r], ...] (union of cone segments, so joints are seamless
   * even when translucent). mat(t, s, x, y, n): t 0..1 along the arc length, s -1..1 across (+ on the
   * left of the direction of travel). Options: gloss, sheen, ao (number | fn(t, s)), alpha
   * (number | fn(t, s)), round (0..1 cross-section roundness), raw (mat returns final [r,g,b,(a)]).
   */
  tube(pts, mat, o = {}) {
    const { hw, hh, ss, k, d, v } = this;
    const sc = getScratch(hw * hh);
    const id = ++scratch.stamp;
    const rmin = (o.minPx ?? 0.55) * ss;
    const nseg = pts.length - 1;
    const cum = [0];
    for (let q = 0; q < nseg; q++) cum.push(cum[q] + Math.hypot(pts[q + 1][0] - pts[q][0], pts[q + 1][1] - pts[q][1]));
    const total = cum[nseg] || 1;
    let n = 0;
    for (let q = 0; q < nseg; q++) {
      const ax = (pts[q][0] - v.x0) / k;
      const ay = (v.y1 - pts[q][1]) / k;
      const ar = Math.max(rmin, pts[q][2] / k);
      const bx = (pts[q + 1][0] - v.x0) / k;
      const by = (v.y1 - pts[q + 1][1]) / k;
      const br = Math.max(rmin, pts[q + 1][2] / k);
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const len = Math.sqrt(l2) || 1e-6;
      const R = Math.max(ar, br) + 1;
      const Y0 = Math.max(0, Math.floor(Math.min(ay, by) - R));
      const Y1 = Math.min(hh - 1, Math.ceil(Math.max(ay, by) + R));
      const ta = cum[q] / total;
      const tb = cum[q + 1] / total;
      for (let Y = Y0; Y <= Y1; Y++) {
        const yc = Y + 0.5;
        let t0 = 0;
        let t1 = 1;
        if (Math.abs(dy) > 1e-6) {
          const u0 = (yc - R - ay) / dy;
          const u1 = (yc + R - ay) / dy;
          t0 = Math.max(0, Math.min(u0, u1));
          t1 = Math.min(1, Math.max(u0, u1));
          if (t0 > t1) continue;
        } else if (Math.abs(yc - ay) > R) continue;
        const xa = ax + dx * t0;
        const xb = ax + dx * t1;
        const X0 = Math.max(0, Math.floor(Math.min(xa, xb) - R));
        const X1 = Math.min(hw - 1, Math.ceil(Math.max(xa, xb) + R));
        const jx = (Y % ss) % 2 ? 0.17 : -0.17;
        for (let X = X0; X <= X1; X++) {
          const sx = X + 0.5 + jx;
          const sy = yc + ((X % ss) % 2 ? -0.17 : 0.17);
          let t = l2 > 0 ? ((sx - ax) * dx + (sy - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ox = sx - ax - dx * t;
          const oy = sy - ay - dy * t;
          const r = ar + (br - ar) * t;
          const d2 = ox * ox + oy * oy;
          if (d2 >= r * r) continue;
          const qn = Math.sqrt(d2) / r;
          const idx = Y * hw + X;
          if (sc.id[idx] !== id) {
            sc.id[idx] = id;
            sc.list[n++] = idx;
          } else if (qn >= sc.q[idx]) continue;
          sc.q[idx] = qn;
          sc.t[idx] = ta + (tb - ta) * t;
          sc.ox[idx] = ox / r;
          sc.oy[idx] = oy / r;
          sc.s[idx] = (ox * dy - oy * dx) / (len * r);
        }
      }
    }
    const round = o.round ?? 1;
    const aoF = typeof o.ao === 'function' ? o.ao : null;
    const alF = typeof o.alpha === 'function' ? o.alpha : null;
    const out = [0, 0, 0, 0];
    const jit = 0.17;
    // true radius along the tube, to fade hair-thin tubes instead of letting them alias
    const radAt = (t) => {
      const dd = t * total;
      let q = 0;
      while (q < nseg - 1 && cum[q + 1] < dd) q++;
      const f = cum[q + 1] > cum[q] ? (dd - cum[q]) / (cum[q + 1] - cum[q]) : 0;
      return (pts[q][2] + (pts[q + 1][2] - pts[q][2]) * clamp(f)) / k;
    };
    for (let m = 0; m < n; m++) {
      const idx = sc.list[m];
      const X = idx % hw;
      const Y = (idx - X) / hw;
      const x = v.x0 + (X + 0.5 + ((Y % ss) % 2 ? jit : -jit)) * k;
      const y = v.y1 - (Y + 0.5 + ((X % ss) % 2 ? -jit : jit)) * k;
      const t = sc.t[idx];
      const s = sc.s[idx];
      const qn = sc.q[idx];
      let al = alF ? alF(t, s) : o.alpha ?? 1;
      const rt = radAt(t);
      if (rt < rmin) al *= Math.max(0.12, rt / rmin);
      if (!(al > 0)) continue;
      if (o.raw) {
        const c = mat(t, s, x, y, qn);
        if (!c) continue;
        out[0] = c[0];
        out[1] = c[1];
        out[2] = c[2];
        out[3] = al * (c.length > 3 ? c[3] : 1);
      } else {
        const nrm = norm3([sc.ox[idx] * round, -sc.oy[idx] * round, Math.sqrt(Math.max(0.0004, 1 - qn * qn * round * round))]);
        const alb = mat(t, s, x, y, nrm);
        if (!alb) continue;
        shadeOut(out, alb, nrm, o, aoF ? aoF(t, s) : o.ao ?? 1, al);
      }
      const a = out[3];
      const i = idx * 4;
      const q = 1 - a;
      d[i] = out[0] * a + d[i] * q;
      d[i + 1] = out[1] * a + d[i + 1] * q;
      d[i + 2] = out[2] * a + d[i + 2] * q;
      d[i + 3] = a + d[i + 3] * q;
    }
    return this;
  }

  /**
   * Lit height field seen from slightly above (rays, sea stars). Body frame: X forward (= screen x),
   * Z lateral (+ toward the viewer), Y up; the camera is raised by `el`, so a body point lands at
   * screen (X + o.x0, o.y0 + Y cos(el) - Z sin(el)). h(X, Z) -> surface height; it must be continuous
   * and defined everywhere (extend it smoothly past the outline). The visible point is the first
   * crossing of the view ray with the surface between hmax and hmin; it is kept when o.inside(X, Z)
   * holds (default: always). mat(X, Z, Y, n) -> albedo.
   */
  oblique(box, el, h, hmin, hmax, mat, o = {}) {
    const ce = Math.cos(el);
    const se = Math.sin(el);
    const steps = o.steps ?? 8;
    const e = o.e ?? this.px;
    const ox = o.x0 ?? 0;
    const oy = o.y0 ?? 0;
    const inside = o.inside ?? null;
    const bound = o.bound ?? null; // optional cheap screen-space reject
    const aoF = typeof o.ao === 'function' ? o.ao : null;
    return this.region(box[0], box[1], box[2], box[3], (x, y, out) => {
      if (bound && !bound(x, y)) return false;
      const X = x - ox;
      const sy = y - oy;
      const zNear = (hmax * ce - sy) / se;
      const zFar = (hmin * ce - sy) / se;
      let za = zNear;
      let zb = zNear;
      let hit = false;
      for (let i = 0; i <= steps; i++) {
        zb = zNear + ((zFar - zNear) * i) / steps;
        if ((sy + zb * se) / ce - h(X, zb) <= 0) {
          hit = true;
          break;
        }
        za = zb;
      }
      if (!hit) return false;
      if (za !== zb)
        for (let i = 0; i < 8; i++) {
          const zm = (za + zb) / 2;
          if ((sy + zm * se) / ce - h(X, zm) <= 0) zb = zm;
          else za = zm;
        }
      const Z = zb;
      if (inside && !inside(X, Z)) return false;
      const Y = (sy + Z * se) / ce;
      let n;
      if (o.flat) n = [0, ce, se];
      else {
        const hx = (h(X + e, Z) - h(X - e, Z)) / (2 * e);
        const hz = (h(X, Z + e) - h(X, Z - e)) / (2 * e);
        const nb = norm3([-hx, 1, -hz]);
        n = norm3([nb[0], nb[1] * ce - nb[2] * se, Math.max(0.03, nb[1] * se + nb[2] * ce)]);
      }
      const alb = mat(X, Z, Y, n);
      if (!alb) return false;
      shadeOut(out, alb, n, o, aoF ? aoF(X, Z, Y) : o.ao ?? 1, o.alpha ?? 1);
      return true;
    }, o.mode ?? 0);
  }

  /** Filled polygon; fn(x, y, edgeDist, out) writes straight-alpha colour. */
  poly(pts, fn, mode = 0) {
    const b = polyBox(pts, this.px);
    return this.region(b[0], b[1], b[2], b[3], (x, y, out) => {
      if (!inPoly(pts, x, y)) return false;
      return fn(x, y, polyDist(pts, x, y), out);
    }, mode);
  }

  /** Soft round glow / haze (unlit). */
  glow(cx, cy, rx, ry, col, alpha, power = 2, mode = 0) {
    return this.region(cx - rx, cy - ry, cx + rx, cy + ry, (x, y, out) => {
      const q = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (q >= 1) return false;
      out[0] = col[0];
      out[1] = col[1];
      out[2] = col[2];
      out[3] = alpha * Math.pow(1 - q, power);
      return true;
    }, mode);
  }

  /** Multiply what is already drawn by 1 - k * fn(x, y) (contact shadows, grime). */
  darken(box, fn, tint = [0, 0, 0]) {
    return this.region(box[0], box[1], box[2], box[3], (x, y, out) => {
      const kk = fn(x, y);
      if (!(kk > 0)) return false;
      out[0] = tint[0];
      out[1] = tint[1];
      out[2] = tint[2];
      out[3] = Math.min(1, kk);
      return true;
    }, 2);
  }

  /**
   * Glossy bead eye. o: iris (linear rgb), pupil 'round' | 'w' | 'bar' | 'all', pr pupil radius 0..1,
   * socket (darkening ring strength on what is already drawn).
   */
  eye(cx, cy, r, o = {}) {
    const iris = o.iris ?? [0.78, 0.62, 0.3];
    const pr = o.pr ?? 0.56;
    const kind = o.pupil ?? 'round';
    const seed = o.seed ?? 1;
    if (o.socket) this.darken([cx - r * 1.5, cy - r * 1.5, cx + r * 1.5, cy + r * 1.5], (x, y) => o.socket * smoothstep(1.45, 0.95, Math.hypot(x - cx, y - cy) / r));
    return this.region(cx - r, cy - r, cx + r, cy + r, (x, y, out) => {
      const ex = (x - cx) / r;
      const ey = (y - cy) / r;
      const ed = Math.hypot(ex, ey);
      if (ed >= 1) return false;
      const sphere = Math.sqrt(1 - ed * ed);
      let c = mix3(mul3(iris, 0.4), iris, smoothstep(1.0, 0.62, ed));
      c = mul3(c, 0.8 + 0.25 * vnoise(Math.atan2(ey, ex) * 9, ed * 5, seed));
      c = mul3(c, 0.7 + 0.5 * clamp(0.5 - ey * 0.5));
      let p = 0;
      if (kind === 'round') p = smoothstep(pr + 0.05, pr - 0.04, ed);
      else if (kind === 'all') p = smoothstep(0.98, 0.8, ed);
      else if (kind === 'bar') p = smoothstep(0.26, 0.16, Math.abs(ey)) * smoothstep(0.86, 0.7, Math.abs(ex));
      else if (kind === 'w') {
        // cuttlefish: a wavy W-shaped slit
        const yc = -0.08 + 0.21 * Math.cos(ex * 6.6);
        p = smoothstep(0.28, 0.17, Math.abs(ey - yc)) * smoothstep(0.86, 0.7, Math.abs(ex));
      }
      c = mix3(c, [0.008, 0.012, 0.022], p);
      c = mul3(c, 0.8 + 0.25 * sphere);
      const h1 = Math.hypot(ex + 0.26, ey - 0.34);
      c = mix3(c, [1.6, 1.6, 1.6], smoothstep(0.26, 0.1, h1));
      const h2 = Math.hypot(ex - 0.3, ey + 0.36);
      c = add3(c, mul3([0.25, 0.45, 0.6], smoothstep(0.36, 0.06, h2) * 0.45));
      c = mul3(c, 1 - 0.35 * smoothstep(0.82, 1.0, ed));
      c = tone(c);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = 1;
      return true;
    });
  }

  /** Box-filter down to the output resolution. */
  resolve() {
    const { hw, ss, d, v } = this;
    const img = new Img(v.W, v.H);
    const inv = 1 / (ss * ss);
    for (let y = 0; y < v.H; y++)
      for (let x = 0; x < v.W; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < ss; j++) {
          let i = ((y * ss + j) * hw + x * ss) * 4;
          for (let q = 0; q < ss; q++, i += 4) {
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            a += d[i + 3];
          }
        }
        const o = (y * v.W + x) * 4;
        img.d[o] = r * inv;
        img.d[o + 1] = g * inv;
        img.d[o + 2] = b * inv;
        img.d[o + 3] = a * inv;
      }
    return img;
  }
}

// ---------------------------------------------------------------------------- image helpers
/** Multiply an image by a per-pixel factor fn(px, py) (pixel centres), returning a new image. */
function masked(img, fn) {
  const o = new Img(img.w, img.h);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const k = fn(x + 0.5, y + 0.5);
      if (!(k > 0)) continue;
      const i = (y * img.w + x) * 4;
      o.d[i] = img.d[i] * k;
      o.d[i + 1] = img.d[i + 1] * k;
      o.d[i + 2] = img.d[i + 2] * k;
      o.d[i + 3] = img.d[i + 3] * k;
    }
  return o;
}
/**
 * Split an image into a front and a back piece that composite back to the original exactly
 * (also where it is translucent). k(px, py) = 1 where a pixel belongs to the front piece.
 */
function split(img, kf) {
  const front = new Img(img.w, img.h);
  const back = new Img(img.w, img.h);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const a = img.d[i + 3];
      if (a <= 0) continue;
      const k = clamp(kf(x + 0.5, y + 0.5));
      const den = 1 - k * a;
      const kb = k >= 1 ? 0 : den > 1e-4 ? (1 - k) / den : 1;
      for (let c = 0; c < 4; c++) {
        front.d[i + c] = img.d[i + c] * k;
        back.d[i + c] = img.d[i + c] * kb;
      }
    }
  return [front, back];
}

/** Blurred dark copy of an image's silhouette, to sit behind it as a soft contact shadow. */
function dropShadow(img, dx, dy, radius, alpha) {
  const s = new Img(img.w, img.h);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
      const a = img.d[(sy * img.w + sx) * 4 + 3] * alpha;
      const i = (y * img.w + x) * 4;
      s.d[i] = 0.01 * a;
      s.d[i + 1] = 0.03 * a;
      s.d[i + 2] = 0.06 * a;
      s.d[i + 3] = a;
    }
  return blur(s, radius);
}
/** a over b (same size), returning a new image. */
function stack(bottom, top) {
  return over(bottom.clone(), top);
}

// ---------------------------------------------------------------------------- rig assembly
class Rig {
  /**
   * @param lenPx authored pixels per body length (opts.px overrides it)
   * @param ext   [x0, y0, x1, y1] drawing area in model units around the origin (generous; parts are cropped)
   * @param span  model units that make up one body length (1 unless the drawing overshoots the unit box)
   */
  constructor(id, opts, lenPx, ext, span = 1) {
    this.id = id;
    this.sp = BY_ID.get(id);
    this.lenPx = opts.px ?? lenPx;
    this.S = this.lenPx / span; // pixels per model unit
    this.ss = opts.ss ?? 3;
    const S = this.S;
    const L = Math.ceil(-ext[0] * S) + 2;
    const R = Math.ceil(ext[2] * S) + 2;
    const U = Math.ceil(ext[3] * S) + 2;
    const D = Math.ceil(-ext[1] * S) + 2;
    this.view = { S, x0: -L / S, y1: U / S, W: L + R, H: U + D, ox: L, oy: U };
    this.parts = [];
    this.seed = hashStr(id) & 0xffff;
    this.rnd = rng(hashStr(id));
    const pal = this.sp.palette.map(hex);
    this.A = pal[0];
    this.B = pal[1];
    this.C = pal[2];
    this.px = 1 / S;
  }
  layer() {
    return new Painter(this.view, this.ss);
  }
  /** Model position -> pixel position on the shared canvas. */
  toPx(p) {
    return [this.view.ox + p[0] * this.S, this.view.oy - p[1] * this.S];
  }
  /** Add a part from a Painter or a full-canvas Img. pivot is in model units. */
  add(src, pivot, anim = null) {
    const img = src instanceof Painter ? src.resolve() : src;
    const b = bounds(img, 0.004);
    if (!b) return this;
    if (process.env.CRITTER_DEBUG && (b.x0 <= 0 || b.y0 <= 0 || b.x1 >= img.w - 1 || b.y1 >= img.h - 1)) console.warn(`${this.id}: part ${this.parts.length} touches the canvas edge`);
    const m = 3;
    const x0 = Math.max(0, b.x0 - m);
    const y0 = Math.max(0, b.y0 - m);
    const x1 = Math.min(img.w - 1, b.x1 + m);
    const y1 = Math.min(img.h - 1, b.y1 + m);
    const part = crop(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    const pp = this.toPx(pivot);
    const ppx = Math.round(pp[0]);
    const ppy = Math.round(pp[1]);
    this.parts.push({ img: part, pivot: [ppx - x0, ppy - y0], at: [ppx - this.view.ox, ppy - this.view.oy], anim });
    return this;
  }
  done(anchor) {
    return { lenPx: this.lenPx, anchor, parts: this.parts };
  }
}

/** Soft contact shadow so seabed animals look seated on any ground (reaches about `depth` below y = 0). */
function groundShadow(P, cx, hw, depth = 0.02, alpha = 0.34) {
  P.region(cx - hw, -depth, cx + hw, depth, (x, y, out) => {
    const q = Math.hypot((x - cx) / hw, (y + depth * 0.05) / (depth * 0.95));
    if (q >= 1) return false;
    out[0] = 0.01;
    out[1] = 0.03;
    out[2] = 0.06;
    out[3] = alpha * Math.pow(1 - q * q, 1.2);
    return true;
  });
}

/**
 * 0 below a gently curved base line, 1 a little above it: multiplies a height field so a mound or
 * column gets a rounded bottom edge that dips a few pixels under the ground line in the middle.
 */
const seat = (x, y, hw, d = 0.022) => smoothstep(0, 0.014, y + d * Math.sqrt(Math.max(0, 1 - (x / hw) * (x / hw))));

// Phase offsets (radians, as the device adds them inside sin()) that spread 2..5 parts evenly over a cycle.
const PH2 = [0, PI];
const PH3 = [0, TAU / 3, (2 * TAU) / 3];
const PH4 = [0, PI / 2, PI, (3 * PI) / 2];
const PH5 = [0, 1, 2, 3, 4].map((k) => (k * TAU * 2) / 5 % TAU); // neighbours two steps apart

// ---------------------------------------------------------------------------- the animals
const BUILDERS = {};

// ---- reef crab -------------------------------------------------------------------------------
BUILDERS.reefCrab = (id, opts) => {
  const R = new Rig(id, opts, 240, [-0.62, -0.06, 0.62, 0.66]);
  const { A, B, C, seed, S } = R;
  const shell = (x, y) => {
    const n = organic(x * 7, y * 7, seed, 4) * 0.7 + organic(x * 19, y * 19, seed + 5, 2) * 0.3;
    let c = mix3(A, B, smoothstep(0.5, 0.68, n) * 0.6);
    c = mix3(c, C, smoothstep(0.48, 0.3, n) * 0.55);
    return c;
  };
  const legMat = (dark) => (t, s) => {
    let c = mix3(A, B, 0.1 + 0.4 * smoothstep(0.2, -0.8, s));
    c = mix3(c, C, 0.2 * dark + 0.75 * smoothstep(0.82, 1.0, t));
    // joints
    const j = Math.min(Math.abs(t - 0.4), Math.abs(t - 0.74));
    c = mul3(c, 1 - 0.4 * smoothstep(0.03, 0.0, j));
    return c;
  };
  const leg = (P, side, i, far) => {
    const hip = [side * (0.2 + 0.02 * i), 0.13 + 0.025 * i];
    const knee = [side * (0.36 + 0.035 * i - (i === 3 ? 0.05 : 0)), 0.19 + 0.045 * i];
    const tip = [side * (0.41 + 0.04 * i - (i === 3 ? 0.04 : 0)), 0.0 + 0.012 * i * i];
    const ank = [lerp(knee[0], tip[0], 0.62) + side * 0.035, lerp(knee[1], tip[1], 0.62)];
    const k = 1 - 0.06 * i;
    const pts = spline([[...hip, 0.02 * k], [lerp(hip[0], knee[0], 0.55), lerp(hip[1], knee[1], 0.6) + 0.012, 0.027 * k], [...knee, 0.02 * k], [lerp(knee[0], ank[0], 0.5), lerp(knee[1], ank[1], 0.5), 0.021 * k], [...ank, 0.015 * k], [...tip, 0.004]], 6);
    P.tube(pts, legMat(far), { gloss: 0.35, sheen: 0.14, ao: (t) => 0.45 + 0.55 * smoothstep(0.0, 0.35, t), dim: far ? 0.5 : 0.12 });
  };
  // two alternating leg sets (bob in anti-phase = a scuttle)
  const legsA = R.layer();
  const legsB = R.layer();
  for (let i = 3; i >= 0; i--) {
    leg(i % 2 ? legsA : legsB, -1, i, i >= 2 ? 1 : 0);
    leg(i % 2 ? legsB : legsA, 1, i, i >= 2 ? 1 : 0);
  }
  // ---- body
  const body = R.layer();
  groundShadow(body, 0, 0.36, 0.022, 0.3);
  const cy = 0.215;
  const rx = 0.3;
  const ry = 0.135;
  const rimY = (x) => 0.168 + 0.085 * Math.pow(Math.abs(x) / rx, 1.8);
  const zf = (x, y) => {
    const v = (y - cy) / ry;
    const wf = 1 - 0.2 * smoothstep(0.1, -1, v);
    const u = x / (rx * wf);
    const q = Math.pow(Math.abs(u), 2.4) + Math.pow(Math.abs(v), 2.2);
    if (q >= 1) return -1;
    let z = 0.16 * Math.pow(1 - q, 0.5);
    const dr = y - rimY(x);
    // raised frontal rim with scalloped teeth toward the sides, face receding below it
    const teeth = 0.45 + 0.55 * Math.pow(Math.abs(Math.sin(Math.abs(x) * 46 + 0.6)), 0.7) * smoothstep(0.02, 0.05, Math.abs(Math.abs(x) - 0.085));
    z += 0.02 * gauss(dr, 0.012) * teeth;
    z -= 0.016 * smoothstep(0.0, -0.05, dr);
    // gentle lobes on the back
    z += 0.008 * Math.cos(x * 30) * smoothstep(0.0, 0.08, dr) * smoothstep(0.3, 0.1, Math.abs(x));
    return z;
  };
  body.field([-rx - 0.01, cy - ry - 0.01, rx + 0.01, cy + ry + 0.01], zf, (x, y, z, n) => {
    const dr = y - rimY(x);
    let c;
    if (dr > 0) {
      c = shell(x, y);
      // pale tubercles
      const w = worley(x * 34, y * 34, seed + 2);
      c = mix3(c, B, smoothstep(0.2, 0.08, w.f1) * 0.55);
      // H-shaped groove
      const gr = Math.min(Math.abs(Math.abs(x) - 0.07 - 0.03 * Math.sin((y - cy) * 30)) + smoothstep(0.02, 0.1, Math.abs(y - 0.265)) * 0.05, Math.abs(y - 0.262) + smoothstep(0.05, 0.08, Math.abs(x)) * 0.05);
      c = mul3(c, 1 - 0.3 * smoothstep(0.012, 0.002, gr));
      c = mul3(c, 0.86 + 0.2 * smoothstep(0.0, 0.1, dr));
    } else {
      // face: paler, with the two mouth plates
      c = mix3(B, A, 0.1 + 0.25 * organic(x * 20, y * 20, seed + 8, 2));
      c = mix3(c, [1.0, 0.8, 0.62], 0.4);
      // mouth frame: two plates meeting in the middle, sunk a little below the rim
      const plate = smoothstep(0.062, 0.05, Math.abs(x)) * smoothstep(0.09, 0.105, y) * smoothstep(-0.008, -0.02, dr);
      c = mix3(c, mix3(A, B, 0.55), plate * 0.75);
      c = mul3(c, 1 - 0.35 * smoothstep(0.005, 0.001, Math.abs(x)) * plate);
      c = mul3(c, 1 - 0.2 * smoothstep(0.016, 0.004, Math.abs(Math.abs(x) - 0.058)) * smoothstep(0.085, 0.1, y) * smoothstep(0.0, -0.02, dr));
      const fw = worley(x * 55, y * 55, seed + 12);
      c = mul3(c, 0.93 + 0.1 * smoothstep(0.1, 0.35, fw.f1));
      c = mul3(c, 0.66 + 0.3 * smoothstep(-0.09, -0.01, dr));
      nudge(n, 0, 0.75 * smoothstep(0.0, -0.03, dr));
    }
    return c;
  }, { gloss: 0.42, sheen: 0.16, ao: (x, y) => 0.62 + 0.38 * smoothstep(0.08, 0.2, y) });
  // eye stalks
  for (const side of [-1, 1]) {
    const bx = side * 0.085;
    body.darken([bx - 0.04, 0.15, bx + 0.04, 0.23], (x, y) => 0.45 * smoothstep(0.03, 0.008, Math.hypot(x - bx, (y - rimY(bx) - 0.004) * 1.4)));
    const ry0 = rimY(bx);
    body.tube([[bx, ry0 - 0.002, 0.016], [bx + side * 0.003, ry0 + 0.02, 0.014], [bx + side * 0.006, ry0 + 0.04, 0.015]], () => mix3(A, B, 0.35), { gloss: 0.3 });
    body.eye(bx + side * 0.008, ry0 + 0.054, 0.0235, { pupil: 'all', iris: [0.2, 0.08, 0.04] });
  }
  // ---- claws
  const claw = (side, k, tilt) => {
    const P = R.layer();
    const sh = [side * 0.17, 0.125];
    const el = [side * 0.305, 0.135];
    const wr = [side * 0.335, 0.215];
    const cMat = (t, s) => mix3(shell(t * 0.4 + side, s * 0.1), B, 0.3 * smoothstep(0.3, -0.9, s * side));
    P.tube(spline([[...sh, 0.034], [lerp(sh[0], el[0], 0.6), sh[1] - 0.012, 0.042], [...el, 0.04], [lerp(el[0], wr[0], 0.5) + side * 0.012, lerp(el[1], wr[1], 0.5), 0.04], [...wr, 0.038]], 6), cMat, {
      gloss: 0.4, ao: (t) => 0.5 + 0.5 * smoothstep(0, 0.3, t),
    });
    // palm + fingers as one height field in the claw's own frame (a: along the claw, b: across)
    const pc = [wr[0] + side * 0.005, wr[1] + 0.095 * k];
    const ang = PI / 2 + side * tilt; // direction the claw points
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const L = 0.3 * k;
    const local = (x, y) => {
      const dx = x - pc[0];
      const dy = y - pc[1];
      return [dx * ca + dy * sa, (-dx * sa + dy * ca) * side];
    };
    const zc = (x, y) => {
      const [a, b] = local(x, y);
      // palm
      const qp = Math.pow((a + 0.005) / (0.125 * k), 2) + Math.pow((b - 0.004) / (0.088 * k), 2);
      let z = qp < 1 ? 0.085 * k * Math.sqrt(1 - qp) : -1;
      // fingers: b < 0 is the inner (fixed) finger, b > 0 the outer movable one curving over it
      const f = (a - 0.07 * k) / (L - 0.11 * k);
      if (f > -0.2 && f < 1) {
        const ff = clamp(f);
        const c1 = (-0.036 + 0.012 * ff * ff) * k;
        const w1 = 0.036 * k * Math.pow(1 - ff, 0.75) + 0.002;
        const c2 = (0.04 - 0.05 * ff * ff) * k;
        const w2 = 0.034 * k * Math.pow(1 - ff, 0.7) + 0.002;
        const q1 = Math.abs(b - c1) / w1;
        const q2 = Math.abs(b - c2) / w2;
        const fin = smoothstep(-0.2, 0.05, f);
        if (q1 < 1) z = Math.max(z, w1 * 1.3 * Math.sqrt(1 - q1 * q1) * fin);
        if (q2 < 1) z = Math.max(z, w2 * 1.4 * Math.sqrt(1 - q2 * q2) * fin + 0.004);
      }
      return z;
    };
    const ext = 0.34 * k;
    P.field([pc[0] - ext, pc[1] - ext * 0.6, pc[0] + ext, pc[1] + ext], zc, (x, y) => {
      const [a, b] = local(x, y);
      let c = shell(x * 1.3 + 2, y * 1.3);
      c = mix3(c, B, 0.55 * smoothstep(0.01, -0.07, b) * smoothstep(0.12, 0.0, a));
      const f = (a - 0.07 * k) / (L - 0.11 * k);
      c = mix3(c, mul3(C, 0.75), smoothstep(0.45, 0.8, f));
      const w = worley(x * 40, y * 40, seed + 4);
      c = mix3(c, B, smoothstep(0.18, 0.06, w.f1) * 0.4 * smoothstep(0.5, 0.2, f));
      return c;
    }, { gloss: 0.5, sheen: 0.18 });
    return [P, sh];
  };
  const [cl, shL] = claw(-1, 0.94, 0.2);
  const [cr, shR] = claw(1, 1.0, 0.26);
  const sc = S / 240;
  R.add(legsA, [0, 0.14], { kind: 'bob', amp: 1.5 * sc, rate: 1.8, phase: PH2[0] });
  R.add(legsB, [0, 0.14], { kind: 'bob', amp: 1.5 * sc, rate: 1.8, phase: PH2[1] });
  R.add(body, [0, 0.2], null);
  R.add(cl, shL, { kind: 'flap', amp: 5, rate: 0.45, phase: PH2[0] });
  R.add(cr, shR, { kind: 'flap', amp: 6, rate: 0.45, phase: PH2[1] });
  return R.done('base');
};

// ---- sea stars (seen resting on a slope that faces the viewer) --------------------------------
const STAR_SE = 0.6;
const STAR_EL = Math.asin(STAR_SE);
/** Height field of a star: arms are tapered capsules [[x, z, r], ...] in the top view, joined to a disc. */
function starHeight(arms, discR, discH, kH, web = 0.012) {
  for (const a of arms) {
    a.x0 = 1e9; a.x1 = -1e9; a.z0 = 1e9; a.z1 = -1e9;
    for (const p of a.pts) {
      a.x0 = Math.min(a.x0, p[0] - p[2] * 1.6);
      a.x1 = Math.max(a.x1, p[0] + p[2] * 1.6);
      a.z0 = Math.min(a.z0, p[1] - p[2] * 1.6);
      a.z1 = Math.max(a.z1, p[1] + p[2] * 1.6);
    }
  }
  return (X, Z) => {
    const dc = Math.hypot(X, Z) / discR;
    let v = dc < 1 ? discH * Math.sqrt(1 - dc * dc) : -(dc - 1) * discR * 2;
    for (const a of arms) {
      if (X < a.x0 || X > a.x1 || Z < a.z0 || Z > a.z1) continue;
      for (let i = 0; i < a.pts.length - 1; i++) {
        const p = a.pts[i];
        const q = a.pts[i + 1];
        const [d, t] = segDist(X, Z, p[0], p[1], q[0], q[1]);
        const r = p[2] + (q[2] - p[2]) * t;
        const sN = d / r;
        const hh = sN < 1 ? kH * r * Math.sqrt(1 - sN * sN) : -(sN - 1) * r * 2;
        v = smax(v, hh, web);
      }
    }
    return v;
  };
}
/** Cut a rendered star into a centre piece (front) and arm groups (behind it) that sway. */
function starParts(R, img, yc, armAngles, groupOf, r0, r1, pivR, anims) {
  const S = R.S;
  const top = (px, py) => [(px - R.view.ox) / S, -((R.view.oy - py) / S - yc) / STAR_SE];
  const [front, back] = split(img, (px, py) => {
    const [X, Z] = top(px, py);
    return smoothstep(r1, r0, Math.hypot(X, Z));
  });
  const nearest = (px, py) => {
    const [X, Z] = top(px, py);
    const a = Math.atan2(Z, X);
    let best = 0;
    let bd = 9;
    for (let i = 0; i < armAngles.length; i++) {
      const d = Math.abs(Math.atan2(Math.sin(a - armAngles[i]), Math.cos(a - armAngles[i])));
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const groups = Math.max(...armAngles.map((_, i) => groupOf(i))) + 1;
  for (let g = 0; g < groups; g++) {
    const part = masked(back, (px, py) => (groupOf(nearest(px, py)) === g ? 1 : 0));
    const piv = pivR === 0 ? [0, yc] : [Math.cos(armAngles[g]) * pivR, yc - Math.sin(armAngles[g]) * pivR * STAR_SE];
    R.add(part, piv, anims[g]);
  }
  R.add(front, [0, yc], null);
}

BUILDERS.blueStar = (id, opts) => {
  const R = new Rig(id, opts, 220, [-0.58, -0.08, 0.58, 0.72]);
  const { A, B, C, seed, rnd, S } = R;
  const yc = 0.3;
  const angles = [];
  const arms = [];
  for (let i = 0; i < 5; i++) {
    const th = -PI / 2 + 0.22 + (i * TAU) / 5 + (rnd() - 0.5) * 0.14;
    angles.push(th);
    const len = 0.47 * (0.92 + 0.12 * rnd());
    const bend = (rnd() - 0.5) * 0.11;
    const cx = Math.cos(th);
    const cz = Math.sin(th);
    arms.push({
      pts: [
        [0, 0, 0.062],
        [cx * len * 0.5 - cz * bend, cz * len * 0.5 + cx * bend, 0.054],
        [cx * len * 0.82 - cz * bend * 0.8, cz * len * 0.82 + cx * bend * 0.8, 0.045],
        [cx * len, cz * len, 0.034],
      ],
    });
  }
  const h = starHeight(arms, 0.085, 0.05, 0.86, 0.014);
  const P = R.layer();
  P.oblique([-0.56, -0.04, 0.56, 0.7], STAR_EL, h, 0, 0.06, (X, Z, Y, n) => {
    const w = worley(X * 85, Z * 85, seed);
    let c = mix3(A, C, 0.55 * smoothstep(0.03, 0.004, Y) + 0.25 * organic(X * 9, Z * 9, seed + 3, 3));
    c = mix3(c, B, smoothstep(0.3, 0.1, w.f1) * 0.4);
    nudge(n, (w.px - X * 85) * 0.14, -(w.py - Z * 85) * 0.1);
    return saturate(c, 1.08);
  }, { y0: yc, gloss: 0.3, sheen: 0.2, steps: 8, ao: (X, Z, Y) => 0.55 + 0.45 * smoothstep(0.0, 0.03, Y) });
  let img = P.resolve();
  img = stack(dropShadow(img, 0, Math.round(S * 0.012), S * 0.012, 0.42), img);
  starParts(R, img, yc, angles, (i) => i, 0.1, 0.135, 0.12, PH5.map((ph) => ({ kind: 'sway', amp: 2.4, rate: 0.22, phase: ph })));
  return R.done('base');
};

BUILDERS.crownStar = (id, opts) => {
  const R = new Rig(id, opts, 280, [-0.6, -0.08, 0.6, 0.78]);
  const { A, B, C, seed, rnd, S } = R;
  const yc = 0.305;
  const NA = 14;
  const angles = [];
  const arms = [];
  for (let i = 0; i < NA; i++) {
    const th = -PI / 2 + 0.1 + (i * TAU) / NA + (rnd() - 0.5) * 0.1;
    angles.push(th);
    const len = 0.455 * (0.9 + 0.14 * rnd());
    const bend = (rnd() - 0.5) * 0.06;
    const cx = Math.cos(th);
    const cz = Math.sin(th);
    arms.push({ pts: [[cx * 0.16, cz * 0.16, 0.062], [cx * len * 0.72 - cz * bend, cz * len * 0.72 + cx * bend, 0.046], [cx * len, cz * len, 0.026]] });
  }
  const h = starHeight(arms, 0.25, 0.062, 0.8, 0.02);
  const P = R.layer();
  const skin = (X, Z) => {
    const n = organic(X * 8, Z * 8, seed, 3);
    return mix3(mix3(A, B, 0.25 + 0.5 * smoothstep(0.4, 0.7, n)), mul3(A, 0.6), 0.4 * smoothstep(0.5, 0.3, n));
  };
  P.oblique([-0.58, -0.05, 0.58, 0.74], STAR_EL, h, 0, 0.07, (X, Z, Y, n) => {
    const w = worley(X * 60, Z * 60, seed + 1);
    let c = mix3(skin(X, Z), mul3(A, 0.5), 0.5 * smoothstep(0.03, 0.004, Y));
    c = mix3(c, B, smoothstep(0.32, 0.12, w.f1) * 0.3);
    nudge(n, (w.px - X * 60) * 0.2, -(w.py - Z * 60) * 0.14);
    return c;
  }, { y0: yc, gloss: 0.22, sheen: 0.14, steps: 8, ao: (X, Z, Y) => 0.5 + 0.5 * smoothstep(0.0, 0.035, Y) });
  // spines, far to near
  const spines = [];
  for (let k = 0; k < 2600 && spines.length < 330; k++) {
    const a = rnd() * TAU;
    const rr = Math.sqrt(rnd()) * 0.5;
    const X = Math.cos(a) * rr;
    const Z = Math.sin(a) * rr;
    const Y = h(X, Z);
    if (Y < 0.012) continue;
    if (spines.some((q) => Math.hypot(q.X - X, q.Z - Z) < 0.03)) continue;
    spines.push({ X, Z, Y, len: 0.04 + 0.022 * rnd(), lean: (rnd() - 0.5) * 0.3 });
  }
  spines.sort((p, q) => p.Z - q.Z);
  const ce = Math.cos(STAR_EL);
  const tipCol = C;
  for (const sp of spines) {
    const rr = Math.hypot(sp.X, sp.Z) || 1;
    const out = [(sp.X / rr) * 0.35 + sp.lean, (sp.Z / rr) * 0.35];
    const bx = sp.X;
    const by = yc + sp.Y * ce - sp.Z * STAR_SE;
    const tx = bx + out[0] * sp.len;
    const ty = by + sp.len * ce - out[1] * sp.len * STAR_SE;
    P.darken([bx - 0.02, by - 0.014, bx + 0.02, by + 0.012], (x, y) => 0.4 * smoothstep(1, 0.3, Math.hypot((x - bx) / 0.017, (y - by + 0.003) / 0.01)));
    P.tube([[bx, by - 0.002, 0.0085], [lerp(bx, tx, 0.5), lerp(by, ty, 0.5), 0.006], [tx, ty, 0.0018]], (t) => mix3(mix3(A, B, 0.5), tipCol, smoothstep(0.15, 0.7, t)), { gloss: 0.5, sheen: 0.2, ao: (t) => 0.6 + 0.4 * t, edge: 0.1 });
  }
  let img = P.resolve();
  img = stack(dropShadow(img, 0, Math.round(S * 0.012), S * 0.012, 0.42), img);
  starParts(R, img, yc, angles, (i) => i % 2, 0.27, 0.31, 0, [
    { kind: 'sway', amp: 1.3, rate: 0.2, phase: PH2[0] },
    { kind: 'sway', amp: 1.3, rate: 0.2, phase: PH2[1] },
  ]);
  return R.done('base');
};

BUILDERS.brittleStar = (id, opts) => {
  const R = new Rig(id, opts, 240, [-0.62, -0.08, 0.62, 0.7]);
  const { A, B, C, seed, rnd, S } = R;
  const yc = 0.255;
  const scr = (X, Z) => [X, yc - Z * STAR_SE];
  const layers = [];
  for (let i = 0; i < 5; i++) {
    const th = -PI / 2 + 0.3 + (i * TAU) / 5 + (rnd() - 0.5) * 0.2;
    const a1 = (rnd() < 0.5 ? -1 : 1) * (0.5 + 0.5 * rnd());
    const ph = rnd() * TAU;
    const L = 0.47 + 0.07 * rnd();
    const ctrl = [];
    let ang = th;
    let X = Math.cos(th) * 0.06;
    let Z = Math.sin(th) * 0.06;
    const NS = 26;
    for (let k = 0; k <= NS; k++) {
      const u = k / NS;
      const [sx, sy] = scr(X, Z);
      ctrl.push([sx, sy, 0.019 * Math.pow(1 - u, 0.75) + 0.0038]);
      ang += (a1 * Math.sin(u * 4.4 + ph) * 0.9 + a1 * u * u * 1.6) * (1 / NS) * 2.2;
      X += Math.cos(ang) * (L / NS);
      Z += Math.sin(ang) * (L / NS);
    }
    const pts = spline(ctrl, 3);
    const P = R.layer();
    // comb of fine side spines
    for (let k = 2; k < 58; k++) {
      const f = k / 60;
      const q = along(pts, f);
      const len = (0.02 + 0.012 * hash2(k, i, seed)) * (1 - f * 0.55);
      for (const side of [-1, 1]) {
        const nx = -q.ty * side;
        const ny = q.tx * side;
        const bx = q[0] + nx * q[2] * 0.6;
        const by = q[1] + ny * q[2] * 0.6;
        P.tube([[bx, by, 0.0028], [bx + nx * len - q.tx * len * 0.35, by + ny * len - q.ty * len * 0.35, 0.0009]], () => mix3(B, A, 0.35), { gloss: 0.1, edge: 0, alpha: 0.9 });
      }
    }
    P.tube(pts, (t, s, x, y, n) => {
      const band = smoothstep(0.35, 0.5, fract(t * 15 + 0.2)) * smoothstep(0.98, 0.84, fract(t * 15 + 0.2));
      let c = mix3(B, A, 0.25 + 0.75 * band);
      c = mix3(c, C, 0.55 * band * smoothstep(0.2, 0.9, Math.abs(s)) + 0.25 * band);
      // segment creases
      c = mul3(c, 1 - 0.25 * smoothstep(0.75, 1, Math.abs(Math.sin(t * PI * 60))));
      return c;
    }, { gloss: 0.3, sheen: 0.16 });
    let img = P.resolve();
    img = stack(dropShadow(img, 0, Math.round(S * 0.01), S * 0.009, 0.4), img);
    layers.push({ img, depth: Math.sin(th), piv: scr(Math.cos(th) * 0.07, Math.sin(th) * 0.07) });
  }
  layers.sort((a, b) => a.depth - b.depth);
  layers.forEach((l, i) => R.add(l.img, l.piv, { kind: 'sway', amp: 3.2, rate: 0.3, phase: PH5[i] }));
  // central disc
  const D = R.layer();
  const dr = 0.092;
  D.blob(0, yc + 0.012, dr, dr * 0.68, 0, (u, v, x, y, n) => {
    const X = u * dr;
    const Z = -(v * dr * 0.68) / STAR_SE;
    const a = Math.atan2(Z, X);
    const rr = Math.hypot(X, Z) / dr;
    const lobe = Math.cos((a - (-PI / 2 + 0.3)) * 5);
    let c = mix3(A, C, 0.3 + 0.25 * organic(X * 30, Z * 30, seed + 2, 2));
    // paired radial shields beside every arm, a paler rosette in the middle
    c = mix3(c, B, 0.7 * smoothstep(0.5, 0.85, lobe) * smoothstep(0.35, 0.6, rr) * smoothstep(1.0, 0.85, rr));
    c = mix3(c, B, 0.45 * smoothstep(0.3, 0.1, rr));
    const w = worley(X * 70, Z * 70, seed + 6);
    c = mul3(c, 0.88 + 0.2 * smoothstep(0.1, 0.35, w.f1));
    return c;
  }, { rz: dr * 0.45, gloss: 0.3, sheen: 0.2 });
  let dimg = D.resolve();
  dimg = stack(dropShadow(dimg, 0, Math.round(S * 0.01), S * 0.01, 0.45), dimg);
  R.add(dimg, [0, yc], null);
  return R.done('base');
};

// ---- long-spined urchin -------------------------------------------------------------------------
BUILDERS.diademaUrchin = (id, opts) => {
  const R = new Rig(id, opts, 240, [-0.62, -0.08, 0.62, 0.8]);
  const { A, B, C, seed, rnd } = R;
  const cx = 0;
  const cy = 0.2;
  const rx = 0.128;
  const ry = 0.112;
  // evenly spread directions on the sphere (best-candidate sampling), none pointing into the ground
  const dirs = [];
  while (dirs.length < 190) {
    let best = null;
    let bd = -1;
    for (let c = 0; c < 10; c++) {
      const yv = 1 - rnd() * 1.62;
      const rr = Math.sqrt(Math.max(0, 1 - yv * yv));
      const a = rnd() * TAU;
      const d = [Math.cos(a) * rr, yv, Math.sin(a) * rr];
      let md = 9;
      for (const q of dirs) md = Math.min(md, 1 - (q[0] * d[0] + q[1] * d[1] + q[2] * d[2]));
      if (md > bd) {
        bd = md;
        best = d;
      }
    }
    dirs.push(best);
  }
  const spines = [];
  for (const dir of dirs) {
    // keep the test readable: few spines point at the viewer, none hide the crown with its ring and spots
    if (dir[2] > 0.45 && rnd() < 0.6) continue;
    if (dir[2] > 0.25 && dir[1] > 0.45 && Math.abs(dir[0]) < 0.6) continue;
    let L = 0.22 + 0.17 * rnd() + 0.08 * Math.max(0, dir[1]);
    if (dir[1] < 0) L = Math.min(L, (-0.014 - cy) / dir[1] - ry);
    if (L < 0.04) continue;
    spines.push({ dir, L, w: 0.8 + 0.4 * rnd(), bend: (rnd() - 0.5) * 0.02 });
  }
  spines.sort((p, q) => p.dir[2] - q.dir[2]);
  const drawSpine = (P, sp, depth) => {
    const d = sp.dir;
    const base = [cx + rx * d[0] * 0.9, cy + ry * d[1] * 0.9];
    const tip = [cx + (rx + sp.L) * d[0], cy + (ry + sp.L) * d[1]];
    const mid = [lerp(base[0], tip[0], 0.5) - d[1] * sp.bend, lerp(base[1], tip[1], 0.5) + d[0] * sp.bend];
    const r0 = 0.0074 * sp.w * (0.8 + 0.3 * depth);
    const bands = 9 + sp.L * 30;
    P.tube([[...base, r0], [...mid, r0 * 0.64], [...tip, 0.001]], (t) => {
      const band = 0.5 + 0.5 * Math.cos(t * bands);
      return mix3(A, B, 0.35 + 0.45 * band * (0.4 + 0.6 * depth));
    }, { gloss: 0.8, sheen: 0.36, edge: 0, dim: (1 - depth) * 0.4, minPx: 0.66 });
  };
  const backA = R.layer();
  const backB = R.layer();
  const front = R.layer();
  let k = 0;
  for (const sp of spines) {
    const depth = clamp(sp.dir[2] * 0.5 + 0.5);
    if (sp.dir[2] < 0.3) drawSpine(k++ % 2 ? backA : backB, sp, depth);
  }
  // ---- test (the body)
  const body = R.layer();
  groundShadow(body, 0, 0.3, 0.022, 0.3);
  body.blob(cx, cy, rx, ry, 0, (u, v, x, y, n) => {
    const lat = Math.asin(clamp(v, -1, 1));
    const lon = Math.asin(clamp(u / Math.sqrt(Math.max(1e-4, 1 - v * v)), -1, 1)) + 0.42;
    let c = mix3(A, B, 0.3 + 0.35 * organic(u * 5, v * 5, seed, 3));
    // five ambulacral bands of tubercles
    const amb = Math.cos(lon * 5);
    const w = worley(lon * 9, lat * 12, seed + 3);
    c = mul3(c, 0.8 + 0.6 * smoothstep(0.3, 0.1, w.f1) * smoothstep(-0.2, 0.6, amb));
    nudge(n, (w.px - lon * 9) * 0.25, -(w.py - lat * 12) * 0.25);
    // electric blue iridophore dots in lines down the sides
    const m = Math.abs(fract(lon / (TAU / 5) + 0.5) - 0.5) * (TAU / 5);
    const dots = smoothstep(0.36, 0.14, Math.abs(fract(lat * 4.2) - 0.5)) * smoothstep(0.075, 0.03, m);
    c = mix3(c, [0.1, 0.5, 1.0], dots * smoothstep(-0.5, 0.0, lat));
    // five white spots around the top
    const m2 = Math.abs(fract(lon / (TAU / 5)) - 0.5) * (TAU / 5);
    const spot = smoothstep(0.23, 0.13, Math.hypot(m2 * Math.cos(lat), lat - 0.72));
    c = mix3(c, [0.95, 0.97, 1.0], spot);
    return c;
  }, { gloss: 0.6, sheen: 0.25, ao: (u, v) => 0.5 + 0.5 * smoothstep(-0.9, 0.1, v) });
  // anal sac with its orange ring
  const sy = cy + ry + 0.012;
  body.darken([cx - 0.07, sy - 0.06, cx + 0.07, sy + 0.02], (x, y) => 0.5 * smoothstep(1, 0.5, Math.hypot((x - cx) / 0.055, (y - sy + 0.02) / 0.03)));
  body.blob(cx, sy, 0.045, 0.046, 0, (u, v) => {
    let c = mix3(mul3(A, 1.6), B, 0.6);
    const ring = smoothstep(0.27, 0.14, Math.abs(v - 0.16 + 0.32 * u * u));
    c = mix3(c, mix3(C, [1, 0.45, 0.05], 0.35), ring);
    c = mix3(c, [0.02, 0.02, 0.03], smoothstep(0.24, 0.1, Math.hypot(u, (v - 0.74) * 1.6)));
    return c;
  }, { gloss: 0.7, sheen: 0.25 });
  for (const sp of spines) if (sp.dir[2] >= 0.3) drawSpine(front, sp, clamp(sp.dir[2] * 0.5 + 0.5));
  R.add(backA, [cx, cy], { kind: 'sway', amp: 2.4, rate: 0.28, phase: PH3[0] });
  R.add(backB, [cx, cy], { kind: 'sway', amp: 2.4, rate: 0.28, phase: PH3[1] });
  R.add(body, [cx, cy], null);
  R.add(front, [cx, cy], { kind: 'sway', amp: 1.6, rate: 0.28, phase: PH3[2] });
  return R.done('base');
};

// ---- sea cucumber -------------------------------------------------------------------------------
BUILDERS.seaCucumber = (id, opts) => {
  const R = new Rig(id, opts, 260, [-0.58, -0.06, 0.62, 0.36]);
  const { A, B, C, seed, rnd } = R;
  const ctrl = [[-0.455, 0.062, 0.055], [-0.38, 0.098, 0.094], [-0.2, 0.123, 0.12], [0.05, 0.125, 0.123], [0.26, 0.112, 0.108], [0.39, 0.092, 0.086], [0.445, 0.078, 0.062]];
  const pts = spline(ctrl, 10);
  const body = R.layer();
  groundShadow(body, 0, 0.47, 0.022, 0.36);
  // papillae: the ones on the outline go behind the body, the rest on top of it
  const paps = [];
  for (let k = 0; k < 400 && paps.length < 46; k++) {
    const f = 0.04 + 0.92 * rnd();
    const s = -0.35 + 1.35 * rnd();
    if (paps.some((q) => Math.hypot((q.f - f) * 8, q.s - s) < 0.34)) continue;
    paps.push({ f, s, len: 0.012 + 0.016 * rnd() * rnd() + 0.004 * rnd() });
  }
  const drawPap = (P, pp) => {
    const q = along(pts, pp.f);
    const nx = -q.ty;
    const ny = q.tx;
    const sr = Math.sin((pp.s * PI) / 2);
    const bx = q[0] + nx * q[2] * sr * 0.9;
    const by = q[1] + ny * q[2] * sr * 0.9;
    const out = 0.3 + 0.7 * Math.abs(sr);
    const tx = bx + nx * pp.len * sr * 1.1 + 0.004;
    const ty = by + ny * pp.len * out;
    const k = pp.len / 0.022;
    P.tube([[bx, by, 0.017 * k], [lerp(bx, tx, 0.55), lerp(by, ty, 0.55), 0.0105 * k], [tx, ty, 0.0055 * k]], (t) => mix3(mix3(A, B, 0.3), mix3(B, C, 0.6), smoothstep(0.3, 1.0, t)), {
      gloss: 0.22, sheen: 0.15, edge: 0.1, ao: (t) => 0.75 + 0.25 * t,
    });
  };
  for (const pp of paps) if (pp.s > 0.8) drawPap(body, pp);
  body.tube(pts, (t, s, x, y, n) => {
    const phi = Math.asin(clamp(s, -1, 1));
    let c = mix3(A, mul3(B, 0.7), 0.75 * smoothstep(0.45, 0.7, organic(t * 9, phi * 2.2, seed, 3)));
    // wrinkles across the body
    const wr = Math.sin(t * 150 + 3 * organic(t * 9, phi * 2, seed + 1, 2));
    c = mul3(c, 0.9 + 0.12 * wr);
    nudge(n, wr * 0.06, 0);
    // pale speckles
    const w = worley(t * 46, phi * 7, seed + 2);
    c = mix3(c, C, smoothstep(0.16, 0.05, w.f1) * 0.6 * (0.5 + 0.5 * w.id));
    // paler sole
    c = mix3(c, mix3(B, C, 0.25), smoothstep(-0.45, -0.85, s) * 0.75);
    return c;
  }, { gloss: 0.34, sheen: 0.2, ao: (t, s) => 0.55 + 0.45 * smoothstep(-1, -0.2, s) });
  for (const pp of paps) if (pp.s <= 0.8) drawPap(body, pp);
  // feeding tentacles around the mouth (right end): short stalks ending in bushy tips
  const tent = R.layer();
  const mouth = [0.462, 0.07];
  for (let k = 0; k < 10; k++) {
    const a = -1.3 + (k / 9) * 2.1 + (rnd() - 0.5) * 0.15;
    const len = 0.06 + 0.025 * rnd();
    const ex = mouth[0] + Math.cos(a) * len;
    const ey = Math.max(0.01, mouth[1] + Math.sin(a) * len * 0.9 - 0.012);
    const stalk = mix3(A, B, 0.55);
    tent.tube([[mouth[0] - 0.02, mouth[1], 0.012], [lerp(mouth[0], ex, 0.6), lerp(mouth[1], ey, 0.6) + 0.004, 0.0085], [ex, ey, 0.006]], (t) => mix3(stalk, mix3(B, C, 0.5), t * 0.7), { gloss: 0.2, ao: (t) => 0.55 + 0.45 * t });
    for (let j = 0; j < 5; j++) {
      const ja = a + (j / 4 - 0.5) * 2.2 + (rnd() - 0.5) * 0.3;
      const bl = 0.014 + 0.008 * rnd();
      tent.tube([[ex, ey, 0.0045], [ex + Math.cos(ja) * bl, Math.max(0.004, ey + Math.sin(ja) * bl), 0.0026]], (t) => mix3(mix3(B, C, 0.4), C, t), { gloss: 0.2, edge: 0 });
    }
  }
  R.add(tent, mouth, { kind: 'sway', amp: 5, rate: 0.5, phase: 0 });
  R.add(body, [0, 0.02], { kind: 'pulse', amp: 0.012, rate: 0.25, phase: 0 });
  return R.done('base');
};

// ---- seagrass tuft --------------------------------------------------------------------------------
BUILDERS.seagrass = (id, opts) => {
  const R = new Rig(id, opts, 280, [-0.6, -0.05, 0.6, 1.08]);
  const { A, B, C, seed, rnd } = R;
  const layers = [R.layer(), R.layer(), R.layer()];
  const N = 16;
  const blades = [];
  for (let i = 0; i < N; i++) {
    const g = i % 3;
    const young = i >= 13;
    const hgt = young ? 0.3 + 0.2 * rnd() : (g === 2 ? 0.5 : 0.7) + 0.3 * rnd();
    const lean = ((i % 13) + 0.5) / 13 * 0.95 - 0.475 + (rnd() - 0.5) * 0.35;
    blades.push({ g, hgt, lean, x0: lean * 0.13 + (rnd() - 0.5) * 0.05, w: young ? 0.016 : 0.025 + 0.01 * rnd(), tw: rnd() * TAU, twr: 2.5 + 3 * rnd(), k: i, sway: (rnd() - 0.5) * 0.16 });
  }
  blades.sort((a, b) => a.g - b.g || Math.abs(b.lean) - Math.abs(a.lean));
  for (const b of blades) {
    const P = layers[b.g];
    const hgt = b.hgt;
    // a blade leaves the base nearly upright, arcs outward and relaxes at the tip
    const ctrl = [
      [b.x0, -0.006],
      [b.x0 + (b.lean * 0.1 + b.sway * 0.3) * hgt, 0.3 * hgt],
      [b.x0 + (b.lean * 0.3 + b.sway) * hgt, 0.6 * hgt],
      [b.x0 + (b.lean * 0.56 + b.sway * 0.8) * hgt, 0.85 * hgt],
      [b.x0 + (b.lean * 0.8 + b.sway * 0.2) * hgt, (1 - 0.1 * Math.abs(b.lean)) * hgt],
    ];
    const path = spline(ctrl, 10);
    const n = path.length - 1;
    const pts = path.map((p, i) => {
      const t = i / n;
      const twist = 0.7 + 0.3 * Math.abs(Math.cos(b.tw + t * b.twr));
      const prof = (0.42 + 0.58 * smoothstep(0, 0.2, t)) * Math.pow(clamp((1 - t) / 0.06), 0.55);
      return [p[0], p[1], Math.max(0.002, b.w * prof * twist)];
    });
    const dimK = b.g === 0 ? 0.6 : b.g === 1 ? 0.25 : 0;
    const hue = hash2(b.k, 7, seed);
    P.tube(pts, (t, s, x, y, nrm) => {
      const tw = Math.cos(b.tw + t * b.twr);
      let c = mix3(C, A, smoothstep(0.0, 0.35, t));
      c = mix3(c, B, 0.25 * smoothstep(0.3, 1, t) + 0.3 * hue + 0.25 * smoothstep(0.4, -0.7, tw));
      // midrib (a fine groove with a lit shoulder) and parallel veins
      c = mul3(c, 1 - 0.32 * smoothstep(0.09, 0.02, Math.abs(s)));
      c = mul3(c, 1 + 0.12 * smoothstep(0.1, 0.04, Math.abs(s - 0.16)));
      c = mul3(c, 0.93 + 0.09 * Math.cos(s * 19));
      // pale sheath at the base, tired tips, a few epiphyte specks
      c = mix3(c, [0.66, 0.62, 0.4], smoothstep(0.08, 0.0, t) * 0.75);
      c = mix3(c, [0.45, 0.34, 0.12], smoothstep(0.88, 1.0, t) * 0.6 * hue);
      const e = worley(x * 70, y * 70, seed + b.k);
      c = mix3(c, [0.78, 0.8, 0.62], smoothstep(0.13, 0.05, e.f1) * 0.4 * smoothstep(0.4, 0.9, t));
      // a twisting ribbon turns its face toward and away from the light
      nudge(nrm, 0.6 * Math.sin(b.tw + t * b.twr) + s * 0.1, 0.1);
      return c;
    }, { round: 0.16, gloss: 0.45, sheen: 0.25, edge: 0.0, dim: dimK, ao: (t) => 0.45 + 0.55 * smoothstep(0.0, 0.4, t) });
  }
  const amps = [3.2, 4.2, 5.2];
  layers.forEach((P, g) => R.add(P, [0, 0], { kind: 'sway', amp: amps[g], rate: 0.32 + 0.04 * g, phase: PH3[g] }));
  return R.done('base');
};

// ---- box jellyfish (the hazard) --------------------------------------------------------------------
BUILDERS.seaWasp = (id, opts) => {
  const R = new Rig(id, opts, 340, [-0.56, -0.68, 0.46, 0.72]);
  const { A, B, C, seed, rnd, S } = R;
  const glowCol = hex('#7fbfff');
  const yT = 0.5;
  const yB = 0.105;
  const HW = 0.184;
  const e0 = 0.3; // where the near vertical edge of the box sits (fraction of the half width)
  const hwAt = (v) => HW * Math.pow(Math.max(0, 1 - Math.pow(v, 4.4)), 1 / 3.1) * (0.93 + 0.07 * smoothstep(0, 0.3, v));
  const marginY = (s) => yB + 0.016 * Math.pow(Math.abs(Math.cos(((s - e0) / 1.3) * PI)), 1.5) * 0 + 0.012 * (1 - Math.pow(Math.abs(Math.sin(((s - e0) * PI) / 1.3)), 0.7));
  // ---- bell
  const bell = R.layer();
  bell.glow(0, 0.31, 0.3, 0.3, glowCol, 0.24, 1.7);
  bell.region(-0.22, yB - 0.03, 0.22, yT + 0.01, (x, y, out) => {
    const v0 = (y - yB) / (yT - yB);
    if (v0 > 1 || v0 < -0.1) return false;
    const hw = hwAt(clamp(v0));
    const s = x / hw;
    if (Math.abs(s) >= 1) return false;
    const yb = marginY(s);
    if (y < yb) return false;
    const v = (y - yb) / (yT - yb);
    // pseudo 3D normal of a rounded box seen slightly from the right
    const face = smoothstep(e0 - 0.09, e0 + 0.09, s);
    let nx = lerp(-0.3, 0.5, face) + Math.sign(s) * Math.pow(Math.abs(s), 5) * 0.75;
    let ny = Math.pow(v, 4.2) * 0.95 - 0.12 * smoothstep(0.12, 0.0, v);
    const nl = Math.hypot(nx, ny);
    if (nl > 0.98) {
      nx *= 0.98 / nl;
      ny *= 0.98 / nl;
    }
    const n = [nx, ny, Math.sqrt(1 - nx * nx - ny * ny)];
    const rim = Math.max(Math.pow(Math.abs(s), 6), Math.pow(v, 7));
    let base = mix3(B, A, 0.45 + 0.4 * v);
    let c = lit(base, n, 0.9, 0.35, 1);
    c = mix3(c, mul3(saturate(B, 1.25), 1.05), 0.4 * rim);
    let al = 0.45 + 0.4 * rim;
    // the near and far vertical edges of the box
    const edgeN = gauss(s - e0, 0.045) * smoothstep(0.95, 0.5, v) * smoothstep(-0.02, 0.1, v);
    const edgeF = gauss(s + e0 * 0.85, 0.035) * smoothstep(0.9, 0.4, v) * smoothstep(0.0, 0.12, v);
    c = add3(c, mul3([0.8, 0.95, 1.0], 0.5 * edgeN + 0.14 * edgeF));
    al += 0.22 * edgeN + 0.07 * edgeF;
    // faint radial canals
    const can = 0.5 + 0.5 * Math.cos(s * 26 + 1.2 * Math.sin(v * 5));
    c = add3(c, mul3([0.6, 0.8, 1.0], 0.035 * can * smoothstep(0.0, 0.2, v) * smoothstep(1.0, 0.6, v)));
    // stomach and the four gastric pouches hanging under the top
    const gx = x - 0.012;
    const gy = y - (yT - 0.11);
    const stom = smoothstep(1.0, 0.55, Math.hypot(gx / 0.07, gy / 0.05) * (1 + 0.16 * Math.cos(Math.atan2(gy, gx) * 4 + 0.6)));
    const man = smoothstep(1.0, 0.4, Math.abs(gx + 0.004) / (0.024 - 0.006 * smoothstep(-0.03, -0.12, gy))) * smoothstep(0.0, -0.02, gy) * smoothstep(-0.135, -0.115, gy);
    const inner = Math.max(stom, man * 0.85);
    c = mix3(c, mul3([0.92, 0.97, 1.0], 0.9 + 0.3 * organic(x * 40, y * 40, seed, 2)), inner * 0.6);
    al += inner * 0.3;
    // leaf-shaped gonads along the corners
    for (const gs of [e0, -0.82, 0.86]) {
      const lx = (s - gs) / 0.085;
      const ly = (v - 0.47) / 0.3;
      const leaf = smoothstep(1.0, 0.5, lx * lx + ly * ly) * (0.7 + 0.3 * Math.cos(v * 60));
      c = add3(c, mul3([0.75, 0.9, 1.0], 0.1 * leaf));
      al += 0.07 * leaf;
    }
    // rhopalia: two sensory dots in their niches
    for (const rs of [-0.3, 0.66]) {
      const rd = Math.hypot((s - rs) * hw, y - (yB + 0.05));
      c = mix3(c, [0.95, 1, 1], 0.5 * smoothstep(0.02, 0.008, rd));
      c = mix3(c, [0.12, 0.07, 0.05], smoothstep(0.0075, 0.004, rd));
      al = Math.max(al, 0.9 * smoothstep(0.0075, 0.004, rd));
    }
    // velarium: a brighter thickened lower margin
    const vel = smoothstep(0.06, 0.0, v);
    c = add3(c, mul3([0.7, 0.9, 1.0], 0.22 * vel));
    al += 0.2 * vel;
    // highlights stay opaque
    al = Math.max(al, clamp(lum(c) - 1.05) * 1.4);
    c = tone(mul3(c, 0.86));
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = clamp(al, 0, 0.93);
    return true;
  });
  // ---- pedalia + tentacles: one bundle per corner
  const corners = [
    { x: -e0 * 0.85 * HW * 0.93, depth: 0, n: 5 },
    { x: -HW * 0.9, depth: 0.5, n: 6 },
    { x: HW * 0.9, depth: 0.5, n: 6 },
    { x: e0 * HW * 0.93, depth: 1, n: 7 },
  ];
  const bundles = corners.map((cn, ci) => {
    const P = R.layer();
    const dimA = 0.62 + 0.38 * cn.depth;
    const side = cn.x < 0 ? -1 : 1;
    const top = [cn.x, yB + 0.035];
    const tipP = [cn.x + side * 0.016 - 0.006, yB - 0.055];
    // tentacles first (they hang from the pedalium's lower edge)
    for (let j = 0; j < cn.n; j++) {
      const f = cn.n > 1 ? j / (cn.n - 1) - 0.5 : 0;
      const L = (0.36 + 0.17 * rnd()) * (0.86 + 0.14 * cn.depth);
      const ph = rnd() * TAU;
      const fr = 5 + 4 * rnd();
      const amp = 0.012 + 0.014 * rnd();
      const drift = 0.05 + 0.07 * rnd();
      const ctrl = [];
      const NS = 22;
      for (let q = 0; q <= NS; q++) {
        const t = q / NS;
        ctrl.push([
          tipP[0] + f * 0.03 + f * 0.09 * t + amp * Math.sin(t * fr + ph) * smoothstep(0, 0.3, t) - drift * t * t,
          tipP[1] + 0.012 - L * t,
          lerp(0.0056, 0.0019, Math.pow(t, 0.7)),
        ]);
      }
      const pts = spline(ctrl, 2);
      const beads = 34 + 20 * rnd();
      P.tube(pts, (t, sN, x, y, qn) => {
        const bead = 0.5 + 0.5 * Math.cos(t * L * beads * 9);
        const core = 1 - qn * qn;
        const c = mix3(mix3(B, A, 0.5), [1, 1, 1], 0.25 + 0.5 * bead * core);
        return [c[0], c[1], c[2], (0.5 + 0.35 * bead) * (0.55 + 0.45 * core) * lerp(1, 0.5, t) * dimA];
      }, { raw: true, minPx: 0.62 });
    }
    // pedalium: a fleshy blade
    P.tube(spline([[top[0], top[1], 0.02], [lerp(top[0], tipP[0], 0.5) + side * 0.004, lerp(top[1], tipP[1], 0.5), 0.024], [tipP[0], tipP[1], 0.017]], 6), (t, sN, x, y, qn) => {
      const core = Math.sqrt(1 - qn * qn);
      let c = mix3(B, A, 0.6);
      c = add3(mul3(c, 0.75 + 0.25 * core), mul3([0.8, 0.95, 1.0], 0.5 * Math.pow(1 - core, 2) + 0.12 * smoothstep(0.5, -0.9, sN * side)));
      return [c[0], c[1], c[2], (0.5 + 0.3 * (1 - core)) * dimA];
    }, { raw: true });
    let img = P.resolve();
    // soft glow around the tentacles
    const halo = blur(img, S * 0.012);
    for (let i = 0; i < halo.d.length; i += 4) {
      const a = halo.d[i + 3] * 0.55;
      halo.d[i] = glowCol[0] * a;
      halo.d[i + 1] = glowCol[1] * a;
      halo.d[i + 2] = glowCol[2] * a;
      halo.d[i + 3] = a;
    }
    img = stack(halo, img);
    return { img, top, depth: cn.depth };
  });
  const sway = (i) => ({ kind: 'sway', amp: 4.5, rate: 0.3, phase: PH4[i] });
  R.add(bundles[0].img, bundles[0].top, sway(0));
  R.add(bundles[1].img, bundles[1].top, sway(1));
  R.add(bundles[2].img, bundles[2].top, sway(2));
  R.add(bell, [0, yT - 0.13], { kind: 'pulse', amp: 0.05, rate: 0.55, phase: 0 });
  R.add(bundles[3].img, bundles[3].top, sway(3));
  return R.done('center');
};

// ---- plankton swarm ---------------------------------------------------------------------------------
BUILDERS.plankton = (id, opts) => {
  const R = new Rig(id, opts, 200, [-0.62, -0.62, 0.62, 0.62]);
  const { A, B, C, seed, rnd } = R;
  const anims = [
    { kind: 'sway', amp: 7, rate: 0.11, phase: PH2[0] },
    { kind: 'pulse', amp: 0.06, rate: 0.17, phase: 1.2 },
    { kind: 'sway', amp: 7, rate: 0.11, phase: PH2[1] },
  ];
  // a few loose sub-clusters shared by all layers
  const hubs = [];
  for (let i = 0; i < 5; i++) {
    const a = rnd() * TAU;
    const r = 0.3 * Math.sqrt(rnd());
    hubs.push([Math.cos(a) * r, Math.sin(a) * r * 0.85]);
  }
  for (let li = 0; li < 3; li++) {
    const P = R.layer();
    // warm haze
    for (let hI = 0; hI < 3; hI++) {
      const hb = hubs[(li + hI * 2) % hubs.length];
      P.glow(hb[0] * 0.8, hb[1] * 0.8, 0.3 + 0.08 * rnd(), 0.26 + 0.06 * rnd(), mix3(A, C, 0.5), 0.085, 1.6);
    }
    const dots = [];
    for (let k = 0; k < 600 && dots.length < 30; k++) {
      const hb = hubs[Math.floor(rnd() * hubs.length)];
      const a = rnd() * TAU;
      const r = 0.24 * Math.pow(rnd(), 0.7);
      const x = hb[0] + Math.cos(a) * r;
      const y = hb[1] + Math.sin(a) * r;
      if (Math.hypot(x, y * 1.1) > 0.47) continue;
      if (dots.some((d) => Math.hypot(d.x - x, d.y - y) < 0.045)) continue;
      dots.push({ x, y, r: 0.0085 + 0.012 * rnd() * rnd() + (li === 2 ? 0.003 : 0), a: rnd() * TAU, kind: rnd() < 0.55 ? 1 : 0, hue: rnd() });
    }
    // distant specks give the cloud depth
    for (let k = 0; k < 16; k++) {
      const a = rnd() * TAU;
      const r = 0.44 * Math.sqrt(rnd());
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * 0.9;
      const rr = 0.0045 + 0.003 * rnd();
      P.glow(x, y, rr * 3.2, rr * 3.2, mix3(A, C, 0.4), 0.22, 2);
      P.glow(x, y, rr, rr, mix3(A, B, 0.35), 0.85, 0.6);
    }
    for (const d of dots) {
      const body = mix3(A, C, d.hue * 0.8);
      const hot = mix3(B, [1, 0.95, 0.8], 0.4);
      P.glow(d.x, d.y, d.r * 4.2, d.r * 4.2, mix3(A, C, 0.3), 0.3, 2.2);
      if (d.kind === 1) {
        // copepod: teardrop body, tail, two long antennae
        const ca = Math.cos(d.a);
        const sa = Math.sin(d.a);
        const L = d.r * 1.9;
        const hx = d.x + ca * L * 0.5;
        const hy = d.y + sa * L * 0.5;
        const line = (pts, al) => P.tube(pts, () => [hot[0], hot[1], hot[2], al], { raw: true, minPx: 0.5 });
        for (const sd of [-1, 1]) {
          line([[hx, hy, d.r * 0.16], [hx - sa * sd * L * 0.9 - ca * L * 0.25, hy + ca * sd * L * 0.9 - sa * L * 0.25, d.r * 0.07]], 0.85);
        }
        line([[d.x - ca * L * 0.5, d.y - sa * L * 0.5, d.r * 0.22], [d.x - ca * L * 1.25, d.y - sa * L * 1.25, d.r * 0.07]], 0.9);
        P.tube([[hx, hy, d.r * 0.68], [d.x, d.y, d.r * 0.6], [d.x - ca * L * 0.55, d.y - sa * L * 0.55, d.r * 0.22]], (t, sN, x, y, qn) => {
          const c = mix3(hot, body, smoothstep(0.0, 0.8, qn) * 0.9 + 0.1);
          return [c[0], c[1], c[2], 1];
        }, { raw: true });
        P.glow(hx - ca * L * 0.15, hy - sa * L * 0.15, d.r * 0.2, d.r * 0.2, [0.25, 0.02, 0.02], 0.9, 0.5);
      } else {
        P.region(d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r, (x, y, out) => {
          const q = Math.hypot(x - d.x, y - d.y) / (d.r * 0.8);
          if (q >= 1) return false;
          const c = mix3(hot, body, smoothstep(0.0, 0.85, Math.hypot(x - d.x + d.r * 0.2, y - d.y - d.r * 0.2) / (d.r * 0.8)));
          out[0] = c[0];
          out[1] = c[1];
          out[2] = c[2];
          out[3] = 1;
          return true;
        });
      }
    }
    R.add(P, [0, 0], anims[li]);
  }
  return R.done('center');
};

// ---- magnificent anemone ------------------------------------------------------------------------------
BUILDERS.seaAnemone = (id, opts) => {
  const R = new Rig(id, opts, 300, [-0.7, -0.07, 0.7, 0.74], 1.14);
  const { A, B, C, seed, rnd } = R;
  const colCol = hex('#b0389a');
  const yD = 0.275; // height of the oral disc
  const Rd = 0.4;
  const tents = [];
  for (let k = 0; k < 6000 && tents.length < 190; k++) {
    const a = rnd() * TAU;
    const rho = Math.sqrt(0.02 + 0.98 * rnd());
    const X = Math.cos(a) * rho * Rd;
    const Z = Math.sin(a) * rho * Rd;
    if (tents.some((q) => Math.hypot(q.X - X, (q.Z - Z) * 0.6) < 0.044)) continue;
    tents.push({ X, Z, rho, len: 0.15 + 0.06 * rnd(), bend: (rnd() - 0.5) * 0.07, r: 0.0185 + 0.004 * rnd(), hue: rnd() });
  }
  tents.sort((p, q) => p.Z - q.Z);
  const drawTent = (P, t) => {
    const zn = t.Z / Rd;
    const xn = t.X / Rd;
    const bx = t.X * (1 + 0.05 * zn);
    const by = yD + 0.035 * (1 - t.rho * t.rho) - t.Z * 0.2;
    // lean outward, front ones tip toward the viewer (down on screen), rim ones droop
    let dx = xn * 0.62 + t.bend * 2;
    let dy = 1 - 0.25 * Math.abs(xn) - 0.5 * Math.max(0, zn) - 0.3 * smoothstep(0.7, 1, t.rho);
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const L = t.len * (1 - 0.25 * Math.max(0, zn) * (1 - Math.abs(xn)));
    const droop = 0.045 * (Math.abs(xn) + Math.max(0, zn) * 0.5);
    const ctrl = [
      [bx, by - 0.012, t.r * 1.05],
      [bx + dx * L * 0.35 + t.bend * 0.3, by + dy * L * 0.35, t.r],
      [bx + dx * L * 0.7 + t.bend, by + dy * L * 0.7 - droop * 0.4, t.r * 0.92],
      [bx + dx * L + t.bend * 1.6, by + dy * L - droop, t.r * 1.0],
    ];
    const depth = clamp(zn * 0.5 + 0.5);
    const body = mix3(A, mix3(A, [0.75, 0.55, 0.3], 0.6), 0.25 + 0.5 * t.hue);
    P.tube(spline(ctrl, 5), (tt, sN) => {
      let c = mix3(mul3(body, 0.82), body, smoothstep(0.0, 0.5, tt));
      c = mix3(c, B, smoothstep(0.68, 0.9, tt) * 0.9);
      c = mix3(c, [1.0, 0.86, 0.9], smoothstep(0.93, 1.0, tt) * 0.5);
      return c;
    }, { gloss: 0.38, sheen: 0.2, edge: 0.25, dim: (1 - depth) * 0.5, ao: (tt) => 0.3 + 0.7 * smoothstep(0.0, 0.55, tt) });
  };
  const back = R.layer();
  const mid = R.layer();
  const front = R.layer();
  for (const t of tents) if (t.Z / Rd < -0.3) drawTent(back, t);
  // ---- column
  const col = R.layer();
  groundShadow(col, 0, 0.3, 0.024, 0.34);
  const hwc = (y) => 0.2 + 0.035 * smoothstep(0.05, -0.02, y) - 0.02 * Math.sin(clamp(y / 0.2) * PI) + 0.2 * Math.pow(smoothstep(0.1, 0.29, y), 2.2);
  col.field([-0.5, -0.03, 0.5, yD + 0.03], (x, y) => {
    if (y > yD + 0.02) return -1;
    const hw = hwc(Math.max(0, y));
    const s = x / hw;
    if (Math.abs(s) >= 1) return -1;
    return hw * 0.75 * Math.sqrt(1 - s * s) * seat(x, y, hw, 0.024);
  }, (x, y, z, n) => {
    const hw = hwc(y);
    const lon = Math.asin(clamp(x / hw, -1, 1));
    let c = mix3(mix3(C, colCol, 0.75), colCol, smoothstep(0.0, 0.25, y));
    c = mul3(c, 0.9 + 0.1 * Math.cos(lon * 34 + 2 * Math.sin(y * 30)));
    // verrucae near the flared top
    const w = worley(lon * 13, y * 60, seed + 4);
    c = mix3(c, mix3(colCol, B, 0.7), smoothstep(0.26, 0.1, w.f1) * 0.55 * smoothstep(0.08, 0.2, y));
    c = mix3(c, mix3(C, colCol, 0.3), smoothstep(0.06, -0.02, y) * 0.6);
    return c;
  }, { gloss: 0.5, sheen: 0.22, ao: (x, y) => (0.5 + 0.5 * smoothstep(-0.02, 0.07, y)) * (1 - 0.45 * smoothstep(0.16, yD, y)) });
  // the underside of the oral disc, seen between the tentacles
  col.region(-Rd - 0.02, yD - 0.1, Rd + 0.02, yD + 0.1, (x, y, out) => {
    const q = Math.hypot(x / (Rd + 0.01), (y - yD - 0.008) / 0.085);
    if (q >= 1) return false;
    const c = tone(mul3(mix3(A, C, 0.55), 0.5 + 0.3 * (1 - q)));
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = 1;
    return true;
  });
  for (const t of tents) {
    const zn = t.Z / Rd;
    if (zn >= -0.3 && zn < 0.3) drawTent(mid, t);
    else if (zn >= 0.3) drawTent(front, t);
  }
  R.add(back, [0, yD], { kind: 'sway', amp: 2.6, rate: 0.3, phase: PH3[0] });
  R.add(col, [0, 0], null);
  R.add(mid, [0, yD], { kind: 'sway', amp: 2.6, rate: 0.3, phase: PH3[1] });
  R.add(front, [0, yD], { kind: 'sway', amp: 2.2, rate: 0.3, phase: PH3[2] });
  return R.done('base');
};

// ---- giant clam ---------------------------------------------------------------------------------------
BUILDERS.giantClam = (id, opts) => {
  const R = new Rig(id, opts, 300, [-0.6, -0.08, 0.6, 0.66]);
  const { A, B, C, seed } = R;
  const HWID = 0.5;
  const YC = 0.165;
  const UY = -0.08; // the umbo (hinge) the folds radiate from
  const FA = 0.45; // angle between two folds
  const eT = (x) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / HWID, 2.3)), 1 / 2.3);
  const eB = (x) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / HWID, 2.9)), 1 / 2.9);
  const yRef = (x) => YC + 0.16 * eT(x);
  const foldAt = (x, y) => Math.cos((Math.atan2(x, y - UY) / FA) * TAU);
  const fold = (x) => foldAt(x, yRef(x));
  const yN = lut1((x) => yRef(x) + (0.052 * fold(x) + 0.01 * Math.cos((Math.atan2(x, yRef(x) - UY) / FA) * TAU * 2)) * Math.pow(eT(x), 0.8), -0.52, 0.52, 2048); // near valve margin
  const gap = (x) => 0.15 * Math.pow(eT(x), 1.3);
  const yF = lut1((x) => yN(x) + gap(x), -0.52, 0.52, 2048); // far valve margin: same folds, further from the viewer
  const yBot = lut1((x) => YC - 0.19 * eB(x), -0.52, 0.52, 2048);
  // distance from the umbo to the smooth margin for every direction (for growth lines)
  const RT = new Float32Array(257);
  for (let i = 0; i <= 256; i++) {
    const phi = -1.5 + (3 * i) / 256;
    let lo = 0;
    let hi = 0.9;
    for (let k = 0; k < 20; k++) {
      const r = (lo + hi) / 2;
      const x = r * Math.sin(phi);
      const y = UY + r * Math.cos(phi);
      if (Math.abs(x) < HWID && y < yRef(x)) lo = r;
      else hi = r;
    }
    RT[i] = lo;
  }
  const rhoAt = (x, y) => {
    const phi = Math.atan2(x, y - UY);
    const f = clamp((phi + 1.5) / 3) * 256;
    const i = Math.min(255, Math.floor(f));
    return Math.hypot(x, y - UY) / (RT[i] + (RT[i + 1] - RT[i]) * (f - i) + 1e-6);
  };
  const shellCol = (x, y, k) => {
    let c = mul3(mix3(C, [0.93, 0.8, 0.56], 0.35), 0.9 + 0.2 * organic(x * 5, y * 5, seed, 3));
    c = mix3(c, [0.42, 0.4, 0.22], 0.55 * k * smoothstep(0.42, 0.7, organic(x * 9 + 4, y * 9, seed + 3, 3)));
    c = mix3(c, [0.72, 0.42, 0.46], 0.35 * k * smoothstep(0.6, 0.78, organic(x * 14, y * 14 + 9, seed + 5, 2)));
    return c;
  };
  // ---- far valve: its scalloped rim shows above the mantle
  const far = R.layer();
  const topF = lut1((x) => yF(x) + 0.036 * (0.7 + 0.3 * fold(x)) * Math.pow(eT(x), 0.6), -0.52, 0.52, 2048);
  far.field([-0.56, 0.0, 0.56, 0.62], (x, y) => {
    if (Math.abs(x) >= HWID) return -1;
    const t = topF(x);
    const b = yN(x) - 0.02;
    if (y > t || y < b) return -1;
    const r = (t - y) / 0.045;
    return 0.022 * Math.sqrt(clamp(r * (2 - r))) + 0.02 + 0.014 * foldAt(x, y);
  }, (x, y) => {
    const r = (topF(x) - y) / 0.045;
    let c = shellCol(x, y + 0.3, 0.3);
    c = mul3(c, 0.62 + 0.38 * smoothstep(1.3, 0.0, r));
    c = mul3(c, 0.92 + 0.08 * Math.sin(r * 9));
    return c;
  }, { gloss: 0.2, sheen: 0.1, ao: (x, y) => 0.6 + 0.4 * smoothstep(-0.6, 0.6, foldAt(x, y)), dim: 0.08 });
  // ---- mantle
  const man = R.layer();
  const ovN = (x) => 0.03 + 0.011 * Math.sin(x * 73 + 2 * Math.sin(x * 31)) + 0.004 * Math.sin(x * 190);
  const mLo = lut1((x) => yN(x) - ovN(x) * eT(x), -0.52, 0.52, 4096);
  const mHi = lut1((x) => yF(x) + (0.008 + 0.005 * Math.sin(x * 88 + 1)) * eT(x), -0.52, 0.52, 4096);
  const XM = 0.47;
  const zMan = (x, y) => {
    if (Math.abs(x) >= XM) return -1;
    const lo = mLo(x);
    const hi = mHi(x);
    if (y < lo || y > hi) return -1;
    const m = (y - lo) / (hi - lo);
    const l1 = 1 - Math.pow((m - 0.27) / 0.275, 2);
    const l2 = 1 - Math.pow((m - 0.76) / 0.245, 2);
    const l = Math.sqrt(Math.max(0, l1, l2 * 0.8));
    const endT = Math.pow(clamp((XM - Math.abs(x)) / 0.07), 0.5);
    return (0.004 + 0.06 * l * (0.84 + 0.16 * Math.sin(x * 46 + 3 * m + 2 * Math.sin(x * 17)))) * endT * Math.min(1, (hi - lo) / 0.07);
  };
  man.field([-0.5, 0.0, 0.5, 0.6], zMan, (x, y, z, n) => {
    const lo = mLo(x);
    const hi = mHi(x);
    const m = (y - lo) / (hi - lo);
    const n1 = organic(x * 6.5, y * 9, seed + 1, 3);
    let c = mix3(A, B, smoothstep(0.42, 0.6, n1));
    c = saturate(mul3(c, 0.95 + 0.4 * organic(x * 15, y * 15, seed + 2, 2)), 1.15);
    // dark reticulation
    const w = worley(x * 24, y * 34, seed + 7);
    c = mix3(c, [0.03, 0.05, 0.22], 0.6 * smoothstep(0.1, 0.02, w.f2 - w.f1));
    // iridescent spots
    const sp = worley(x * 52 + 3, y * 66, seed + 9);
    const hot = sp.id > 0.5 ? [0.35, 1.0, 0.9] : sp.id > 0.25 ? [0.95, 0.95, 0.35] : [0.5, 0.75, 1.0];
    c = mix3(c, hot, smoothstep(0.2, 0.08, sp.f1) * (0.45 + 0.5 * sp.id));
    // rows of tiny eyes along both lips
    for (const mm of [0.1, 0.9]) {
      const ex = (fract(x / 0.032 + (mm > 0.5 ? 0.5 : 0)) - 0.5) * 0.032;
      const ey = (m - mm) * (hi - lo);
      const d = Math.hypot(ex, ey);
      c = mix3(c, [0.02, 0.03, 0.1], smoothstep(0.0085, 0.006, d) * 0.9);
      c = mix3(c, [0.45, 1.0, 1.0], smoothstep(0.0045, 0.0025, d));
    }
    // groove between the two lobes
    c = mul3(c, 1 - 0.55 * gauss(m - 0.53, 0.05));
    return c;
  }, { gloss: 0.75, sheen: 0.28, ao: (x, y) => 0.7 + 0.3 * smoothstep(0.0, 0.05, y - mLo(x)), edge: 0.3 });
  // siphons in the groove: a low exhalant cone and the long inhalant slit
  const midY = (x) => lerp(mLo(x), mHi(x), 0.53);
  const exX = -0.125;
  man.blob(exX, midY(exX) + 0.003, 0.034, 0.02, 0.12, (u, v) => {
    const d = Math.hypot(u * 0.8, v * 1.5 - 0.1);
    let c = mix3(mix3(A, B, 0.3), [0.75, 0.95, 0.9], 0.35 * smoothstep(0.75, 0.45, d));
    c = mix3(c, [0.02, 0.03, 0.08], smoothstep(0.42, 0.3, d));
    return c;
  }, { gloss: 0.35, sheen: 0.2, rz: 0.012, edge: 0.4 });
  man.region(0.0, 0.2, 0.3, 0.56, (x, y, out) => {
    const cx = clamp(x, 0.03, 0.25);
    const d = Math.hypot(x - cx, y - midY(x) + 0.002);
    const w = 0.008 * Math.sin(clamp((x - 0.02) / 0.24) * PI) + 0.002;
    if (d > w * 2) return false;
    const fr = 0.5 + 0.5 * Math.cos(x * 420);
    const c = d < w ? [0.015, 0.02, 0.06] : tone(mix3(mix3(A, B, 0.4), [0.9, 0.95, 0.8], 0.55 * fr));
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = d < w ? 0.9 : smoothstep(2, 1.3, d / w) * 0.85;
    return true;
  });
  // ---- near valve: the big fluted fan
  const near = R.layer();
  groundShadow(near, 0, 0.44, 0.026, 0.36);
  const zN = (x, y) => {
    if (Math.abs(x) >= HWID) return -1;
    const t = yN(x);
    const b = yBot(x);
    if (y > t || y < b) return -1;
    const v = (y - b) / (t - b);
    const rho = rhoAt(x, y);
    const rib = foldAt(x, y);
    let z = 0.2 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / HWID, 2.2)), 0.5) * Math.pow(Math.sin(PI * clamp(v * 0.8 + 0.14)), 0.55);
    z += 0.05 * rib * smoothstep(0.12, 0.7, rho) * (0.4 + 0.6 * rho);
    z += 0.0028 * Math.sin(rho * 58 + 3 * organic(x * 6, y * 6, seed + 11, 2));
    z += 0.012 * Math.pow(Math.max(0, rib), 2.5) * Math.pow(Math.max(0, Math.sin(rho * 34 - 1.2)), 5) * smoothstep(0.3, 0.55, rho);
    return Math.max(z, 0.0005);
  };
  near.field([-0.56, -0.05, 0.56, 0.46], zN, (x, y, z, n) => {
    const rho = rhoAt(x, y);
    const rib = foldAt(x, y);
    let c = shellCol(x, y, smoothstep(0.85, 0.3, rho) * (0.55 + 0.45 * smoothstep(0.5, -0.5, rib)));
    // growth lines, darker furrows, pale fresh lip
    c = mul3(c, 0.93 + 0.08 * Math.sin(rho * 58 + 3 * organic(x * 6, y * 6, seed + 11, 2)));
    c = mix3(c, mul3([0.62, 0.42, 0.22], 0.9), 0.4 * smoothstep(0.1, -0.95, rib));
    c = mix3(c, [1.0, 0.97, 0.9], 0.5 * smoothstep(0.9, 1.0, rho));
    return c;
  }, { gloss: 0.16, sheen: 0.12, edge: 0.3, relief: 1.25, ao: (x, y) => (0.6 + 0.4 * smoothstep(-0.03, 0.1, y)) * (0.8 + 0.2 * smoothstep(-0.9, 0.3, foldAt(x, y))) });
  R.add(far, [0, 0.3], null);
  R.add(man, [0, 0.32], { kind: 'pulse', amp: 0.018, rate: 0.22, phase: 0 });
  R.add(near, [0, 0], { kind: 'pulse', amp: 0.014, rate: 0.22, phase: 0 });
  return R.done('base');
};

// ---- cuttlefish -------------------------------------------------------------------------------------------
BUILDERS.cuttlefish = (id, opts) => {
  const R = new Rig(id, opts, 300, [-0.56, -0.3, 0.58, 0.28]);
  const { A, B, C, seed, S } = R;
  const X0 = -0.5;
  const X1 = 0.105;
  const HH = 0.142;
  const uOf = (x) => (x - X0) / (X1 - X0);
  const hhAt = (u) => HH * Math.pow(1 - Math.pow(1 - clamp(u), 2.7), 0.5) * (1 - 0.13 * smoothstep(0.62, 1, u)) * Math.sqrt(1 - 0.72 * Math.pow(clamp((u - 0.9) / 0.1), 2));
  const ycAt = (u) => 0.004 + 0.016 * Math.sin(PI * clamp(u));
  const midAt = (u) => ycAt(u) + hhAt(u) * 0.08;
  // the dorsal edge of the mantle reaches forward over the head, the ventral edge sits further back
  const mu = (x, y) => uOf(x - 0.03 * clamp((y - 0.0) / 0.11, -1, 1) * smoothstep(X1 - 0.16, X1, x));
  const skin = (u, s, k = 1) => {
    // mottled chromatophore pattern, fine zebra bands across the back, pale belly
    const n = organic(u * 7, s * 2.6, seed, 4);
    let c = mix3(A, B, smoothstep(0.52, 0.7, n) * 0.6);
    c = mix3(c, C, smoothstep(0.47, 0.3, n) * 0.55);
    const zb = Math.cos(u * TAU * 15 + 2.6 * Math.sin(s * 2.4 + u * 7) + 3 * organic(u * 4, s * 1.6, seed + 4, 2));
    const zk = k * smoothstep(-0.4, 0.0, s) * smoothstep(1.0, 0.75, s);
    c = mix3(c, mix3(B, [1, 0.97, 0.9], 0.3), smoothstep(0.35, 0.8, zb) * 0.7 * zk);
    c = mix3(c, mul3(C, 0.75), smoothstep(-0.2, -0.8, zb) * 0.4 * zk);
    const sp = worley(u * 95, s * 30, seed + 2);
    c = mul3(c, 1 - 0.3 * smoothstep(0.22, 0.08, sp.f1) * (sp.id > 0.4 ? 1 : 0));
    c = mul3(c, 0.84 + 0.2 * smoothstep(0.9, 0.2, s));
    c = mix3(c, mix3(B, [1, 1, 1], 0.4), smoothstep(-0.5, -0.92, s) * 0.8);
    return c;
  };
  // ---- arms and the two feeding tentacles (behind the head)
  const arms = R.layer();
  const armMat = (k, far) => (t, s) => {
    let c = skin(0.9 + t * 0.35 + k * 0.13, s * 0.75 + 0.2, 0.25);
    c = mix3(c, mix3(B, [1, 1, 1], 0.3), 0.5 * smoothstep(-0.35, -0.95, s));
    return far ? mul3(c, 0.8) : c;
  };
  // near-side arms from the dorsal one (k = 0) down to the broad ventral one (k = 3); tips gather into a cone
  const TIPS = [[0.468, 0.006], [0.496, -0.026], [0.5, -0.052], [0.47, -0.082]];
  const armPts = (k, off) => {
    const by = 0.05 - 0.031 * k + off;
    const tip = TIPS[k];
    const r0 = k === 3 ? 0.034 : k === 0 ? 0.026 : 0.03;
    return spline([
      [0.24, by, r0],
      [lerp(0.24, tip[0], 0.4), lerp(by, tip[1], 0.3) + 0.004, r0 * 0.86],
      [lerp(0.24, tip[0], 0.75), lerp(by, tip[1], 0.72) + 0.004, r0 * 0.5],
      [tip[0] + off, tip[1] + off * 0.5, 0.0035],
    ], 7);
  };
  for (let k = 0; k < 4; k++) arms.tube(armPts(k, 0.014), armMat(k + 0.5, true), { gloss: 0.3, dim: 0.45 });
  for (const tk of [0, 1]) {
    const y0 = -0.012 - tk * 0.02;
    const pts = spline([[0.25, y0, 0.009], [0.36, y0 - 0.014 - tk * 0.008, 0.0075], [0.44, y0 - 0.03 - tk * 0.01, 0.0075], [0.478, y0 - 0.04 - tk * 0.012, 0.0125], [0.506, y0 - 0.05 - tk * 0.014, 0.006]], 6);
    arms.tube(pts, (t) => mix3(mix3(A, B, 0.55), [1, 0.95, 0.9], 0.3 * smoothstep(0.75, 0.9, t)), { gloss: 0.3, dim: tk ? 0 : 0.2 });
  }
  for (const k of [0, 1, 2, 3]) arms.tube(armPts(k, 0), armMat(k, false), { gloss: 0.34, sheen: 0.16, ao: (t, s) => 0.72 + 0.28 * smoothstep(-0.9, 0.2, s) });
  // ---- far-side fin showing under the belly, mantle and head
  const body = R.layer();
  const WAVES = 6.5;
  const finBase = mix3(mix3(A, B, 0.6), [1, 0.96, 0.9], 0.2);
  const head = { x: 0.182, y: -0.008, rx: 0.106, ry: 0.103 };
  const mantle = (x, y) => {
    const u = mu(x, y);
    if (u <= 0 || u >= 1) return -1;
    const hh = hhAt(u);
    const s = (y - midAt(u)) / hh;
    if (Math.abs(s) >= 1) return -1;
    return 0.125 * (hh / HH) * Math.sqrt(1 - s * s) * Math.pow(clamp((1 - u) / 0.04), 0.45) + 0.014;
  };
  const headZ = (x, y) => {
    const q = Math.pow((x - head.x) / head.rx, 2) + Math.pow((y - head.y) / head.ry, 2);
    return q < 1 ? 0.1 * Math.sqrt(1 - q) : -1;
  };
  const eye = { x: 0.208, y: 0.012, r: 0.043 };
  const finY = (u) => midAt(u) - hhAt(u) * 0.62; // where the near fin joins the flank
  body.field([-0.52, -0.18, 0.32, 0.2], (x, y) => Math.max(mantle(x, y), headZ(x, y)), (x, y, z, n) => {
    const zm = mantle(x, y);
    if (zm >= headZ(x, y)) {
      const u = mu(x, y);
      const hh = hhAt(u);
      const s = (y - midAt(u)) / hh;
      let c = skin(u, s);
      const w = worley(u * 40, s * 12, seed + 6);
      nudge(n, (w.px - u * 40) * 0.07, -(w.py - s * 12) * 0.07);
      // a loose row of pale spots just above the fin, collar at the free front edge
      const cell = Math.floor(u * 21);
      const jx = hash2(cell, 3, seed) - 0.5;
      const sr = Math.hypot(((fract(u * 21) - 0.5 - jx * 0.4) / 21) * (X1 - X0), y - finY(u) - 0.014 - 0.006 * hash2(cell, 5, seed));
      c = mix3(c, [1, 0.97, 0.9], 0.6 * smoothstep(0.0075, 0.0035, sr) * smoothstep(0.05, 0.12, u) * smoothstep(0.95, 0.88, u) * (hash2(cell, 9, seed) > 0.2 ? 1 : 0));
      c = mul3(c, 1 - 0.3 * smoothstep(0.92, 1.0, u));
      c = mix3(c, mix3(B, [1, 1, 1], 0.3), 0.5 * gauss(u - 0.94, 0.014));
      return c;
    }
    const hx = (x - head.x) / head.rx;
    const hy = (y - head.y) / head.ry;
    let c = skin(1.1 + hx * 0.18, hy * 0.9, 0.3);
    // darker mask around the eye, shadow under the mantle edge
    const ed = Math.hypot(x - eye.x, (y - eye.y) * 1.05) / eye.r;
    c = mix3(c, mul3(C, 0.65), 0.6 * smoothstep(1.9, 1.15, ed));
    c = mul3(c, 0.62 + 0.38 * smoothstep(0.0, 0.045, x - X1 - 0.03 * clamp(y / 0.11, -1, 1)));
    return c;
  }, { gloss: 0.42, sheen: 0.22, ao: (x, y) => 0.75 + 0.25 * smoothstep(-0.13, 0.0, y) });
  // eye with its W-shaped pupil and a heavy upper lid
  body.eye(eye.x, eye.y, eye.r, { pupil: 'w', iris: [0.92, 0.8, 0.45], seed, socket: 0.25 });
  body.region(eye.x - eye.r * 1.3, eye.y, eye.x + eye.r * 1.3, eye.y + eye.r * 1.4, (x, y, out) => {
    const ex = (x - eye.x) / eye.r;
    const ey = (y - eye.y) / eye.r;
    const lid = ey - (0.45 - 0.3 * ex * ex);
    const d = Math.hypot(ex, ey);
    if (lid < 0 || d > 1.12) return false;
    const c = tone(lit(mul3(mix3(A, C, 0.6), 0.9), norm3([ex * 0.4, 0.5 + ey * 0.4, 0.75]), 0.3, 0.15, 1));
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = smoothstep(0.0, 0.1, lid) * smoothstep(1.12, 1.0, d);
    return true;
  });
  // ---- near fin skirt: a rippling translucent frill along the lower flank
  const fin = R.layer();
  fin.region(X0, -0.26, X1 + 0.03, 0.05, (x, y, out) => {
    const u = uOf(x);
    if (u < 0.015 || u > 0.99) return false;
    const yBase = finY(u);
    const fw = 0.07 * Math.pow(Math.sin(PI * clamp((u - 0.015) / 0.975)), 0.42);
    const ph = u * TAU * WAVES + 0.8 + 0.5 * Math.sin(u * 9);
    const wave = Math.sin(ph);
    const yEdge = yBase - fw * (0.78 + 0.28 * wave);
    if (y < yEdge || y > yBase + 0.012) return false;
    const r = (yBase - y) / (yBase - yEdge);
    const rc = clamp(r);
    // fine rays fanning with the ripple, folds of the travelling wave catching the light
    let c = membrane(finBase, x * 360 + rc * 2.4 * Math.cos(ph), rc, smoothstep(0.86, 1.0, r));
    c = mul3(c, 0.84 + 0.3 * Math.cos(ph + 1.2) * rc);
    c = mix3(c, mul3(C, 0.9), 0.22 * gauss(r - 0.8, 0.05));
    c = tone(c);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = lerp(0.82, 0.6, smoothstep(0.1, 0.9, rc)) * smoothstep(-0.2, 0.16, r) * (0.9 + 0.1 * Math.cos(x * 360));
    return true;
  });
  const finImg = fin.resolve();
  const pxOf = (u) => R.toPx([X0 + u * (X1 - X0), 0])[0];
  const [f1, rest] = split(finImg, (px) => smoothstep(pxOf(0.64), pxOf(0.7), px));
  const [f2, f3] = split(rest, (px) => smoothstep(pxOf(0.31), pxOf(0.37), px));
  const finPivot = (u) => [X0 + u * (X1 - X0), finY(u)];
  R.add(arms, [0.26, -0.01], { kind: 'sway', amp: 3, rate: 0.4, phase: 0 });
  R.add(body, [0, 0], null);
  R.add(f3, finPivot(0.17), { kind: 'pulse', amp: 0.1, rate: 1.1, phase: PH3[0] });
  R.add(f2, finPivot(0.5), { kind: 'pulse', amp: 0.1, rate: 1.1, phase: PH3[1] });
  R.add(f1, finPivot(0.83), { kind: 'pulse', amp: 0.1, rate: 1.1, phase: PH3[2] });
  return R.done('center');
};

// ---- rays (three-quarter view from slightly above) -------------------------------------------------------
const RAY_EL = 0.5;
const RAY_SE = Math.sin(RAY_EL);
const RAY_CE = Math.cos(RAY_EL);
/** Small raised eye with a dark spiracle behind it, for an oblique-view ray. */
function rayEye(P, x, y, r, side, iris) {
  P.darken([x - r * 4.2, y - r * 2, x + r, y + r * 2], (px, py) => 0.85 * smoothstep(1, 0.45, Math.hypot((px - x + r * 2.3) / (r * 1.45), (py - y - r * 0.2 * side) / (r * 0.95))));
  P.eye(x, y, r, { iris, pr: 0.5, socket: 0.35 });
}

BUILDERS.bluespottedRay = (id, opts) => {
  const R = new Rig(id, opts, 320, [-0.56, -0.24, 0.56, 0.24]);
  const { A, B, C, seed } = R;
  const Xc = 0.25;
  const a = 0.245;
  const b = 0.215;
  const p = 2.08;
  const foot = (X, Z) => {
    const x = (X - Xc) / a;
    const z = Z / (b * (1 - 0.1 * x) * (1 - 0.22 * smoothstep(0.4, 1, x)));
    return Math.pow(Math.pow(Math.abs(x), p) + Math.pow(Math.abs(z), p), 1 / p);
  };
  const pelv = (X, Z) => Math.hypot((X - 0.03) / 0.062, (Math.abs(Z) - 0.066) / 0.046);
  const EX = Xc + 0.105;
  const EZ = 0.058;
  const h = (X, Z) => {
    const rho = Math.min(1, foot(X, Z)); // flat beyond the outline, so thin margins are never stepped over
    const x = (X - Xc) / a;
    const th = Math.atan2(Z, X - Xc);
    let v = 0.024 * (1 - Math.pow(rho, 2.2));
    v += 0.06 * gauss(Z, 0.07) * smoothstep(1.0, 0.3, x) * (0.6 + 0.4 * smoothstep(-1.0, 0.0, x));
    v += 0.022 * rho * rho * rho * Math.sin(th * 4 + 0.9);
    v += 0.02 * gauss(Math.hypot(X - EX, Math.abs(Z) - EZ), 0.024);
    const rp = pelv(X, Z);
    return smax(v, 0.003 + 0.009 * Math.max(0, 1 - rp * rp), 0.006);
  };
  const inside = (X, Z) => foot(X, Z) < 1 || pelv(X, Z) < 1;
  const box = [Xc - a - 0.06, -b * RAY_SE - 0.05, Xc + a + 0.02, b * RAY_SE + 0.09];
  const disc = R.layer();
  disc.oblique(box, RAY_EL, h, -0.06, 0.1, (X, Z, Y, n) => {
    const rho = foot(X, Z);
    const x = (X - Xc) / a;
    let c = mix3(mul3(A, 0.86), mul3(A, 0.5), 0.6 * smoothstep(0.4, 0.7, organic(X * 9, Z * 9, seed, 3)));
    c = mix3(c, mix3(A, [0.85, 0.72, 0.3], 0.5), 0.4 * smoothstep(0.6, 1.0, Math.min(rho, 1)));
    c = mul3(c, 1 - 0.28 * gauss(Z, 0.05) * smoothstep(0.9, 0.2, x));
    // electric-blue spots, larger toward the middle of the disc
    const w = worley(X * 17 + 1.7, Z * 17, seed + 3);
    const rad = (0.15 + 0.17 * w.id) * (1.05 - 0.4 * Math.min(1, rho));
    if (w.id > 0.16) {
      c = mul3(c, 1 - 0.4 * smoothstep(rad + 0.14, rad + 0.03, w.f1));
      const spot = smoothstep(rad + 0.02, rad - 0.05, w.f1);
      c = mix3(c, mix3(saturate(B, 1.2), [0.7, 0.93, 1.0], 0.3 * smoothstep(rad * 0.6, 0, w.f1)), spot);
    }
    const sk = worley(X * 80, Z * 80, seed + 5);
    c = mul3(c, 0.95 + 0.08 * smoothstep(0.1, 0.4, sk.f1));
    return c;
  }, { gloss: 0.42, sheen: 0.22, inside, steps: 10, ao: (X, Z, Y) => 0.72 + 0.28 * smoothstep(0.0, 0.03, Y + 0.012) });
  // pale underside showing as a thin rim along the near edge
  disc.oblique(box, RAY_EL, (X, Z) => h(X, Z) - 0.006, -0.06, 0.09, () => mix3(C, A, 0.2), { gloss: 0.2, sheen: 0.1, ao: 0.75, inside, steps: 10, mode: 1, flat: true });
  for (const side of [-1, 1]) {
    const ey = (h(EX, side * EZ) - 0.004) * RAY_CE - side * (EZ + 0.012) * RAY_SE;
    rayEye(disc, EX + 0.004, ey, 0.0135, side, [0.75, 0.6, 0.25]);
  }
  // ---- whip tail with blue side stripes, a fin fold and the barb
  const tail = R.layer();
  const ctrl = [];
  for (let k = 0; k <= 14; k++) {
    const t = k / 14;
    const X = 0.05 - 0.55 * t;
    const Z = 0.03 * Math.sin(t * 5.2 + 0.4) * smoothstep(0.02, 0.4, t);
    ctrl.push([X, 0.012 * RAY_CE - Z * RAY_SE, lerp(0.021, 0.0028, Math.pow(t, 0.62))]);
  }
  const tp = spline(ctrl, 4);
  tail.tube(tp.map((q, i) => [q[0], q[1] - q[2] * 1.3 * smoothstep(0.45, 0.6, i / tp.length), q[2] * 0.9 * smoothstep(0.42, 0.6, i / tp.length) * smoothstep(1.0, 0.9, i / tp.length) + 0.0005]), () => mix3(mul3(B, 0.4), [0.05, 0.1, 0.25], 0.5), { gloss: 0.3, round: 0.5 });
  tail.tube(tp, (t, sN) => {
    let c = mix3(A, mul3(A, 0.7), 0.4 * organic(t * 30, sN, seed + 8, 2));
    c = mix3(c, B, smoothstep(0.3, 0.5, Math.abs(sN)) * smoothstep(0.92, 0.75, Math.abs(sN)) * 0.95);
    return c;
  }, { gloss: 0.4, sheen: 0.2 });
  const bq = along(tp, 0.4);
  tail.tube([[bq[0] + 0.01, bq[1] + 0.006, 0.0045], [bq[0] - 0.035, bq[1] + 0.012, 0.0032], [bq[0] - 0.08, bq[1] + 0.013, 0.0008]], () => [0.85, 0.8, 0.66], { gloss: 0.5, edge: 0 });
  R.add(tail, [0.045, 0.01], { kind: 'sway', amp: 5, rate: 0.45, phase: 0 });
  R.add(disc, [Xc, 0], { kind: 'pulse', amp: 0.03, rate: 0.7, phase: 0 });
  return R.done('center');
};

BUILDERS.electricRay = (id, opts) => {
  const R = new Rig(id, opts, 320, [-0.56, -0.26, 0.56, 0.27]);
  const { A, B, C, seed } = R;
  const Xc = 0.2;
  const a = 0.295;
  const b = 0.285;
  const foot = (X, Z) => {
    const x = (X - Xc) / a;
    const z = Z / (b * (1 - 0.08 * x * x));
    return Math.pow(Math.pow(Math.abs(x), 2.15) + Math.pow(Math.abs(z), 2.15), 1 / 2.15);
  };
  const pelv = (X, Z) => Math.hypot((X + 0.115) / 0.11, Z / 0.15);
  const EX = Xc + 0.165;
  const EZ = 0.036;
  const kidney = (X, Z) => gauss(Math.hypot((X - Xc - 0.02) / 1.5, Math.abs(Z) - 0.13), 0.06);
  const h = (X, Z) => {
    const rho = Math.min(1, foot(X, Z));
    const x = (X - Xc) / a;
    const th = Math.atan2(Z, X - Xc);
    let v = 0.05 * Math.pow(1 - Math.pow(rho, 2.6), 0.7);
    v += 0.03 * gauss(Z, 0.1) * smoothstep(1.0, 0.2, x);
    v += 0.007 * kidney(X, Z);
    v += 0.008 * rho * rho * rho * Math.sin(th * 2 + 0.5);
    v += 0.012 * gauss(Math.hypot(X - EX, Math.abs(Z) - EZ), 0.018);
    const rp = pelv(X, Z);
    return smax(v, 0.004 + 0.032 * Math.pow(Math.max(0, 1 - rp * rp), 0.7), 0.008);
  };
  const inside = (X, Z) => foot(X, Z) < 1 || pelv(X, Z) < 1;
  const pattern = (X, Z) => {
    const n = organic(X * 8, Z * 8, seed, 4);
    let c = mix3(mul3(A, 0.7), mul3(B, 0.85), smoothstep(0.56, 0.74, n) * 0.5);
    c = mix3(c, mul3(C, 0.9), smoothstep(0.47, 0.3, n) * 0.75);
    const w = worley(X * 15, Z * 15, seed + 2);
    c = mix3(c, mul3(C, 0.75), smoothstep(0.3, 0.16, w.f1) * (w.id > 0.55 ? 0.75 : 0));
    c = mix3(c, B, smoothstep(0.16, 0.07, w.f1) * (w.id < 0.3 ? 0.7 : 0));
    // the cool water light greys brown skin: push the warmth back in
    return saturate([c[0] * 1.08, c[1] * 0.98, c[2] * 0.88], 1.45);
  };
  const box = [-0.27, -b * RAY_SE - 0.06, Xc + a + 0.02, b * RAY_SE + 0.11];
  const bound = (x, y) => x < Xc - 0.2 ? Math.abs(y) < 0.12 : Math.pow((x - Xc) / (a + 0.015), 2) + Math.pow((y - 0.03) / (b * RAY_SE + 0.075), 2) < 1;
  const disc = R.layer();
  disc.oblique(box, RAY_EL, h, -0.04, 0.11, (X, Z, Y, n) => {
    const rho = foot(X, Z);
    let c = pattern(X, Z);
    c = mix3(c, B, 0.25 * smoothstep(0.85, 1.0, Math.min(rho, 1)));
    c = mul3(c, 1 + 0.12 * kidney(X, Z));
    const sk = worley(X * 70, Z * 70, seed + 5);
    c = mul3(c, 0.95 + 0.08 * smoothstep(0.1, 0.4, sk.f1));
    return c;
  }, { gloss: 0.36, sheen: 0.22, inside, bound, steps: 8, ao: (X, Z, Y) => 0.7 + 0.3 * smoothstep(0.0, 0.04, Y) });
  // fleshy edge: the paler underside shows below the rim
  disc.oblique(box, RAY_EL, (X, Z) => h(X, Z) - 0.012, -0.06, 0.1, () => mix3(mix3(B, A, 0.3), [1, 0.95, 0.9], 0.2), { gloss: 0.2, sheen: 0.1, ao: 0.72, inside, bound, steps: 8, mode: 1, flat: true });
  for (const side of [-1, 1]) {
    const ey = (h(EX, side * EZ) - 0.003) * RAY_CE - side * (EZ + 0.006) * RAY_SE;
    rayEye(disc, EX + 0.003, ey, 0.0105, side, [0.6, 0.5, 0.3]);
  }
  // ---- short thick tail: two small dorsal fins and a paddle
  const tail = R.layer();
  const tw = (X) => lerp(0.07, 0.03, Math.pow(clamp((-0.12 - X) / 0.3), 0.8));
  const th = (X) => lerp(0.056, 0.03, Math.pow(clamp((-0.12 - X) / 0.3), 0.8));
  const twE = (X) => tw(X) * Math.pow(clamp((X + 0.45) / 0.03), 0.5) + 1e-4;
  const hT = (X, Z) => {
    const q = 1 - Math.pow(Z / twE(X), 2);
    return q > 0 ? th(X) * Math.sqrt(q) : th(X) * q;
  };
  const insT = (X, Z) => X < -0.02 && X > -0.45 && Math.abs(Z) < twE(X);
  const yTop = (X) => th(X) * RAY_CE;
  const fin = (pts, k) => {
    const poly = smoothPoly(pts, 2);
    tail.poly(poly, (x, y, d, out) => {
      const edge = smoothstep(0.012, 0.0, d);
      let c = lit(mul3(pattern(x * 1.3 + 1, y * 1.3), k), norm3([-0.2 - edge * 0.3, -0.05 + edge * 0.4, 0.95]), 0.25, 0.16, 1);
      c = mix3(c, mul3(B, 1.1), 0.25 * edge);
      c = tone(c);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = 1;
      return true;
    });
  };
  // caudal paddle (behind the stalk)
  fin([[-0.39, yTop(-0.39) - 0.006], [-0.43, 0.088], [-0.482, 0.098], [-0.506, 0.05], [-0.502, -0.012], [-0.47, -0.05], [-0.425, -0.04], [-0.385, -0.008]], 0.95);
  tail.oblique([-0.47, -0.09, 0.0, 0.11], RAY_EL, hT, 0, 0.065, (X, Z) => pattern(X, Z), { gloss: 0.34, sheen: 0.2, inside: insT, ao: (X, Z, Y) => 0.7 + 0.3 * smoothstep(0.0, 0.03, Y) });
  for (const [fx, k] of [[-0.2, 1.3], [-0.3, 1.1]]) {
    const yb = yTop(fx) - 0.008;
    fin([[fx + 0.035 * k, yb], [fx + 0.012 * k, yb + 0.04 * k], [fx - 0.02 * k, yb + 0.058 * k], [fx - 0.042 * k, yb + 0.046 * k], [fx - 0.036 * k, yb + 0.012 * k], [fx - 0.03 * k, yb - 0.004]], 0.9);
  }
  R.add(tail, [-0.1, 0.02], { kind: 'sway', amp: 6, rate: 0.5, phase: 0 });
  R.add(disc, [Xc, 0], { kind: 'pulse', amp: 0.025, rate: 0.55, phase: 0 });
  return R.done('center');
};

BUILDERS.guitarfish = (id, opts) => {
  const R = new Rig(id, opts, 400, [-0.56, -0.2, 0.56, 0.24]);
  const { A, B, C, seed, S } = R;
  const EL = 0.47;
  const se = Math.sin(EL);
  const ce = Math.cos(EL);
  // half width of the outline and of the thick trunk along the body (top view)
  const table = (pts) => {
    const sp = spline(pts.map((q) => [q[0], q[1]]), 8);
    const N = 1024;
    const xa = sp[sp.length - 1][0];
    const xb = sp[0][0];
    const lut = new Float32Array(N + 1);
    let j = 0;
    for (let i = 0; i <= N; i++) {
      const X = xb + ((xa - xb) * i) / N;
      while (j < sp.length - 2 && sp[j + 1][0] > X) j++;
      lut[i] = lerp(sp[j][1], sp[j + 1][1], clamp((sp[j][0] - X) / (sp[j][0] - sp[j + 1][0] + 1e-9)));
    }
    return (X) => {
      const f = clamp((xb - X) / (xb - xa)) * N;
      const i = Math.min(N - 1, Math.floor(f));
      return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
    };
  };
  const wOut = table([[0.5, 0.0], [0.485, 0.012], [0.44, 0.03], [0.36, 0.07], [0.26, 0.122], [0.17, 0.16], [0.11, 0.168], [0.065, 0.14], [0.04, 0.085], [0.01, 0.062], [-0.025, 0.08], [-0.06, 0.09], [-0.095, 0.062], [-0.13, 0.047], [-0.24, 0.037], [-0.34, 0.025], [-0.42, 0.016], [-0.47, 0.011]]);
  const wTrunk = table([[0.5, 0.0], [0.47, 0.01], [0.38, 0.022], [0.28, 0.045], [0.18, 0.06], [0.06, 0.064], [-0.05, 0.056], [-0.13, 0.047], [-0.24, 0.037], [-0.34, 0.025], [-0.42, 0.016], [-0.47, 0.011]]);
  const hTrunk = table([[0.5, 0.004], [0.44, 0.012], [0.34, 0.026], [0.24, 0.044], [0.14, 0.058], [0.04, 0.064], [-0.08, 0.058], [-0.2, 0.046], [-0.32, 0.033], [-0.42, 0.022], [-0.47, 0.016]]);
  const EX = 0.215;
  const EZ = 0.047;
  const h = (X, Z) => {
    const w = Math.max(1e-4, wOut(X));
    const az = Math.abs(Z);
    const wt = Math.min(w, Math.max(1e-4, wTrunk(X))); // never wider than the outline, or the edge would be a wall
    const ht = hTrunk(X);
    const qp = 1 - Math.pow(az / w, 2.6);
    const plate = 0.016 * Math.pow(Math.max(0, qp), 0.8) * smoothstep(0.5, 0.42, X);
    const qt = az / wt;
    const trunk = qt < 1 ? ht * Math.sqrt(1 - qt * qt) : -(qt - 1) * wt;
    let v = smax(plate, trunk, 0.012);
    v += 0.012 * gauss(Math.hypot(X - EX, az - EZ), 0.018);
    return v * Math.pow(clamp((X + 0.47) / 0.02), 0.5);
  };
  const inside = (X, Z) => X < 0.5 && X > -0.47 && Math.abs(Z) < wOut(X);
  // the flank is steep: unwrap it so the markings do not stretch
  const unwrap = (X, Z) => {
    const wt = Math.min(Math.max(1e-4, wOut(X)), Math.max(1e-4, wTrunk(X)));
    const az = Math.abs(Z);
    return Math.sign(Z) * (az < wt ? wt * Math.asin(az / wt) * (1 + 0.6 * hTrunk(X) / wt) : az + wt * 0.57 * (1 + 0.6 * hTrunk(X) / wt));
  };
  const skinCol = (X, Z0) => {
    const az = Math.abs(Z0);
    const Z = unwrap(X, Z0);
    let c = mix3(mul3(A, 0.84), mul3(C, 1.0), 0.5 * smoothstep(0.42, 0.72, organic(X * 9, Z * 9, seed, 3)));
    // translucent paler snout either side of the rostral ridge
    c = mix3(c, mix3(A, [0.95, 0.8, 0.7], 0.55), smoothstep(0.24, 0.42, X) * smoothstep(0.008, 0.03, az) * 0.65);
    // rows of white spots on the flanks and wings, a dark blotch at each pectoral base
    const w = worley(X * 21, Z * 21, seed + 4);
    c = mix3(c, B, smoothstep(0.2, 0.11, w.f1) * (w.id > 0.35 ? 0.9 : 0) * smoothstep(0.3, 0.16, X));
    const bl = Math.hypot((X - 0.1) / 0.03, (az - 0.085) / 0.022);
    c = mix3(c, mul3(C, 0.45), smoothstep(1.0, 0.5, bl) * 0.85);
    c = mix3(c, B, smoothstep(0.35, 0.2, Math.abs(bl - 1.5)) * smoothstep(0.55, 0.85, Math.cos(Math.atan2((az - 0.085) / 0.022, (X - 0.1) / 0.03) * 5 + 0.6)) * 0.9);
    c = mul3(c, 1 - 0.16 * gauss(Z, 0.014) * smoothstep(0.45, 0.2, X));
    return saturate([c[0] * 1.05, c[1] * 0.99, c[2] * 0.92], 1.25);
  };
  const P = R.layer();
  const box = [-0.5, -0.19, 0.52, 0.2];
  // vertical fins stand on the ridge; they are drawn in the (X, up) plane
  const top = (X) => hTrunk(X) * ce;
  const fin = (pts, k) => {
    const poly = smoothPoly(pts, 2);
    P.poly(poly, (x, y, d, out) => {
      const edge = smoothstep(0.014, 0.0, d);
      const f0 = mix3(mul3(A, 0.84), C, 0.25 + 0.3 * organic(x * 14, y * 14, seed + 7, 2));
      const fc = saturate([f0[0] * 1.05, f0[1] * 0.99, f0[2] * 0.92], 1.25);
      let c = lit(mul3(fc, k), norm3([-0.15 - edge * 0.3, 0.0 + edge * 0.4, 0.95]), 0.25, 0.16, 1);
      c = mix3(c, mul3(A, 1.2), 0.3 * edge);
      c = mul3(c, 0.93 + 0.07 * Math.cos((x * 1.5 + y) * 260));
      c = tone(c);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = 1;
      return true;
    });
  };
  // shark-like tail fin (behind the peduncle)
  const ty = top(-0.44);
  fin([[-0.4, ty + 0.004], [-0.44, ty + 0.05], [-0.487, ty + 0.108], [-0.505, ty + 0.118], [-0.497, ty + 0.07], [-0.468, ty + 0.012], [-0.49, ty - 0.03], [-0.482, ty - 0.058], [-0.45, ty - 0.036], [-0.41, ty - 0.022]], 0.95);
  P.oblique(box, EL, h, -0.03, 0.09, (X, Z, Y, n) => {
    let c = skinCol(X, Z);
    const sk = worley(X * 110, Z * 110, seed + 5);
    c = mul3(c, 0.94 + 0.1 * smoothstep(0.1, 0.4, sk.f1));
    return c;
  }, { gloss: 0.3, sheen: 0.2, inside, steps: 10, ao: (X, Z, Y) => 0.72 + 0.28 * smoothstep(0.0, 0.03, Y) });
  for (const side of [-1, 1]) {
    const ey = (h(EX, side * EZ) - 0.004) * ce - side * (EZ + 0.006) * se;
    rayEye(P, EX + 0.003, ey, 0.0095, side, [0.7, 0.6, 0.3]);
  }
  for (const [fx, k] of [[-0.085, 1], [-0.27, 0.82]]) {
    const yb = top(fx) - 0.008;
    fin([[fx + 0.045 * k, yb], [fx + 0.02 * k, yb + 0.045 * k], [fx - 0.03 * k, yb + 0.095 * k], [fx - 0.052 * k, yb + 0.092 * k], [fx - 0.046 * k, yb + 0.04 * k], [fx - 0.06 * k, yb + 0.006], [fx - 0.03 * k, yb - 0.004]], 0.93);
  }
  // pale underside as a thin rim along the near edge
  P.oblique(box, EL, (X, Z) => h(X, Z) - 0.006, -0.04, 0.09, () => mix3(B, A, 0.3), { gloss: 0.2, sheen: 0.1, ao: 0.75, inside, steps: 10, mode: 1, flat: true });
  // ---- rig: tail + undulating rear strips + rigid front, like the slender fish
  const img = P.resolve();
  const xpx = (X) => R.toPx([X, 0])[0];
  const ov = Math.max(3, Math.round(S * 0.02));
  const tailX = Math.round(xpx(-0.385));
  const uStart = 0.45;
  const xStart = Math.round(xpx(0.5 - uStart));
  const strips = 5;
  const tailAmp = S * 0.03;
  const env = (u) => Math.pow(clamp((u - uStart) / (1 - uStart)), 1.4);
  const lagOf = (u) => clamp((u - uStart) / (1 - uStart)) * TAU * 0.8;
  const win = (a0, b0, feather) => (px) => (px >= b0 ? 0 : px >= a0 ? 1 : feather > 0 && px > a0 - feather ? (px - (a0 - feather)) / feather : 0);
  R.add(masked(img, win(-1e9, tailX + ov, 0)), [-0.385, 0], { kind: 'tail', rot: 7, squash: 0.32, phase: 0, amp: tailAmp * env(0.885), lag: lagOf(0.885) });
  for (let k = 0; k < strips; k++) {
    const a0 = tailX + Math.round(((xStart - tailX) * k) / strips);
    const b0 = tailX + Math.round(((xStart - tailX) * (k + 1)) / strips);
    const cx = (a0 + b0) / 2;
    const X = (cx - R.view.ox) / S;
    const u = 0.5 - X;
    R.add(masked(img, win(a0, b0, ov)), [X, 0], { kind: 'wave', amp: tailAmp * env(u), lag: lagOf(u) });
  }
  R.add(masked(img, win(xStart, 1e9, ov)), [0, 0], null);
  return R.done('center');
};

// ---- crustacean helpers ----------------------------------------------------------------------------------
/** Jointed limb: one slightly swollen tube per segment so every joint reads. col(i, t, s) -> albedo. */
function limb(P, joints, radii, col, o = {}) {
  for (let i = 0; i < joints.length - 1; i++) {
    const a = joints[i];
    const b = joints[i + 1];
    const ra = radii[i];
    const rb = radii[i + 1];
    P.tube([[a[0], a[1], ra * 0.92], [lerp(a[0], b[0], 0.45), lerp(a[1], b[1], 0.45), Math.max(ra, rb) * 1.06], [b[0], b[1], rb * 0.92]], (t, sN, x, y, n) => col(i, t, sN), o);
  }
}
/** Long thin whip (antenna). */
function whip(P, ctrl, r0, r1, col, alpha = 1) {
  const pts = spline(ctrl.map((q) => [q[0], q[1]]), 8);
  const n = pts.length - 1;
  P.tube(pts.map((q, i) => [q[0], q[1], lerp(r0, r1, Math.pow(i / n, 0.6))]), (t, sN) => col, { gloss: 0.3, edge: 0, alpha, minPx: 0.6 });
}

BUILDERS.reefShrimp = (id, opts) => {
  const R = new Rig(id, opts, 220, [-0.62, -0.06, 1.02, 0.86]);
  const { A, B, C, seed, rnd } = R;
  const AL = 0.86;
  // body centre line from the tail fan forward
  const spine = spline([[-0.43, 0.165, 0.03], [-0.34, 0.215, 0.043], [-0.21, 0.262, 0.058], [-0.06, 0.283, 0.071], [0.09, 0.273, 0.08], [0.23, 0.256, 0.086], [0.35, 0.246, 0.07], [0.41, 0.24, 0.05]], 8);
  const flesh = (t, sN, k = 0) => {
    let c = mix3(mix3(A, C, 0.18), B, 0.1 + 0.35 * smoothstep(0.3, -0.7, sN));
    const dots = worley(t * 60 + k * 9, sN * 5, seed + 1);
    c = mix3(c, C, smoothstep(0.24, 0.08, dots.f1) * 0.75);
    return c;
  };
  const whisk = mix3(B, A, 0.3);
  // ---- antennae behind the body
  const antBack = R.layer();
  whip(antBack, [[0.4, 0.24], [0.52, 0.33], [0.55, 0.52], [0.38, 0.69], [0.08, 0.76], [-0.28, 0.7], [-0.5, 0.58]], 0.008, 0.0016, whisk, 0.95);
  // ---- body
  const body = R.layer();
  groundShadow(body, 0.03, 0.34, 0.02, 0.26);
  const legCol = (i, t, sN) => mix3(mix3(A, B, 0.55), C, 0.25 * smoothstep(0.7, 1, t) + (i === 0 ? 0.1 : 0));
  // far-side legs and swimmerets (dimmer)
  for (let i = 0; i < 5; i++) {
    const hx = 0.335 - 0.05 * i;
    limb(body, [[hx, 0.19], [hx + 0.045, 0.1], [hx + 0.02 - 0.012 * i, 0.012]], [0.009, 0.0075, 0.004], legCol, { gloss: 0.3, alpha: 0.9, dim: 0.5 });
  }
  // tail fan: telson and uropods
  const fanAt = along(spine, 0.0);
  for (const [da, len, wdt, dm] of [[0.5, 0.11, 0.03, 0.4], [-0.25, 0.12, 0.034, 0], [0.12, 0.105, 0.022, 0], [0.38, 0.12, 0.034, 0]]) {
    const ang = PI + 0.42 + da;
    const ex = fanAt[0] + Math.cos(ang) * len;
    const ey = fanAt[1] + Math.sin(ang) * len;
    body.tube([[fanAt[0] + 0.02, fanAt[1] + 0.006, wdt * 0.5], [lerp(fanAt[0], ex, 0.6), lerp(fanAt[1], ey, 0.6), wdt], [ex, ey, wdt * 0.55]], (t, sN) => {
      let c = mix3(B, A, 0.55);
      c = mix3(c, C, smoothstep(0.55, 0.9, t) * 0.75);
      c = mix3(c, [1, 0.97, 0.93], smoothstep(0.93, 1.0, t) * 0.8);
      return mul3(c, 0.92 + 0.1 * Math.cos(sN * 9));
    }, { round: 0.3, gloss: 0.4, alpha: 0.82, dim: dm, edge: 0.1 });
  }
  // swimmerets under the abdomen
  for (let i = 0; i < 5; i++) {
    const q = along(spine, 0.1 + i * 0.085);
    const bx = q[0];
    const by = q[1] - q[2] * 0.8;
    body.tube([[bx, by, 0.011], [bx - 0.022, by - 0.045, 0.012], [bx - 0.04, by - 0.075, 0.006]], () => mix3(A, B, 0.5), { round: 0.5, gloss: 0.3, alpha: 0.8 });
  }
  // abdomen: six overlapping plates, drawn tail first
  const segT = [0.0, 0.085, 0.175, 0.265, 0.36, 0.455, 0.56];
  for (let i = 0; i < 6; i++) {
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const q = along(spine, lerp(segT[i] - 0.012, segT[i + 1] + 0.012, k / 6));
      pts.push([q[0], q[1], q[2] * (1 + 0.07 * (k / 6))]);
    }
    body.tube(pts, (t, sN, x, y, n) => {
      let c = flesh(t + i, sN, i);
      // gut line under the back, a rusty band and pale rim at the plate's rear edge
      c = mix3(c, mul3(C, 0.55), 0.5 * gauss(sN - 0.42, 0.1));
      c = mix3(c, C, 0.55 * smoothstep(0.3, 0.05, t) * smoothstep(-0.9, 0.2, sN));
      c = mix3(c, [1, 0.97, 0.93], 0.6 * smoothstep(0.1, 0.0, t));
      return c;
    }, { gloss: 0.65, sheen: 0.25, alpha: AL, edge: 0.12 });
  }
  // carapace
  const cpts = [];
  for (let k = 0; k <= 10; k++) {
    const q = along(spine, lerp(0.545, 1, k / 10));
    cpts.push([q[0], q[1], q[2]]);
  }
  body.tube(cpts, (t, sN, x, y, n) => {
    let c = flesh(t * 2 + 9, sN, 7);
    // digestive gland showing through, pale saddle
    c = mix3(c, mul3(C, 0.6), 0.6 * smoothstep(1, 0.4, Math.hypot((x - 0.2) / 0.085, (y - 0.275) / 0.045)));
    c = mix3(c, [1, 0.97, 0.93], 0.45 * gauss(t - 0.05, 0.05));
    c = mix3(c, C, 0.4 * gauss(t - 0.45, 0.04) * smoothstep(-0.5, 0.5, sN));
    return c;
  }, { gloss: 0.7, sheen: 0.28, alpha: AL, edge: 0.12 });
  // rostrum, antennal scale, eye
  body.tube([[0.38, 0.285, 0.016], [0.45, 0.305, 0.009], [0.53, 0.325, 0.0015]], (t) => mix3(A, C, 0.3 + 0.4 * t), { gloss: 0.5, alpha: 0.95 });
  body.tube([[0.4, 0.225, 0.014], [0.47, 0.215, 0.02], [0.55, 0.21, 0.009]], (t, sN) => mix3(mix3(B, A, 0.4), [1, 1, 1], 0.2), { round: 0.3, gloss: 0.5, alpha: 0.8 });
  body.tube([[0.4, 0.262, 0.012], [0.428, 0.272, 0.011]], () => mix3(A, B, 0.4), { gloss: 0.3 });
  body.eye(0.436, 0.276, 0.021, { pupil: 'all', iris: [0.25, 0.12, 0.08] });
  // near-side legs
  for (let i = 0; i < 5; i++) {
    const hx = 0.35 - 0.05 * i;
    limb(body, [[hx, 0.185], [hx + 0.05 - 0.01 * i, 0.09], [hx + 0.035 - 0.022 * i, 0.0]], [0.0105, 0.0085, 0.004], legCol, { gloss: 0.35, alpha: 0.95 });
  }
  // ---- antennules and the forward antenna in front
  const antFront = R.layer();
  whip(antFront, [[0.42, 0.235], [0.56, 0.27], [0.72, 0.36], [0.86, 0.5], [0.95, 0.66]], 0.008, 0.0016, whisk, 0.95);
  whip(antFront, [[0.42, 0.25], [0.52, 0.3], [0.62, 0.4], [0.68, 0.52]], 0.006, 0.0014, whisk, 0.9);
  whip(antFront, [[0.42, 0.25], [0.54, 0.275], [0.66, 0.31], [0.76, 0.37]], 0.006, 0.0014, whisk, 0.9);
  R.add(antBack, [0.41, 0.24], { kind: 'sway', amp: 5, rate: 0.6, phase: PH2[0] });
  R.add(body, [0, 0.2], null);
  R.add(antFront, [0.42, 0.24], { kind: 'sway', amp: 6, rate: 0.7, phase: PH2[1] });
  return R.done('base');
};

BUILDERS.cleanerShrimp = (id, opts) => {
  const R = new Rig(id, opts, 210, [-0.78, -0.34, 0.98, 0.78]);
  const { A, B, C, seed } = R;
  const red = B;
  const white = mix3(A, [1, 1, 1], 0.3);
  const banded = (ph, w = 0.5) => (v) => (fract(v + ph) < w ? red : white);
  const spine = spline([[-0.43, -0.05, 0.022], [-0.36, 0.0, 0.034], [-0.27, 0.035, 0.045], [-0.17, 0.045, 0.055], [-0.06, 0.035, 0.062], [0.03, 0.022, 0.058], [0.1, 0.015, 0.04]], 8);
  // ---- back whiskers
  const antBack = R.layer();
  whip(antBack, [[0.1, 0.03], [0.16, 0.16], [0.12, 0.36], [-0.05, 0.54], [-0.3, 0.64], [-0.55, 0.62]], 0.007, 0.0017, white);
  whip(antBack, [[0.1, 0.03], [0.24, 0.16], [0.3, 0.36], [0.26, 0.56], [0.14, 0.7]], 0.007, 0.0017, white);
  whip(antBack, [[0.1, 0.02], [0.3, 0.1], [0.5, 0.24], [0.66, 0.42], [0.76, 0.6]], 0.007, 0.0017, white);
  // ---- body
  const body = R.layer();
  const legCol = (i, t) => mix3(white, [0.8, 0.9, 1.0], 0.2);
  for (let i = 0; i < 3; i++) {
    const hx = 0.02 - 0.05 * i;
    limb(body, [[hx, -0.02], [hx - 0.03, -0.12], [hx - 0.1 - 0.02 * i, -0.2], [hx - 0.13 - 0.03 * i, -0.27]], [0.008, 0.007, 0.005, 0.002], legCol, { gloss: 0.4, alpha: 0.9, dim: 0.25 });
  }
  // tail fan
  const fanAt = along(spine, 0.0);
  for (const [da, len, wdt] of [[-0.3, 0.09, 0.028], [0.1, 0.085, 0.02], [0.45, 0.09, 0.028]]) {
    const ang = PI + 0.5 + da;
    const ex = fanAt[0] + Math.cos(ang) * len;
    const ey = fanAt[1] + Math.sin(ang) * len;
    body.tube([[fanAt[0] + 0.02, fanAt[1] + 0.008, wdt * 0.5], [lerp(fanAt[0], ex, 0.6), lerp(fanAt[1], ey, 0.6), wdt], [ex, ey, wdt * 0.55]], (t) => mix3(white, red, smoothstep(0.3, 0.45, t) * smoothstep(0.85, 0.7, t)), { round: 0.3, gloss: 0.4, alpha: 0.9 });
  }
  // abdomen plates then carapace, with the three broad red bands
  const segT = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const bodyBand = (x) => smoothstep(0.03, 0.0, Math.abs(x + 0.33) - 0.045) + smoothstep(0.03, 0.0, Math.abs(x + 0.14) - 0.05) + smoothstep(0.03, 0.0, Math.abs(x - 0.035) - 0.04);
  for (let i = 0; i < 6; i++) {
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const q = along(spine, lerp(segT[i] - 0.012, segT[i + 1] + 0.012, k / 6));
      pts.push([q[0], q[1], q[2] * (1 + 0.07 * (k / 6))]);
    }
    body.tube(pts, (t, sN, x) => {
      let c = mix3(white, red, clamp(bodyBand(x)));
      c = mul3(c, 1 - 0.25 * smoothstep(0.12, 0.0, t));
      return c;
    }, { gloss: 0.6, sheen: 0.25, edge: 0.15 });
  }
  const cpts = [];
  for (let k = 0; k <= 10; k++) {
    const q = along(spine, lerp(0.585, 1, k / 10));
    cpts.push([q[0], q[1], q[2]]);
  }
  body.tube(cpts, (t, sN, x, y, n) => {
    let c = mix3(white, red, clamp(bodyBand(x)));
    const w = worley(x * 70, y * 70, seed);
    nudge(n, (w.px - x * 70) * 0.12, -(w.py - y * 70) * 0.12);
    return c;
  }, { gloss: 0.6, sheen: 0.25, edge: 0.15 });
  body.tube([[0.09, 0.035, 0.012], [0.14, 0.05, 0.007], [0.19, 0.062, 0.0015]], () => white, { gloss: 0.5 });
  body.tube([[0.1, 0.03, 0.01], [0.122, 0.04, 0.009]], () => white, { gloss: 0.3 });
  body.eye(0.128, 0.044, 0.016, { pupil: 'all', iris: [0.2, 0.1, 0.08] });
  // near walking legs
  for (let i = 0; i < 3; i++) {
    const hx = 0.04 - 0.055 * i;
    limb(body, [[hx, -0.025], [hx + 0.01, -0.13], [hx - 0.05 - 0.03 * i, -0.22], [hx - 0.07 - 0.04 * i, -0.3]], [0.009, 0.0075, 0.0055, 0.002], legCol, { gloss: 0.4, alpha: 0.95 });
  }
  // ---- the two big banded claw arms
  const clawArm = (P, off, k, dim) => {
    const j = [[0.03, -0.02 + off * 0.3], [0.17, -0.11 + off], [0.33, -0.045 + off * 1.2], [0.42, -0.035 + off * 1.2]];
    const bandF = banded(0.2 + (dim ? 0.3 : 0), 0.5);
    limb(P, j, [0.014 * k, 0.017 * k, 0.019 * k, 0.022 * k], (i, t) => bandF(i * 0.5 + t * (i === 0 ? 1.5 : 1.5)), { gloss: 0.55, sheen: 0.2, dim });
    // palm and the two long fingers
    const w0 = j[3];
    P.tube([[w0[0] - 0.01, w0[1], 0.022 * k], [w0[0] + 0.03, w0[1] + 0.003, 0.026 * k], [w0[0] + 0.065, w0[1] + 0.004, 0.017 * k]], (t) => (t < 0.55 ? white : red), { gloss: 0.6, sheen: 0.22, dim });
    P.tube([[w0[0] + 0.055, w0[1] + 0.012, 0.011 * k], [w0[0] + 0.1, w0[1] + 0.02, 0.008 * k], [w0[0] + 0.15, w0[1] + 0.012, 0.002]], (t) => (t < 0.4 ? red : white), { gloss: 0.6, dim });
    P.tube([[w0[0] + 0.055, w0[1] - 0.006, 0.012 * k], [w0[0] + 0.1, w0[1] - 0.012, 0.009 * k], [w0[0] + 0.152, w0[1] - 0.002, 0.002]], (t) => (t < 0.4 ? red : white), { gloss: 0.6, dim });
    return j[0];
  };
  const clawFar = R.layer();
  const pivF = clawArm(clawFar, 0.06, 0.92, 0.3);
  const clawNear = R.layer();
  const pivN = clawArm(clawNear, -0.02, 1, 0);
  // ---- front whiskers
  const antFront = R.layer();
  whip(antFront, [[0.11, 0.025], [0.3, 0.05], [0.52, 0.12], [0.72, 0.24], [0.88, 0.38]], 0.007, 0.0017, white);
  whip(antFront, [[0.1, 0.03], [0.1, 0.2], [0.0, 0.4], [-0.2, 0.52], [-0.42, 0.52], [-0.66, 0.44]], 0.007, 0.0017, white);
  whip(antFront, [[0.11, 0.03], [0.22, 0.2], [0.24, 0.42], [0.2, 0.6]], 0.0065, 0.0017, white);
  R.add(antBack, [0.1, 0.03], { kind: 'sway', amp: 6, rate: 0.5, phase: PH2[0] });
  R.add(clawFar, pivF, { kind: 'flap', amp: 4, rate: 0.4, phase: PH2[1] });
  R.add(body, [0, 0], null);
  R.add(clawNear, pivN, { kind: 'flap', amp: 4, rate: 0.4, phase: PH2[0] });
  R.add(antFront, [0.1, 0.03], { kind: 'sway', amp: 7, rate: 0.55, phase: PH2[1] });
  return R.done('center');
};

BUILDERS.paintedLobster = (id, opts) => {
  const R = new Rig(id, opts, 280, [-0.64, -0.06, 0.98, 1.06]);
  const { A, B, C, seed, rnd } = R;
  const pinkish = hex('#e9a7b5');
  const spine = spline([[-0.36, 0.175, 0.055], [-0.28, 0.235, 0.076], [-0.16, 0.275, 0.09], [-0.03, 0.292, 0.098], [0.1, 0.295, 0.104], [0.24, 0.29, 0.108], [0.36, 0.285, 0.098], [0.44, 0.283, 0.07]], 8);
  const legCol = (i, t) => {
    const blue = mix3(C, [0.1, 0.3, 0.75], 0.35);
    if (i === 2) return mix3(blue, B, 0.12); // the pointed foot is plain
    const bands = fract(t * (i === 0 ? 2.2 : 2.6) + i * 0.35);
    return mix3(blue, B, smoothstep(0.42, 0.5, bands) * smoothstep(1.0, 0.92, bands));
  };
  const legs = (P, far) => {
    for (let i = 0; i < 5; i++) {
      const hx = 0.37 - 0.075 * i;
      const k = far ? 0.9 : 1;
      const dz = far ? 0.03 : 0;
      limb(P, [[hx, 0.215 + dz], [hx + 0.085 - 0.022 * i, 0.135 + dz * 2.2], [hx + 0.1 - 0.05 * i + dz, 0.012 + dz * 1.2], [hx + 0.128 - 0.055 * i + dz, -0.008 + dz * 1.2]], [0.024 * k, 0.021 * k, 0.014 * k, 0.004], legCol, { gloss: 0.5, sheen: 0.2, dim: far ? 0.45 : 0, ao: 1 });
    }
  };
  const antenna = (P, ctrl, far) => {
    // thick spiny base, long white whip
    const b0 = ctrl[0];
    const b1 = ctrl[1];
    P.tube([[b0[0] - 0.02, b0[1], 0.027], [lerp(b0[0], b1[0], 0.5), lerp(b0[1], b1[1], 0.5), 0.025], [b1[0], b1[1], 0.019]], (t, sN) => mix3(mix3(mix3(pinkish, C, 0.45), C, 0.3 * smoothstep(0.2, 0.8, Math.abs(sN))), B, 0.3 * t), { gloss: 0.5, dim: far ? 0.4 : 0 });
    const pts = spline(ctrl.slice(1).map((q) => [q[0], q[1]]), 8);
    const n = pts.length - 1;
    P.tube(pts.map((q, i) => [q[0], q[1], lerp(0.016, 0.003, Math.pow(i / n, 0.55))]), (t, sN) => mul3(mix3(B, pinkish, 0.25 * smoothstep(0.3, 0.0, t)), 0.94 + 0.08 * Math.cos(t * 260)), { gloss: 0.4, edge: 0.1, dim: far ? 0.35 : 0 });
  };
  const antFar = R.layer();
  antenna(antFar, [[0.44, 0.32], [0.52, 0.39], [0.66, 0.55], [0.78, 0.74], [0.82, 0.91], [0.78, 1.01]], true);
  const legsFar = R.layer();
  legs(legsFar, true);
  // ---- body
  const body = R.layer();
  groundShadow(body, 0.05, 0.42, 0.024, 0.3);
  // tail fan (slightly drooping)
  const fanAt = along(spine, 0.0);
  for (const [da, len, wdt, dm] of [[0.66, 0.18, 0.048, 0.4], [-0.32, 0.185, 0.054, 0], [0.12, 0.18, 0.046, 0], [0.54, 0.19, 0.054, 0]]) {
    const ang = PI + 0.3 + da;
    const ex = fanAt[0] + Math.cos(ang) * len;
    const ey = Math.max(0.0, fanAt[1] + Math.sin(ang) * len);
    body.tube([[fanAt[0] + 0.03, fanAt[1] + 0.01, wdt * 0.6], [lerp(fanAt[0], ex, 0.6), lerp(fanAt[1], ey, 0.6), wdt], [ex, ey, wdt * 0.6]], (t, sN, x, y, n) => {
      let c = mix3(A, C, 0.45 + 0.3 * t);
      // thin white margin round the end of each plate
      const q = Math.sqrt(Math.max(0, 1 - n[2] * n[2])) / 0.3;
      c = mix3(c, B, smoothstep(0.8, 0.97, t) * smoothstep(0.62, 0.86, q) * 0.95);
      return mul3(c, 0.9 + 0.12 * Math.cos(sN * 8));
    }, { round: 0.3, gloss: 0.45, dim: dm, edge: 0.15 });
  }
  // abdomen plates: dark with a white band across each one
  const segT = [0.0, 0.085, 0.17, 0.255, 0.34, 0.425, 0.52];
  for (let i = 0; i < 6; i++) {
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const q = along(spine, lerp(segT[i] - 0.012, segT[i + 1] + 0.012, k / 6));
      pts.push([q[0], q[1], q[2] * (1 + 0.06 * (k / 6))]);
    }
    body.tube(pts, (t, sN) => {
      let c = mix3(A, mul3(C, 0.8), 0.55 + 0.3 * smoothstep(0.2, 0.9, sN));
      c = mix3(c, mul3(C, 0.5), smoothstep(0.42, 0.3, t) * smoothstep(0.02, 0.1, t));
      c = mix3(c, B, smoothstep(0.26, 0.2, t) * smoothstep(0.08, 0.14, t) * smoothstep(-0.95, -0.6, sN));
      c = mix3(c, mix3(A, B, 0.3), 0.5 * smoothstep(-0.5, -0.95, sN));
      return c;
    }, { gloss: 0.6, sheen: 0.24, edge: 0.18 });
  }
  // carapace: green with pale markings and little spines
  const cpts = [];
  for (let k = 0; k <= 10; k++) {
    const q = along(spine, lerp(0.5, 1, k / 10));
    cpts.push([q[0], q[1], q[2]]);
  }
  body.tube(cpts, (t, sN, x, y, n) => {
    let c = mix3(A, mul3(A, 0.55), 0.6 * smoothstep(0.4, 0.7, organic(x * 12, y * 12, seed, 3)));
    const w = worley(x * 26, y * 26, seed + 2);
    c = mix3(c, B, smoothstep(0.17, 0.08, w.f1) * 0.8);
    nudge(n, (w.px - x * 26) * 0.25, -(w.py - y * 26) * 0.25);
    // white lines along the lower edge and the groove behind the head
    c = mix3(c, B, 0.8 * smoothstep(0.08, 0.03, Math.abs(sN + 0.62)));
    c = mix3(c, mul3(C, 0.6), 0.6 * gauss(t - 0.52 - 0.12 * sN, 0.03));
    c = mix3(c, mix3(C, [0.1, 0.3, 0.8], 0.4), 0.5 * smoothstep(-0.7, -1.0, sN));
    return c;
  }, { gloss: 0.5, sheen: 0.22, edge: 0.18 });
  // spines along the back, two horns over the eyes
  for (let k = 0; k < 9; k++) {
    const q = along(spine, 0.56 + k * 0.048);
    const bx = q[0];
    const by = q[1] + q[2] * 0.92;
    body.tube([[bx, by - 0.006, 0.011], [bx + 0.014, by + 0.016 + 0.004 * (k % 2), 0.002]], (t) => mix3(A, B, 0.3 + 0.6 * t), { gloss: 0.5, edge: 0 });
  }
  body.tube([[0.4, 0.345, 0.02], [0.445, 0.39, 0.012], [0.485, 0.42, 0.002]], (t) => mix3(A, B, 0.2 + 0.7 * t), { gloss: 0.55 });
  body.tube([[0.43, 0.307, 0.014], [0.458, 0.323, 0.012]], () => mix3(A, C, 0.4), { gloss: 0.3 });
  body.eye(0.466, 0.328, 0.021, { pupil: 'all', iris: [0.15, 0.1, 0.1] });
  // antennules
  whip(body, [[0.45, 0.28], [0.56, 0.3], [0.68, 0.36], [0.76, 0.45]], 0.007, 0.0016, mix3(B, C, 0.3));
  whip(body, [[0.45, 0.28], [0.58, 0.275], [0.7, 0.3], [0.8, 0.35]], 0.007, 0.0016, mix3(B, C, 0.3));
  const legsNear = R.layer();
  legs(legsNear, false);
  const antNear = R.layer();
  antenna(antNear, [[0.45, 0.3], [0.56, 0.35], [0.74, 0.43], [0.88, 0.58], [0.92, 0.77], [0.84, 0.95]], false);
  const sc = R.S / 280;
  R.add(antFar, [0.45, 0.325], { kind: 'sway', amp: 4, rate: 0.35, phase: PH2[0] });
  R.add(legsFar, [0.2, 0.18], { kind: 'bob', amp: 1.5 * sc, rate: 1.6, phase: PH2[0] });
  R.add(body, [0, 0.25], null);
  R.add(legsNear, [0.2, 0.18], { kind: 'bob', amp: 1.5 * sc, rate: 1.6, phase: PH2[1] });
  R.add(antNear, [0.46, 0.305], { kind: 'sway', amp: 4.5, rate: 0.4, phase: PH2[1] });
  return R.done('base');
};

// ---- seahorse ----------------------------------------------------------------------------------------------
BUILDERS.yellowSeahorse = (id, opts) => {
  const R = new Rig(id, opts, 240, [-0.34, -0.56, 0.42, 0.58]);
  const { A, B, C, seed, rnd, S } = R;
  const ctrl = [[0.035, 0.38, 0.058], [-0.03, 0.315, 0.057], [-0.052, 0.22, 0.073], [-0.028, 0.105, 0.097], [-0.016, -0.005, 0.092], [-0.03, -0.115, 0.067], [-0.046, -0.215, 0.047], [-0.032, -0.315, 0.036], [0.028, -0.392, 0.029], [0.104, -0.403, 0.023], [0.15, -0.355, 0.0185], [0.14, -0.296, 0.015], [0.098, -0.281, 0.0125], [0.077, -0.31, 0.01], [0.092, -0.339, 0.0078]];
  const pts = spline(ctrl, 8);
  const RINGS = 46;
  const skin = (t, sN, x, y) => {
    let c = mix3(A, B, 0.3 * smoothstep(0.1, -0.9, sN) + 0.3 * smoothstep(0.45, 0.7, organic(x * 14, y * 14, seed, 3)));
    c = mix3(c, C, 0.55 * smoothstep(0.25, 0.95, sN) * smoothstep(0.62, 0.2, t));
    const sp = worley(x * 58, y * 58, seed + 2);
    c = mix3(c, mul3(B, 0.5), smoothstep(0.16, 0.06, sp.f1) * (sp.id > 0.6 ? 0.7 : 0));
    c = mix3(c, C, smoothstep(0.14, 0.05, sp.f1) * (sp.id < 0.22 ? 0.8 : 0));
    return c;
  };
  // ---- dorsal fin (behind the body)
  const dfin = R.layer();
  const fanPoly = (cx, cy, a0, a1, rad, n = 14) => {
    const poly = [[cx, cy]];
    for (let k = 0; k <= n; k++) {
      const a = lerp(a0, a1, k / n);
      const rr = rad * (0.97 + 0.03 * Math.cos(k * PI)) * (0.72 + 0.28 * Math.pow(Math.sin((k / n) * PI), 0.6));
      poly.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    return poly;
  };
  const drawFan = (P, cx, cy, a0, a1, rad, alpha) => {
    const poly = fanPoly(cx, cy, a0, a1, rad);
    P.poly(poly, (x, y, d, out) => {
      const rr = clamp(Math.hypot(x - cx, y - cy) / rad);
      const ang = Math.atan2(y - cy, x - cx);
      let c = membrane(mix3(A, C, 0.55), ang * 46, rr, smoothstep(0.012, 0.0, d) * smoothstep(0.2, 0.5, rr));
      c = mix3(c, mul3(B, 0.6), 0.45 * gauss(rr - 0.78, 0.07));
      c = tone(c);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = lerp(0.95, alpha, smoothstep(0.1, 0.8, rr));
      return true;
    });
  };
  drawFan(dfin, -0.055, -0.03, PI * 0.74, PI * 1.28, 0.15, 0.7);
  // ---- body
  const body = R.layer();
  // knobs where rings cross the keels: they make the outline bumpy
  for (let k = 3; k < RINGS; k++) {
    const q = along(pts, k / RINGS);
    for (const side of [-1, 1]) {
      const nx = -q.ty * side;
      const ny = q.tx * side;
      const rr = Math.max(0.0045, q[2] * 0.2);
      body.blob(q[0] + nx * q[2] * 0.95, q[1] + ny * q[2] * 0.95, rr, rr, 0, () => mix3(A, side > 0 ? C : B, 0.4), { gloss: 0.3 });
    }
  }
  body.tube(pts, (t, sN, x, y, n) => {
    let c = skin(t, sN, x, y);
    const ring = Math.cos(t * RINGS * TAU);
    // bony rings and three keels
    c = mul3(c, 0.84 + 0.2 * smoothstep(-0.6, 0.6, ring));
    const keel = Math.max(gauss(sN, 0.09), gauss(Math.abs(sN) - 0.58, 0.08));
    c = mul3(c, 1 + 0.16 * keel * smoothstep(0.0, 0.8, ring));
    const q = along(pts, t);
    nudge(n, -q.tx * ring * 0.22, -q.ty * ring * 0.22);
    return c;
  }, { gloss: 0.3, sheen: 0.2, ao: (t) => 1 - 0.25 * gauss(t - 0.03, 0.05) });
  // head: cranium, tube snout, coronet, spines
  const ha = -0.27;
  body.tube([[0.085, 0.372, 0.036], [0.16, 0.352, 0.03], [0.24, 0.33, 0.026], [0.288, 0.317, 0.0275], [0.3, 0.314, 0.024]], (t, sN, x, y) => {
    let c = skin(0.2, -sN * 0.6, x, y);
    c = mul3(c, 1 - 0.3 * smoothstep(0.93, 1.0, t));
    c = mul3(c, 0.92 + 0.1 * Math.cos(t * 30));
    return c;
  }, { gloss: 0.3, sheen: 0.2 });
  body.tube([[0.012, 0.425, 0.026], [0.0, 0.455, 0.022], [-0.006, 0.474, 0.026]], (t, sN, x, y) => skin(0.1, 0, x, y), { gloss: 0.3 });
  for (const [dx, dy] of [[-0.03, 0.012], [-0.017, 0.03], [0.004, 0.035], [0.024, 0.022], [0.03, 0.002]]) {
    body.tube([[-0.006 + dx * 0.5, 0.474 + dy * 0.4, 0.0085], [-0.006 + dx * 1.25, 0.474 + dy * 1.25, 0.002]], () => mix3(A, C, 0.5), { gloss: 0.3, edge: 0 });
  }
  body.blob(0.045, 0.386, 0.084, 0.07, ha, (u, v, x, y) => skin(0.15, -v * 0.8, x, y), { gloss: 0.32, sheen: 0.2 });
  body.tube([[0.06, 0.435, 0.009], [0.068, 0.462, 0.002]], () => mix3(A, C, 0.5), { gloss: 0.3, edge: 0 });
  body.tube([[0.03, 0.335, 0.01], [0.038, 0.305, 0.002]], () => mix3(A, C, 0.4), { gloss: 0.3, edge: 0 });
  body.eye(0.073, 0.393, 0.024, { iris: [0.95, 0.6, 0.15], pr: 0.5, socket: 0.3, seed });
  // ---- little pectoral fin behind the cheek
  const pfin = R.layer();
  drawFan(pfin, -0.002, 0.34, PI * 0.78, PI * 1.3, 0.056, 0.62);
  const sc = S / 240;
  R.add(dfin, [-0.07, -0.035], { kind: 'flap', amp: 9, rate: 3.2, phase: 0 });
  R.add(body, [0, 0], { kind: 'bob', amp: 2 * sc, rate: 0.5, phase: 0 });
  R.add(pfin, [-0.005, 0.345], { kind: 'flap', amp: 12, rate: 3.6, phase: 1.3 });
  return R.done('center');
};

// ---- spiral snail ------------------------------------------------------------------------------------------
BUILDERS.spiralSnail = (id, opts) => {
  const R = new Rig(id, opts, 220, [-0.6, -0.07, 0.66, 0.86]);
  const { A, B, C, seed } = R;
  const flesh = (x, y) => {
    let c = mix3(C, A, 0.35 + 0.3 * organic(x * 12, y * 12, seed, 3));
    const w = worley(x * 50, y * 50, seed + 1);
    c = mix3(c, mul3(B, 0.9), smoothstep(0.2, 0.08, w.f1) * 0.45);
    return c;
  };
  // ---- tentacles
  const tent = R.layer();
  tent.tube(spline([[0.4, 0.1, 0.016], [0.455, 0.165, 0.012], [0.505, 0.225, 0.009], [0.565, 0.26, 0.006]], 6), (t, sN, x, y) => mix3(flesh(x, y), B, 0.25 * t), { gloss: 0.4, dim: 0.3 });
  tent.tube(spline([[0.43, 0.095, 0.017], [0.51, 0.14, 0.013], [0.59, 0.175, 0.01], [0.655, 0.185, 0.0065]], 6), (t, sN, x, y) => mix3(flesh(x, y), B, 0.25 * t), { gloss: 0.4 });
  // ---- foot and head
  const foot = R.layer();
  groundShadow(foot, 0.0, 0.46, 0.02, 0.3);
  foot.tube(spline([[-0.4, 0.004, 0.014], [-0.31, 0.022, 0.04], [-0.12, 0.042, 0.062], [0.12, 0.052, 0.072], [0.3, 0.055, 0.074], [0.42, 0.064, 0.06], [0.475, 0.074, 0.034]], 8), (t, sN, x, y, n) => {
    let c = flesh(x, y);
    // paler frilled sole
    c = mix3(c, [1, 0.96, 0.88], 0.5 * smoothstep(-0.45, -0.85, sN) * (0.7 + 0.3 * Math.cos(x * 120)));
    return c;
  }, { gloss: 0.5, sheen: 0.24, ao: (t, sN) => 0.6 + 0.4 * smoothstep(-1, -0.3, sN) });
  foot.eye(0.44, 0.098, 0.011, { pupil: 'all', iris: [0.1, 0.07, 0.05] });
  // ---- shell: a tall spire leaning back, built from bulging whorls along its axis
  const shell = R.layer();
  const Bc = [0.02, 0.215];
  const Ap = [-0.3, 0.77];
  const AL = Math.hypot(Ap[0] - Bc[0], Ap[1] - Bc[1]);
  const ax = [(Ap[0] - Bc[0]) / AL, (Ap[1] - Bc[1]) / AL];
  const Rb = 0.235;
  const Q = 0.7;
  const whorl = (a) => {
    // index and position inside the whorl for an axial position a (0 base .. 1 apex)
    const k = Math.floor(Math.log(Math.max(1e-4, 1 - a)) / Math.log(Q));
    const a0 = 1 - Math.pow(Q, k);
    const a1 = 1 - Math.pow(Q, k + 1);
    return [k, (a - a0) / (a1 - a0)];
  };
  const radius = (a) => {
    if (a < 0) return Rb * 0.99 * Math.sqrt(Math.max(0, 1 - Math.pow(a / 0.27, 2)));
    if (a >= 1) return 0;
    const [, w] = whorl(a);
    return Rb * Math.pow(1 - a, 0.92) * (0.84 + 0.17 * Math.pow(Math.sin(PI * clamp(w)), 0.55));
  };
  const local = (x, y) => {
    const dx = x - Bc[0];
    const dy = y - Bc[1];
    const d = -dx * ax[1] + dy * ax[0];
    return [(dx * ax[0] + dy * ax[1]) / AL + 0.085 * (d / Rb), d];
  };
  const zShell = (x, y) => {
    const [a, d] = local(x, y);
    if (a < -0.27 || a > 1) return -1;
    const r = radius(a);
    if (Math.abs(d) >= r) return -1;
    return Math.sqrt(r * r - d * d) * 0.9;
  };
  shell.field([-0.5, -0.02, 0.32, 0.8], zShell, (x, y, z, n) => {
    const [a, d] = local(x, y);
    const [k, w] = a >= 0 ? whorl(Math.min(a, 0.999)) : [0, 0.5 + a];
    const lon = Math.asin(clamp(d / Math.max(1e-4, radius(a)), -1, 1));
    let c = mix3(A, C, 0.35 * organic(x * 8, y * 8, seed + 3, 3) + 0.3 * smoothstep(0.75, 1, a));
    // spiral cords: dark lines running round every whorl, broken into dashes
    const cords = a >= 0 ? w * (k === 0 ? 5 : k === 1 ? 4 : 3) : a * 18.5 + 2.5;
    const line = smoothstep(0.2, 0.08, Math.abs(fract(cords) - 0.5));
    const dash = 0.6 + 0.4 * smoothstep(-0.2, 0.3, Math.sin(lon * 9 + Math.floor(cords) * 2.1 + k));
    c = mix3(c, B, line * dash * 0.85);
    // growth striae across the whorls, dark sutures
    c = mul3(c, 0.94 + 0.07 * Math.cos(lon * 40 + 3 * organic(x * 20, y * 20, seed + 4, 2)));
    if (a >= 0) c = mul3(c, 1 - 0.4 * smoothstep(0.1, 0.0, Math.min(w, 1 - w)));
    return c;
  }, { gloss: 0.55, sheen: 0.22, ao: (x, y) => 0.6 + 0.4 * smoothstep(0.05, 0.2, y) });
  // shadow where the shell sits on the body
  foot.darken([-0.3, 0.0, 0.34, 0.16], (x, y) => 0.45 * smoothstep(1, 0.4, Math.hypot((x - 0.03) / 0.26, (y - 0.12) / 0.05)));
  R.add(tent, [0.41, 0.095], { kind: 'sway', amp: 6, rate: 0.45, phase: 0 });
  R.add(foot, [0, 0.03], null);
  R.add(shell, [0.0, 0.1], { kind: 'sway', amp: 2, rate: 0.3, phase: 1.5 });
  return R.done('base');
};

// ---- bristle worm --------------------------------------------------------------------------------------------
BUILDERS.reefWorm = (id, opts) => {
  const R = new Rig(id, opts, 220, [-0.42, -0.08, 0.56, 0.8]);
  const { A, B, C, seed, rnd } = R;
  // rises out of its burrow at the origin, leans left, then loops back to the right
  const ctrl = [[-0.01, 0.022, 0.05], [-0.1, 0.1, 0.052], [-0.15, 0.215, 0.05], [-0.06, 0.315, 0.048], [0.09, 0.335, 0.045], [0.215, 0.37, 0.042], [0.29, 0.47, 0.038], [0.295, 0.585, 0.034], [0.285, 0.62, 0.027]];
  const pts = spline(ctrl, 10);
  const SEGS = 36;
  const section = (P, f0, f1, withHead) => {
    const sub = [];
    const NS = 60;
    for (let k = 0; k <= NS; k++) sub.push(along(pts, lerp(f0, f1, k / NS)));
    // bristle tufts on both flanks (drawn first, so they come out from behind the body)
    for (let sI = 0; sI < SEGS; sI++) {
      const f = (sI + 0.5) / SEGS;
      if (f < f0 + (withHead ? 0.05 : 0) || f > f1 || f < 0.06) continue;
      const q = along(pts, f);
      for (const side of [-1, 1]) {
        const nx = -q.ty * side;
        const ny = q.tx * side;
        const bx = q[0] + nx * q[2] * 0.82;
        const by = q[1] + ny * q[2] * 0.82;
        for (let j = 0; j < 6; j++) {
          const a = (j / 5 - 0.5) * 1.3 + (rnd() - 0.5) * 0.2;
          const len = q[2] * (1.0 + 0.5 * rnd());
          const dx = nx * Math.cos(a) - ny * Math.sin(a);
          const dy = nx * Math.sin(a) + ny * Math.cos(a);
          P.tube([[bx, by, 0.0028], [bx + dx * len, by + dy * len, 0.0007]], () => [1, 1, 1, 0.85], { raw: true, minPx: 0.5 });
        }
        P.blob(bx + nx * 0.006, by + ny * 0.006, 0.014, 0.011, Math.atan2(q.ty, q.tx), () => mix3(A, B, 0.45), { gloss: 0.3 });
      }
    }
    P.tube(sub.map((q) => [q[0], q[1], q[2]]), (tl, sN, x, y, n) => {
      const t = lerp(f0, f1, tl);
      const sg = Math.cos(t * SEGS * TAU);
      let c = mix3(A, B, 0.25 * smoothstep(0.3, 1, Math.abs(sN)));
      c = mix3(c, mul3(C, 1.1), 0.5 * gauss(sN, 0.22));
      c = mix3(c, B, 0.55 * smoothstep(-0.75, -1.0, sg));
      c = mul3(c, 0.88 + 0.14 * smoothstep(-0.8, 0.5, sg));
      const q = along(pts, t);
      nudge(n, -q.tx * sg * 0.25, -q.ty * sg * 0.25);
      // iridescent sheen typical of bristle worms
      c = add3(c, mul3([0.1, 0.25, 0.35], 0.25 * Math.pow(Math.max(0, n[1]), 3)));
      return c;
    }, { gloss: 0.6, sheen: 0.25, ao: (tl) => 0.35 + 0.65 * smoothstep(0.0, 0.12, lerp(f0, f1, tl)), alpha: withHead ? (tl) => smoothstep(0.0, 0.09, tl) : 1 });
    if (withHead) {
      const hq = along(pts, 1);
      for (const [a, len] of [[-0.7, 0.05], [-0.25, 0.06], [0.25, 0.06], [0.7, 0.05]]) {
        const dx = hq.tx * Math.cos(a) - hq.ty * Math.sin(a);
        const dy = hq.tx * Math.sin(a) + hq.ty * Math.cos(a);
        P.tube([[hq[0] + dx * 0.015, hq[1] + dy * 0.015, 0.0065], [hq[0] + dx * len, hq[1] + dy * len, 0.002]], () => mix3(B, A, 0.3), { gloss: 0.3, edge: 0 });
      }
      for (const side of [-1, 1]) P.eye(hq[0] - hq.ty * side * 0.012 - hq.tx * 0.004, hq[1] + hq.tx * side * 0.012 - hq.ty * 0.004, 0.0055, { pupil: 'all', iris: [0.1, 0.05, 0.05] });
    }
  };
  const lower = R.layer();
  groundShadow(lower, -0.01, 0.15, 0.022, 0.5);
  // dark mouth of the burrow behind the worm; the base of the body sinks into its shadow
  lower.region(-0.12, -0.03, 0.1, 0.03, (x, y, out) => {
    const q = Math.hypot((x + 0.01) / 0.092, (y - 0.002) / 0.022);
    if (q >= 1) return false;
    out[0] = 0.012;
    out[1] = 0.02;
    out[2] = 0.035;
    out[3] = 0.85 * smoothstep(1, 0.6, q);
    return true;
  });
  section(lower, 0, 0.5, false);
  lower.darken([-0.12, -0.04, 0.1, 0.07], (x, y) => 0.8 * smoothstep(0.055, -0.01, y));
  const upper = R.layer();
  section(upper, 0.44, 1, true);
  const joint = along(pts, 0.47);
  R.add(lower, [0, 0], null);
  R.add(upper, [joint[0], joint[1]], { kind: 'sway', amp: 5, rate: 0.4, phase: 0 });
  return R.done('base');
};

// ---- nudibranch ----------------------------------------------------------------------------------------------
BUILDERS.nudibranch = (id, opts) => {
  const R = new Rig(id, opts, 220, [-0.6, -0.07, 0.56, 0.48]);
  const { A, B, C, seed } = R;
  const X0 = -0.4;
  const X1 = 0.42;
  const topAt = (x) => {
    const u = clamp((x - X0) / (X1 - X0));
    return 0.02 + 0.185 * Math.pow(Math.sin(PI * Math.pow(u, 0.9)), 0.62) * (0.92 + 0.08 * Math.sin(u * 5));
  };
  const skirt = (x) => 0.022 + 0.009 * Math.sin(x * 58 + 1.5 * Math.sin(x * 23));
  // ---- gill plume (behind the body's back edge)
  const gills = R.layer();
  const gb = [-0.2, 0.165];
  for (let k = 0; k < 8; k++) {
    const a = 0.75 + (k / 7) * 1.75 + (k % 2) * 0.08;
    const len = 0.115 + 0.03 * Math.sin(k * 2.2);
    const dim = k % 2 ? 0.35 : 0;
    const ctrl = [];
    for (let q = 0; q <= 5; q++) {
      const t = q / 5;
      const aa = a + (a - PI / 2) * 0.35 * t * t;
      ctrl.push([gb[0] + Math.cos(aa) * len * t, gb[1] - 0.012 + Math.sin(aa) * len * t, lerp(0.0095, 0.003, t)]);
    }
    const rach = spline(ctrl, 4);
    // side branches make each plume feathery
    for (let q = 3; q < 16; q++) {
      const pq = along(rach, q / 16);
      const bl = 0.03 * Math.sin((q / 16) * PI * 0.9 + 0.3);
      for (const side of [-1, 1]) {
        const nx = -pq.ty * side * 0.8 + pq.tx * 0.6;
        const ny = pq.tx * side * 0.8 + pq.ty * 0.6;
        gills.tube([[pq[0], pq[1], 0.0045], [pq[0] + nx * bl, pq[1] + ny * bl, 0.0015]], () => mix3(C, A, 0.12), { gloss: 0.3, edge: 0, dim });
      }
    }
    gills.tube(rach, (t) => mix3(mix3(C, A, 0.35 * smoothstep(0.5, 0, t)), B, 0.3 * smoothstep(0.8, 1, t)), { gloss: 0.4, edge: 0.1, dim });
  }
  // ---- rhinophores
  const rhino = R.layer();
  const horn = (bx, by, tx, ty, dim) => {
    const ctrl = [[bx, by, 0.013], [lerp(bx, tx, 0.35), lerp(by, ty, 0.35), 0.012], [lerp(bx, tx, 0.62), lerp(by, ty, 0.62), 0.021], [lerp(bx, tx, 0.86), lerp(by, ty, 0.86), 0.018], [tx, ty, 0.007]];
    rhino.tube(spline(ctrl, 6), (t, sN) => {
      let c = mix3(A, B, smoothstep(0.25, 0.42, t));
      c = mul3(c, 0.82 + 0.25 * smoothstep(-0.3, 0.6, Math.cos(t * 62)) * smoothstep(0.35, 0.5, t) + 0.0);
      c = mix3(c, C, smoothstep(0.9, 1, t) * 0.7);
      return c;
    }, { gloss: 0.5, sheen: 0.2, dim });
  };
  horn(0.245, 0.15, 0.262, 0.31, 0.3);
  horn(0.285, 0.14, 0.345, 0.295, 0);
  // ---- body: foot below, mantle above
  const body = R.layer();
  groundShadow(body, -0.02, 0.44, 0.018, 0.3);
  body.tube(spline([[-0.485, 0.008, 0.005], [-0.42, 0.012, 0.015], [-0.2, 0.014, 0.022], [0.2, 0.014, 0.022], [0.36, 0.016, 0.022], [0.415, 0.024, 0.016]], 8), (t, sN, x, y) => mix3(mix3(C, A, 0.5), [1, 1, 1], 0.1 + 0.2 * smoothstep(0.2, -0.8, sN)), { gloss: 0.5, sheen: 0.2, ao: (t, sN) => 0.6 + 0.4 * smoothstep(-1, 0, sN) });
  const zBody = (x, y) => {
    if (x <= X0 || x >= X1) return -1;
    const t = topAt(x);
    const b = skirt(x);
    if (y > t || y < b) return -1;
    const mid = (t + b) / 2;
    const half = (t - b) / 2;
    const sN = (y - mid) / half;
    const u = (x - X0) / (X1 - X0);
    return 0.13 * Math.pow(Math.sin(PI * u), 0.5) * Math.sqrt(Math.max(0, 1 - sN * sN)) + 0.01 * smoothstep(-0.6, -1, sN);
  };
  body.field([X0 - 0.01, 0, X1 + 0.01, 0.24], zBody, (x, y, z, n) => {
    const t = topAt(x);
    const b = skirt(x);
    const sN = (y - (t + b) / 2) / ((t - b) / 2);
    let c = mix3(A, mul3(A, 0.6), 0.5 * smoothstep(0.4, 0.7, organic(x * 9, y * 9, seed, 3)));
    c = saturate(c, 1.15);
    // yellow mantle margin with a white line above it, yellow stripe along the back
    const m = y - b;
    c = mix3(c, C, smoothstep(0.045, 0.036, m) * 0.95);
    c = mix3(c, B, smoothstep(0.032, 0.026, m));
    const st = sN - 0.42 - 0.1 * Math.sin(x * 9);
    c = mix3(c, C, smoothstep(0.2, 0.14, Math.abs(st)) * 0.9);
    c = mix3(c, B, smoothstep(0.13, 0.09, Math.abs(st)));
    // fine white speckles
    const w = worley(x * 60, y * 60, seed + 3);
    c = mix3(c, C, smoothstep(0.12, 0.05, w.f1) * (w.id > 0.6 ? 0.7 : 0));
    return c;
  }, { gloss: 0.7, sheen: 0.28, ao: (x, y) => 0.65 + 0.35 * smoothstep(0.02, 0.07, y) });
  // sockets for gills and rhinophores
  body.darken([gb[0] - 0.06, gb[1] - 0.04, gb[0] + 0.06, gb[1] + 0.03], (x, y) => 0.35 * smoothstep(1, 0.4, Math.hypot((x - gb[0]) / 0.05, (y - gb[1] + 0.012) / 0.02)));
  R.add(gills, [gb[0], gb[1] - 0.01], { kind: 'sway', amp: 5, rate: 0.5, phase: 0 });
  R.add(rhino, [0.265, 0.14], { kind: 'sway', amp: 5, rate: 0.6, phase: 3.5 });
  R.add(body, [0, 0.05], null);
  return R.done('base');
};

// ---- sponges ---------------------------------------------------------------------------------------------------
BUILDERS.barrelSponge = (id, opts) => {
  const R = new Rig(id, opts, 300, [-0.56, -0.06, 0.56, 1.1]);
  const { A, B, C, seed } = R;
  const YT = 0.9;
  const lump = (a) => 1 + 0.06 * (organic(Math.cos(a) * 2.4 + 5, Math.sin(a) * 2.4, seed + 5, 2) - 0.5) * 2;
  // lumpy, slightly lopsided barrel: narrow foot, widest above the middle, meeting the rim exactly
  const hwSide = (y, side) => {
    const v = clamp(y / YT);
    const base = 0.23 + 0.03 * smoothstep(0.08, -0.02, y);
    const prof = base + (0.4 - base) * Math.pow(Math.sin(Math.min(1, v * 1.12) * PI * 0.56), 0.85) - 0.045 * smoothstep(0.7, 1, v);
    const lop = smoothstep(1.0, 0.8, v);
    return prof * (1 + 0.11 * lop * (organic(y * 4.2 + side * 7.7, 1.3 + side, seed, 3) - 0.5) * 2) * lerp(lump(side > 0 ? 0 : PI), 1, lop) + side * 0.012 * lop * Math.sin(y * 5);
  };
  const NL = 512;
  const lutL = new Float32Array(NL + 1);
  const lutR = new Float32Array(NL + 1);
  for (let i = 0; i <= NL; i++) {
    const y = -0.04 + (i / NL) * (YT + 0.08);
    lutL[i] = hwSide(y, -1);
    lutR[i] = hwSide(y, 1);
  }
  const hwAt = (x, y) => {
    const f = clamp((y + 0.04) / (YT + 0.08)) * NL;
    const i = Math.min(NL - 1, Math.floor(f));
    const k = f - i;
    return lerp(lutL[i] + (lutL[i + 1] - lutL[i]) * k, lutR[i] + (lutR[i + 1] - lutR[i]) * k, smoothstep(-0.2, 0.2, x));
  };
  const KE = 0.29; // how flat the top opening looks from this height
  const Ro = hwSide(YT, 1) / lump(0);
  const Ri = Ro * 0.76;
  // ridges wander, split and merge; knobs break them up along their length
  const ridge = (lon, y) => {
    const wob = (organic(lon * 1.4 + 3, y * 2.6, seed + 1, 2) - 0.5) * 7;
    const main = Math.pow(0.5 + 0.5 * Math.cos(lon * 11.5 + wob), 0.55);
    const knob = 0.55 + 0.45 * smoothstep(0.3, 0.7, organic(lon * 5, y * 11, seed + 6, 2));
    return main * knob;
  };
  const rough = (x, y) => organic(x * 30, y * 30, seed + 2, 3);
  const P = R.layer();
  groundShadow(P, 0, 0.32, 0.024, 0.34);
  // barrel wall, up to the front arc of the rim
  const zf = (x, y) => {
    const hw = hwAt(x, y);
    const sN = x / hw;
    if (Math.abs(sN) >= 1) return -1;
    // tucked a little under the rim ring (drawn afterwards) so no pinholes open between the two
    const yTop = YT - Ro * KE * Math.sqrt(Math.max(0, 1 - Math.pow(x / Ro, 2))) * 0.98 + 0.01 * smoothstep(0.99, 0.88, Math.abs(x) / Ro);
    if (y > yTop) return -1;
    const lon = Math.asin(sN);
    let z = hw * Math.cos(lon) * 0.85;
    z += 0.05 * ridge(lon, y) * (0.5 + 0.5 * smoothstep(0.02, 0.3, y));
    return z * seat(x, y, hw, 0.02);
  };
  P.field([-0.52, -0.03, 0.52, YT + 0.08], zf, (x, y, z, n) => {
    const hw = hwAt(x, y);
    const lon = Math.asin(clamp(x / hw, -1, 1));
    const rg = ridge(lon, y);
    let c = mix3(mul3(C, 0.85), A, smoothstep(0.08, 0.6, rg));
    c = mix3(c, B, 0.55 * smoothstep(0.7, 1.0, rg) * (0.5 + 0.5 * rough(x * 0.5, y * 0.5)));
    c = mul3(c, 0.72 + 0.56 * rough(x, y));
    // pores and pits
    const w = worley(x * 52, y * 52, seed + 3);
    c = mul3(c, 1 - 0.45 * smoothstep(0.22, 0.06, w.f1));
    nudge(n, (w.px - x * 52) * -0.12 + (rough(x + 0.004, y) - rough(x - 0.004, y)) * -1.6, (w.py - y * 52) * 0.12 + (rough(x, y + 0.004) - rough(x, y - 0.004)) * -1.6);
    // a little algae and silt in the furrows low down
    c = mix3(c, [0.3, 0.3, 0.16], 0.3 * smoothstep(0.45, 0.0, rg) * smoothstep(0.5, 0.0, y));
    return c;
  }, { gloss: 0.03, sheen: 0.06, relief: 1.35, edge: 0.3, ao: (x, y) => (0.5 + 0.5 * smoothstep(-0.02, 0.14, y)) * (0.55 + 0.45 * ridge(Math.asin(clamp(x / hwAt(x, y), -1, 1)), y)) });
  // thick rim (a ring seen from above) and the dark inside of the barrel
  P.region(-0.5, YT - 0.14, 0.5, YT + 0.15, (x, y, out) => {
    const a = Math.atan2((y - YT) / KE, x);
    const rr = Math.hypot(x, (y - YT) / KE);
    const ro = Ro * lump(a) * (1 + 0.035 * Math.max(0, Math.sin(a)));
    const ri = Ri * lump(a + 2.1);
    if (rr > ro) return false;
    let c;
    if (rr < ri) {
      // inside: ridged far wall catching light near the top, darkness below
      const depth = clamp((YT + ri * KE - y) / (2 * ri * KE));
      const lon = Math.asin(clamp(x / ri, -1, 1));
      c = mix3(mul3(mix3(C, A, 0.4), 0.45 + 0.65 * ridge(lon + 3, 0.5 + depth)), [0.015, 0.008, 0.008], smoothstep(0.02, 0.62, depth));
      c = mul3(c, 0.75 + 0.5 * rough(x, y));
      c = mul3(c, 0.55 + 0.45 * smoothstep(0.0, 0.12, (ri - rr) / ri));
    } else {
      // rounded top of the wall, bumpy like the ridges below it
      const t = (rr - ri) / (ro - ri);
      const bumps = ridge(Math.atan2(x, -(y - YT) / KE) * 0.5, 0.9);
      const nrm = norm3([Math.cos(a) * (t - 0.5) * 0.9, 0.85, 0.45 + Math.sin(a) * (0.5 - t) * 0.6]);
      let alb = mix3(mix3(C, A, 0.6), B, 0.35 + 0.4 * bumps);
      alb = mul3(alb, 0.72 + 0.56 * rough(x, y));
      const w = worley(x * 52, y * 52, seed + 3);
      alb = mul3(alb, 1 - 0.4 * smoothstep(0.22, 0.06, w.f1));
      c = lit(alb, nrm, 0.03, 0.06, 0.55 + 0.45 * Math.sin(clamp(t) * PI));
    }
    c = tone(c);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = 1;
    return true;
  });
  R.add(P, [0, 0], { kind: 'pulse', amp: 0.006, rate: 0.14, phase: 0 });
  return R.done('base');
};

BUILDERS.bitterSponge = (id, opts) => {
  const R = new Rig(id, opts, 240, [-0.6, -0.07, 0.6, 1.02]);
  const { A, B, C, seed, rnd } = R;
  const tubeSponge = (P, x0, x1, hgt, r0, dim, k) => {
    const ctrl = [[x0, r0 * 0.7, r0 * 0.95], [lerp(x0, x1, 0.3) + 0.01 * Math.sin(k), hgt * 0.35, r0 * 1.06], [lerp(x0, x1, 0.7), hgt * 0.72, r0 * 1.1], [x1, hgt - r0 * 0.55, r0 * 1.02]];
    const pts = spline(ctrl, 8);
    P.tube(pts, (t, sN, x, y, n) => {
      const lon = Math.asin(clamp(sN, -1, 1));
      let c = mix3(A, B, 0.2 + 0.5 * smoothstep(0.35, 1, t) * (0.5 + 0.5 * organic(x * 10, y * 10, seed + k, 2)));
      c = mul3(c, 0.86 + 0.28 * organic(x * 30, y * 30, seed + 9, 3));
      // pores
      const w = worley(t * hgt * 38 + k * 7, lon * 3.4 * (r0 / 0.08), seed + 2);
      const pore = smoothstep(0.24, 0.1, w.f1) * (w.id > 0.35 ? 1 : 0);
      c = mix3(c, mul3(C, 0.55), pore * 0.9);
      nudge(n, (w.px - (t * hgt * 38 + k * 7)) * -0.3 * pore, 0);
      return c;
    }, { gloss: 0.12, sheen: 0.14, dim, ao: (t) => 0.5 + 0.5 * smoothstep(0.0, 0.3, t) });
    // osculum: the opening on top, seen a little from above
    const top = along(pts, 1);
    const ox = top[0] + top.tx * r0 * 0.3;
    const oy = top[1] + top.ty * r0 * 0.3 + r0 * 0.12;
    P.region(ox - r0, oy - r0 * 0.5, ox + r0, oy + r0 * 0.5, (x, y, out) => {
      const q = Math.hypot((x - ox) / (r0 * 0.6), (y - oy) / (r0 * 0.27));
      if (q >= 1.25) return false;
      let c = q < 1 ? mix3(mul3(C, 0.22), mul3(C, 0.8), smoothstep(0.2, 1.0, (y - oy) / (r0 * 0.27) * 0.5 + 0.5) * 0.7) : mix3(B, [1, 0.8, 0.6], 0.2);
      if (dim) c = mix3(mul3(c, 1 - dim * 0.55), [0.05, 0.14, 0.22], dim * 0.3);
      c = tone(c);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = q < 1 ? 1 : smoothstep(1.25, 1.05, q) * 0.9;
      return true;
    });
  };
  const back = R.layer();
  tubeSponge(back, -0.2, -0.26, 0.66, 0.085, 0.38, 1);
  tubeSponge(back, 0.07, 0.1, 0.92, 0.098, 0.3, 2);
  tubeSponge(back, 0.3, 0.37, 0.6, 0.082, 0.38, 3);
  // encrusting base
  const base = R.layer();
  groundShadow(base, 0, 0.5, 0.022, 0.32);
  const lumps = [[-0.37, 0.02, 0.13, 0.07], [-0.15, 0.025, 0.17, 0.085], [0.1, 0.025, 0.18, 0.09], [0.33, 0.02, 0.15, 0.075], [0.46, 0.008, 0.07, 0.045], [-0.48, 0.008, 0.06, 0.04]];
  base.field([-0.58, -0.03, 0.58, 0.2], (x, y) => {
    let z = -1;
    for (const l of lumps) {
      const q = Math.pow((x - l[0]) / l[2], 2) + Math.pow((y - l[1]) / l[3], 2);
      z = smax(z, q < 1 ? l[3] * Math.sqrt(1 - q) : -(Math.sqrt(q) - 1) * l[3], 0.03);
    }
    return z * seat(x, y, 0.56, 0.02);
  }, (x, y, z, n) => {
    let c = mix3(A, mul3(C, 1.2), 0.3 + 0.3 * organic(x * 9, y * 9, seed + 4, 3));
    c = mul3(c, 0.86 + 0.28 * organic(x * 30, y * 30, seed + 9, 3));
    const w = worley(x * 34, y * 34, seed + 6);
    c = mix3(c, mul3(C, 0.55), smoothstep(0.2, 0.08, w.f1) * (w.id > 0.4 ? 0.85 : 0));
    return c;
  }, { gloss: 0.12, sheen: 0.14, ao: (x, y) => 0.55 + 0.45 * smoothstep(-0.02, 0.08, y) });
  const front = R.layer();
  tubeSponge(front, -0.34, -0.4, 0.4, 0.074, 0, 4);
  tubeSponge(front, 0.2, 0.24, 0.47, 0.082, 0, 5);
  tubeSponge(front, -0.08, -0.1, 0.58, 0.09, 0, 6);
  tubeSponge(front, 0.41, 0.47, 0.27, 0.06, 0, 7);
  R.add(back, [0, 0.03], { kind: 'sway', amp: 1.2, rate: 0.25, phase: PH2[0] });
  R.add(front, [0, 0.03], { kind: 'sway', amp: 1.2, rate: 0.25, phase: PH2[1] });
  R.add(base, [0, 0], null);
  return R.done('base');
};

// ---- turf algae ------------------------------------------------------------------------------------------------
BUILDERS.turfAlgae = (id, opts) => {
  const R = new Rig(id, opts, 220, [-0.62, -0.06, 0.62, 0.46], 1.18);
  const { A, B, C, seed, rnd } = R;
  // dense dark cushion under the filaments
  const mound = R.layer();
  groundShadow(mound, 0, 0.48, 0.02, 0.3);
  const topAt = (x) => 0.13 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / 0.47, 2.4)), 0.6) * (0.7 + 0.6 * organic(x * 6, 2, seed, 2));
  mound.field([-0.5, -0.03, 0.5, 0.2], (x, y) => {
    if (Math.abs(x) >= 0.47) return -1;
    const top = topAt(x);
    if (y > top) return -1;
    const sN = Math.max(0, y) / top;
    return (0.1 * Math.sqrt(Math.max(0, 1 - sN * sN)) + 0.01) * seat(x, y, 0.47, 0.018);
  }, (x, y) => mul3(mix3(C, A, 0.25 + 0.3 * organic(x * 20, y * 20, seed + 1, 3)), 0.8), { gloss: 0.1, sheen: 0.1, ao: (x, y) => 0.5 + 0.5 * smoothstep(0, 0.1, y) });
  const piv = [-0.27, 0, 0.27];
  const clumps = piv.map(() => R.layer());
  const fil = [];
  for (let k = 0; k < 760; k++) {
    const x = clamp((rnd() + rnd() + rnd() - 1.5) * 0.56, -0.455, 0.455);
    const env = 1 - Math.pow(Math.abs(x) / 0.48, 2);
    fil.push({ x, y: topAt(x) * (0.15 + 0.75 * rnd()), env, depth: rnd(), h1: rnd(), h2: rnd(), h3: rnd(), h4: rnd() });
  }
  fil.sort((p, q) => p.depth - q.depth);
  for (const f of fil) {
    // filaments lean out from the middle of the tuft and from their own clump
    let ci = 0;
    let bd = 9;
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(f.x - piv[i]) + 0.12 * hash2(Math.round(f.x * 1000), i, seed);
      if (d < bd) {
        bd = d;
        ci = i;
      }
    }
    const lean = (f.x / 0.47) * 0.8 + (f.x - piv[ci]) * 1.2 + (f.h1 - 0.5) * 0.9;
    const L = (0.07 + 0.15 * f.h2 * f.h2 + 0.03 * f.h4) * (0.55 + 0.45 * f.env);
    const bend = (f.h3 - 0.5) * 1.5;
    const ctrl = [];
    for (let q = 0; q <= 4; q++) {
      const t = q / 4;
      const a = lean + bend * t * t;
      ctrl.push([f.x + Math.sin(a) * L * t, f.y - 0.008 + Math.cos(a) * L * t, lerp(0.0044, 0.0012, t)]);
    }
    const base = mix3(C, A, 0.3 + 0.7 * f.h4);
    const tip = mix3(A, B, 0.3 + 0.7 * f.h1);
    clumps[ci].tube(spline(ctrl, 3), (t) => mix3(base, tip, smoothstep(0.1, 0.9, t)), { gloss: 0.25, sheen: 0.2, edge: 0, dim: (1 - f.depth) * 0.6, ao: (t) => 0.45 + 0.55 * smoothstep(0, 0.6, t), minPx: 0.55 });
  }
  R.add(mound, [0, 0], null);
  clumps.forEach((P, i) => R.add(P, [piv[i], 0.01], { kind: 'sway', amp: 5, rate: 0.5, phase: PH3[i] }));
  return R.done('base');
};

// ---- coral polyps ------------------------------------------------------------------------------------------------
BUILDERS.coralPolyps = (id, opts) => {
  const R = new Rig(id, opts, 240, [-0.6, -0.07, 0.6, 0.74]);
  const { A, B, C, seed, rnd } = R;
  const lumps = [[-0.2, 0.2, 0.29, 0.3], [0.06, 0.29, 0.31, 0.33], [0.27, 0.19, 0.24, 0.27], [-0.37, 0.09, 0.14, 0.16], [0.4, 0.08, 0.11, 0.13]];
  const zf = (x, y) => {
    let z = -1;
    for (const l of lumps) {
      const q = Math.pow((x - l[0]) / l[2], 2) + Math.pow((y - l[1]) / l[3], 2);
      z = smax(z, q < 1 ? l[2] * 0.85 * Math.sqrt(1 - q) : -(Math.sqrt(q) - 1) * l[2], 0.05);
    }
    return z * seat(x, y, 0.5, 0.022);
  };
  const normalAt = (x, y) => {
    const e = 0.004;
    const zx = (Math.max(0, zf(x + e, y)) - Math.max(0, zf(x - e, y))) / (2 * e);
    const zy = (Math.max(0, zf(x, y + e)) - Math.max(0, zf(x, y - e))) / (2 * e);
    return norm3([-zx, -zy, 1]);
  };
  // polyp positions: jittered hexagonal grid over the dome
  const polyps = [];
  const SP = 0.082;
  for (let j = -1; j < 10; j++)
    for (let i = -8; i < 9; i++) {
      const x = (i + (j % 2 ? 0.5 : 0)) * SP + (rnd() - 0.5) * 0.024;
      const y = 0.03 + j * SP * 0.82 + (rnd() - 0.5) * 0.024;
      if (!(zf(x, y) > 0.012)) continue;
      polyps.push({ x, y, n: normalAt(x, y), r: 0.03 + 0.005 * rnd(), ph: rnd() * TAU, set: (i + j * 3 + 100) % 2 });
    }
  const dome = R.layer();
  groundShadow(dome, 0, 0.47, 0.022, 0.32);
  dome.field([-0.56, -0.03, 0.56, 0.66], zf, (x, y, z, n) => {
    let c = mix3(A, C, 0.3 + 0.3 * organic(x * 8, y * 8, seed, 3));
    const w = worley(x * 40, y * 40, seed + 1);
    c = mul3(c, 0.9 + 0.14 * smoothstep(0.1, 0.4, w.f1));
    // darker cup under every polyp
    for (const p of polyps) {
      const dx = x - p.x;
      const dy = y - p.y;
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) continue;
      const along2 = (dx * p.n[0] + dy * p.n[1]) / Math.max(0.3, p.n[2]);
      const d = Math.hypot(dx - p.n[0] * (dx * p.n[0] + dy * p.n[1]) + p.n[0] * along2, dy - p.n[1] * (dx * p.n[0] + dy * p.n[1]) + p.n[1] * along2) / p.r;
      c = mix3(c, mul3(C, 0.62), smoothstep(1.05, 0.55, d) * 0.75);
    }
    return c;
  }, { gloss: 0.2, sheen: 0.16, ao: (x, y) => 0.55 + 0.45 * smoothstep(-0.02, 0.1, y) });
  const sets = [R.layer(), R.layer()];
  for (const p of polyps) {
    const P = sets[p.set];
    const nz = Math.max(0.3, p.n[2]);
    const nl = Math.hypot(p.n[0], p.n[1]) || 1;
    const ux = p.n[0] / nl;
    const uy = p.n[1] / nl;
    const lift = 0.02;
    const NT = 12;
    const order = [];
    for (let k = 0; k < NT; k++) order.push(k);
    // tentacles pointing away from the viewer first
    const dirOf = (k) => {
      const a = p.ph + (k / NT) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // ring in the tangent plane, foreshortened along the projected normal
      return [ca * -uy + sa * ux * nz, ca * ux + sa * uy * nz, sa];
    };
    order.sort((k1, k2) => dirOf(k2)[2] - dirOf(k1)[2]);
    for (const k of order) {
      const d = dirOf(k);
      const bx = p.x + d[0] * p.r * 0.3;
      const by = p.y + d[1] * p.r * 0.3;
      const tx = p.x + d[0] * p.r + p.n[0] * lift;
      const ty = p.y + d[1] * p.r + p.n[1] * lift;
      P.tube([[bx, by, 0.0072], [lerp(bx, tx, 0.6) + p.n[0] * lift * 0.5, lerp(by, ty, 0.6) + p.n[1] * lift * 0.5, 0.006], [tx, ty, 0.0064]], (t) => mix3(mix3(A, B, 0.35), mix3(B, [1, 1, 1], 0.35), smoothstep(0.45, 1, t)), {
        gloss: 0.3, sheen: 0.2, edge: 0.1, ao: (t) => 0.55 + 0.45 * t,
      });
    }
    // mouth
    P.blob(p.x + p.n[0] * 0.004, p.y + p.n[1] * 0.004, p.r * 0.3, p.r * 0.3 * nz, Math.atan2(uy, ux) + PI / 2, () => mix3(B, [1, 0.95, 0.75], 0.5), { gloss: 0.4, edge: 0.3, rz: 0.004 });
  }
  R.add(dome, [0, 0], null);
  R.add(sets[0], [0, 0.2], { kind: 'pulse', amp: 0.016, rate: 0.5, phase: PH2[0] });
  R.add(sets[1], [0, 0.2], { kind: 'pulse', amp: 0.016, rate: 0.5, phase: PH2[1] });
  return R.done('base');
};

// ---------------------------------------------------------------------------- module contract
/** The species drawn by this module (everything in species.json that is not a fish body plan). */
export const IDS = [
  'cuttlefish', 'bluespottedRay', 'electricRay', 'guitarfish', 'yellowSeahorse', 'seaWasp', 'plankton', 'cleanerShrimp',
  'reefCrab', 'reefShrimp', 'paintedLobster', 'brittleStar', 'spiralSnail', 'reefWorm', 'diademaUrchin', 'giantClam', 'seaAnemone',
  'blueStar', 'crownStar', 'seaCucumber', 'nudibranch', 'barrelSponge', 'bitterSponge', 'turfAlgae', 'seagrass', 'coralPolyps',
];

/**
 * Build the rigged sprite for one species.
 * @param id   one of IDS
 * @param opts { px?: authored body length in pixels (default per species), ss?: supersampling (default 3) }
 * @returns SpriteDef { lenPx, anchor, parts: [{ img, pivot, at, anim }] } (see lib/sprite.mjs)
 */
export function build(id, opts = {}) {
  const fn = BUILDERS[id];
  if (!fn) throw new Error(`Unknown critter ${id}`);
  return fn(id, opts);
}
