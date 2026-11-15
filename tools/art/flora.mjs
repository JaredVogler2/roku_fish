/**
 * Reef flora and seabed decoration kit.
 *
 * Every piece is modelled as real 3D geometry (swept tubes, thick sheets, implicit solids) and
 * rendered by a tiny deferred software renderer: geometry is rasterised into a supersampled
 * G-buffer (depth, normal, albedo, material), screen-space ambient occlusion and a soft key-light
 * shadow are derived from the depth buffer, and every sample is shaded with the shared light rig
 * (lib/light.mjs) so the scenery sits in the same water as the fish.
 *
 * Most pieces are TINTABLE: they are rendered with a neutral albedo, so the bitmap stores shading
 * only (lit tops ~0.9, core shadows ~0.5, crevices never below ~0.3, slightly cool in the shadows)
 * and the device multiplies it by a biome colour. Shells, Christmas-tree worms and the urchin are
 * baked in full colour.
 *
 * Conventions: 144 px per world unit, origin = attachment point (bottom-centre; top-centre for the
 * hang_* pieces), y up in model space, +z toward the viewer. Geometry lists are in pixels.
 */
import {
  Img, over, blur, crop, bounds, hex, mix3, mul3, add3, mulc, norm3, clamp, lerp, smoothstep, fract, hash2, vnoise, fbm, worley,
  saturate, tone, lum, rng, hashStr, TAU,
} from './lib/core.mjs';
import { lit, SKY, GROUND, KEY, RIM } from './lib/light.mjs';

const PI = Math.PI;
const UNIT = 144; // authored pixels per world unit
const EMPTY = -1e9;

// ---------------------------------------------------------------------------- vectors & noise
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vscale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** A unit vector perpendicular to d, picked by the generator R. */
function randPerp(d, R) {
  for (;;) {
    const a = [R.range(-1, 1), R.range(-1, 1), R.range(-1, 1)];
    const p = vsub(a, vscale(d, vdot(a, d)));
    const l = vlen(p);
    if (l > 0.2) return vscale(p, 1 / l);
  }
}
/** Rodrigues rotation of v about the unit axis k. */
function rotAbout(v, k, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const kv = vcross(k, v);
  const kd = vdot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

function hash3(x, y, z, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440662683) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function vnoise3(x, y, z, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade5(x - xi);
  const v = fade5(y - yi);
  const w = fade5(z - zi);
  const a = hash3(xi, yi, zi, seed);
  const b = hash3(xi + 1, yi, zi, seed);
  const c = hash3(xi, yi + 1, zi, seed);
  const d = hash3(xi + 1, yi + 1, zi, seed);
  const e = hash3(xi, yi, zi + 1, seed);
  const f = hash3(xi + 1, yi, zi + 1, seed);
  const g = hash3(xi, yi + 1, zi + 1, seed);
  const h = hash3(xi + 1, yi + 1, zi + 1, seed);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  const ef = e + (f - e) * u;
  const gh = g + (h - g) * u;
  const lo = ab + (cd - ab) * v;
  const hi = ef + (gh - ef) * v;
  return lo + (hi - lo) * w;
}
function fbm3(x, y, z, oct = 3, seed = 0) {
  let s = 0;
  let a = 0.5;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += vnoise3(x, y, z, seed + i * 19) * a;
    n += a;
    a *= 0.5;
    x *= 2;
    y *= 2;
    z *= 2;
  }
  return s / n;
}
/** 3D cellular noise: [f1, f2, cell id]. */
const W3 = [0, 0, 0];
function worley3(x, y, z, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i;
        const cy = yi + j;
        const cz = zi + k;
        const dx = cx + hash3(cx, cy, cz, seed) - x;
        const dy = cy + hash3(cx, cy, cz, seed + 31) - y;
        const dz = cz + hash3(cx, cy, cz, seed + 57) - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = hash3(cx, cy, cz, seed + 7);
        } else if (d < f2) f2 = d;
      }
  W3[0] = Math.sqrt(f1);
  W3[1] = Math.sqrt(f2);
  W3[2] = id;
  return W3;
}
/** Polynomial smooth minimum / maximum for blending implicit solids. */
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);
/** Interleaved gradient noise: a well distributed per-pixel random number. */
const ign = (x, y) => fract(52.9829189 * fract(0.06711056 * x + 0.00583715 * y));

// ---------------------------------------------------------------------------- materials
/** Neutral albedo of tintable pieces: slightly warm so the blue ambient comes out near grey. */
const N0 = [0.95, 0.875, 0.83];
/** Material record: albedo rgb, baked occlusion o, gloss, sheen. */
const mat = (r, g, b, o = 1, gl = 0, sh = 0.1) => ({ r, g, b, o, gl, sh });
/** Neutral material of brightness v (1 = the standard "white" of the kit). */
const grey = (v, o = 1, gl = 0, sh = 0.1) => ({ r: N0[0] * v, g: N0[1] * v, b: N0[2] * v, o, gl, sh });
const setGrey = (m, v, o = 1) => {
  m.r = N0[0] * v;
  m.g = N0[1] * v;
  m.b = N0[2] * v;
  m.o = o;
  return m;
};
const setRGB = (m, c, o = 1) => {
  m.r = c[0];
  m.g = c[1];
  m.b = c[2];
  m.o = o;
  return m;
};

/** Orthographic camera looking along -z, pitched down by `pitch` radians (0 = straight side view). */
function camera(ox, oy, pitch = 0) {
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  return {
    ox, oy, c, s, pitch,
    /** world point (y up) -> canvas [x, y down, depth] */
    p: (x, y, z) => [ox + x, oy - (y * c - z * s), y * s + z * c],
    /** world direction -> view direction (x, y up, z) */
    d: (v) => [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c],
  };
}

// ---------------------------------------------------------------------------- G-buffer renderer
class GBuf {
  constructor(w, h, ss) {
    this.w = w;
    this.h = h;
    this.ss = ss;
    const W = (this.W = w * ss);
    const H = (this.H = h * ss);
    const n = W * H;
    this.z = new Float32Array(n).fill(EMPTY);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.cr = new Float32Array(n);
    this.cg = new Float32Array(n);
    this.cb = new Float32Array(n);
    this.gl = new Float32Array(n);
    this.sh = new Float32Array(n);
    this.oc = new Float32Array(n);
    this.th = new Float32Array(n);
    this.al = new Float32Array(n);
    this.tr = new Float32Array(n);
    /** Canvas rows at or below clipY / above clipTop are never written (the cut of a buried foot). */
    this.clipY = 1e9;
    this.clipTop = -1e9;
    /** Optional per-column cut rows (supersampled px) that make that cut gently uneven. */
    this.cut = null;
    this.cutTop = null;
  }

  /**
   * Buried foot: nothing is drawn below a slightly wavy line `depth` px under the ground row oy,
   * so the hidden cut is never a ruler-straight edge.
   */
  foot(oy, depth = 10.5, amp = 1.5, seed = 0) {
    this.clipY = oy + depth + amp + 1;
    this.cut = new Float32Array(this.W);
    for (let x = 0; x < this.W; x++) this.cut[x] = (oy + depth + amp * (fbm((x / this.ss) * 0.075 + seed * 0.37, 1.7, 2, seed) * 2 - 1)) * this.ss;
  }

  /** The same for growths hanging from a ceiling: nothing above a wavy line over the origin row. */
  ceiling(oy, depth = 10.5, amp = 1.5, seed = 0) {
    this.clipTop = oy - depth - amp - 1;
    this.cutTop = new Float32Array(this.W);
    for (let x = 0; x < this.W; x++) this.cutTop[x] = (oy - depth + amp * (fbm((x / this.ss) * 0.075 + seed * 0.37, 5.1, 2, seed) * 2 - 1)) * this.ss;
  }

  /**
   * Splat one sphere (canvas px, y down, z toward the viewer). When a tangent (view space, y up)
   * is given the sphere is part of a swept tube: the tangent component of the normal is removed
   * so the tube shades as a smooth cylinder. cap: 0 interior, +1 keeps the rounded end on the
   * +tangent side, -1 on the -tangent side, 2 plain sphere.
   */
  splat(cx, cy, cz, r, m, tx = 0, ty = 0, tz = 0, cap = 2) {
    const ss = this.ss;
    const W = this.W;
    const X = cx * ss;
    const Y = cy * ss;
    const Z = cz * ss;
    const R = r * ss;
    if (R <= 0.05) return;
    const x0 = Math.max(0, Math.floor(X - R));
    const x1 = Math.min(W - 1, Math.ceil(X + R));
    const y0 = Math.max(Math.max(0, Math.ceil(this.clipTop * ss)), Math.floor(Y - R));
    const y1 = Math.min(Math.min(this.H - 1, Math.ceil(Y + R)), Math.floor(this.clipY * ss) - 1);
    const R2 = R * R;
    const iR = 1 / R;
    const zb = this.z;
    const cut = this.cut;
    const cutTop = this.cutTop;
    const th = 2 * R;
    const al = m.a ?? 1;
    const tr = m.tr ?? 0;
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - Y;
      const row = py * W;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - X;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R2) continue;
        const dz = Math.sqrt(R2 - d2);
        const zz = Z + dz;
        const i = row + px;
        if (zz <= zb[i]) continue;
        if ((cut && py + 0.5 > cut[px]) || (cutTop && py + 0.5 < cutTop[px])) continue;
        let nx = dx * iR;
        let ny = -dy * iR;
        let nz = dz * iR;
        if (cap !== 2) {
          const k = nx * tx + ny * ty + nz * tz;
          if (cap === 0 || (cap > 0 ? k < 0 : k > 0)) {
            nx -= k * tx;
            ny -= k * ty;
            nz -= k * tz;
            const l = 1 / (Math.hypot(nx, ny, nz) || 1);
            nx *= l;
            ny *= l;
            nz *= l;
          }
        }
        zb[i] = zz;
        this.nx[i] = nx;
        this.ny[i] = ny;
        this.nz[i] = nz;
        this.cr[i] = m.r;
        this.cg[i] = m.g;
        this.cb[i] = m.b;
        this.gl[i] = m.gl;
        this.sh[i] = m.sh;
        this.oc[i] = m.o;
        this.th[i] = th;
        this.al[i] = al;
        this.tr[i] = tr;
      }
    }
  }

  /**
   * Splat one sphere of a thick sheet: the surface takes the sheet normal (view space, facing
   * the viewer) so the sheet shades smoothly; with `edge` > 0 the sphere also rounds over toward
   * the outward edge direction (ex, ey, ez).
   */
  sheet(cx, cy, cz, r, m, snx, sny, snz, edge = 0, ex = 0, ey = 0, ez = 0) {
    const ss = this.ss;
    const W = this.W;
    const X = cx * ss;
    const Y = cy * ss;
    const Z = cz * ss;
    const R = r * ss;
    const x0 = Math.max(0, Math.floor(X - R));
    const x1 = Math.min(W - 1, Math.ceil(X + R));
    const y0 = Math.max(Math.max(0, Math.ceil(this.clipTop * ss)), Math.floor(Y - R));
    const y1 = Math.min(Math.min(this.H - 1, Math.ceil(Y + R)), Math.floor(this.clipY * ss) - 1);
    const R2 = R * R;
    const iR = 1 / R;
    const zb = this.z;
    const cut = this.cut;
    const cutTop = this.cutTop;
    const th = 2 * R;
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - Y;
      const row = py * W;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - X;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R2) continue;
        const dz = Math.sqrt(R2 - d2);
        const zz = Z + dz;
        const i = row + px;
        if (zz <= zb[i]) continue;
        if ((cut && py + 0.5 > cut[px]) || (cutTop && py + 0.5 < cutTop[px])) continue;
        let nx = snx;
        let ny = sny;
        let nz = snz;
        if (edge > 0) {
          const k = Math.max(0, (dx * ex - dy * ey + dz * ez) * iR) * edge;
          const f = Math.max(0.05, (dx * snx - dy * sny + dz * snz) * iR);
          nx = snx * f + ex * k;
          ny = sny * f + ey * k;
          nz = snz * f + ez * k;
          const l = 1 / (Math.hypot(nx, ny, nz) || 1);
          nx *= l;
          ny *= l;
          nz *= l;
        }
        zb[i] = zz;
        this.nx[i] = nx;
        this.ny[i] = ny;
        this.nz[i] = nz;
        this.cr[i] = m.r;
        this.cg[i] = m.g;
        this.cb[i] = m.b;
        this.gl[i] = m.gl;
        this.sh[i] = m.sh;
        this.oc[i] = m.o;
        this.th[i] = th;
        this.al[i] = 1;
        this.tr[i] = m.tr ?? 0;
      }
    }
  }

  /**
   * Height-field relief facing the viewer. zf(x, y) -> height in px (or < -1e8 outside), x/y
   * relative to the camera origin (y up). shadeFn(x, y, z, n, m) fills the material.
   */
  relief(cam, box, zf, shadeFn, o = {}) {
    const ss = this.ss;
    const W = this.W;
    const e = o.e ?? 0.35;
    const str = o.strength ?? 1;
    const X0 = Math.max(0, Math.floor((cam.ox + box[0]) * ss));
    const X1 = Math.min(W - 1, Math.ceil((cam.ox + box[2]) * ss));
    const Y0 = Math.max(Math.max(0, Math.ceil(this.clipTop * ss)), Math.floor((cam.oy - box[3]) * ss));
    const Y1 = Math.min(Math.min(this.H - 1, Math.ceil((cam.oy - box[1]) * ss)), Math.floor(this.clipY * ss) - 1);
    const m = mat(0, 0, 0);
    const n = [0, 0, 1];
    for (let py = Y0; py <= Y1; py++) {
      const y = cam.oy - (py + 0.5) / ss;
      for (let px = X0; px <= X1; px++) {
        const x = (px + 0.5) / ss - cam.ox;
        if (this.cut && py + 0.5 > this.cut[px]) continue;
        const z = zf(x, y);
        if (z < -1e8) continue;
        const i = py * W + px;
        if (z * ss <= this.z[i]) continue;
        let zl = zf(x - e, y);
        let zr = zf(x + e, y);
        let zd = zf(x, y - e);
        let zu = zf(x, y + e);
        // one-sided differences at the silhouette
        const gx = zl < -1e8 ? (zr < -1e8 ? 0 : (zr - z) / e) : zr < -1e8 ? (z - zl) / e : (zr - zl) / (2 * e);
        const gy = zd < -1e8 ? (zu < -1e8 ? 0 : (zu - z) / e) : zu < -1e8 ? (z - zd) / e : (zu - zd) / (2 * e);
        const l = 1 / Math.hypot(gx * str, gy * str, 1);
        n[0] = -gx * str * l;
        n[1] = -gy * str * l;
        n[2] = l;
        m.gl = 0;
        m.sh = 0.1;
        m.o = 1;
        m.a = 1;
        m.tr = 0;
        shadeFn(x, y, z, n, m);
        this.z[i] = z * ss;
        this.nx[i] = n[0];
        this.ny[i] = n[1];
        this.nz[i] = n[2];
        this.cr[i] = m.r;
        this.cg[i] = m.g;
        this.cb[i] = m.b;
        this.gl[i] = m.gl;
        this.sh[i] = m.sh;
        this.oc[i] = m.o;
        this.th[i] = 1e6;
        this.al[i] = m.a;
        this.tr[i] = m.tr;
      }
    }
  }

  /** World-space sphere through a camera. */
  ball(cam, x, y, z, r, m) {
    this.splat(cam.ox + x, cam.oy - (y * cam.c - z * cam.s), y * cam.s + z * cam.c, r, m);
  }

  /**
   * Swept tube through world points [x, y, z, r] (y up). `m` is a material or a function
   * (t 0..1 along the tube, arc length px) -> material.
   */
  tube(cam, pts, m, capStart = true, capEnd = true) {
    const n = pts.length;
    if (n < 2) {
      if (n === 1) this.ball(cam, pts[0][0], pts[0][1], pts[0][2], pts[0][3], typeof m === 'function' ? m(0, 0) : m);
      return;
    }
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    const vz = new Float64Array(n);
    const L = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      vx[i] = cam.ox + p[0];
      vy[i] = cam.oy - (p[1] * cam.c - p[2] * cam.s);
      vz[i] = p[1] * cam.s + p[2] * cam.c;
      if (i) L[i] = L[i - 1] + Math.hypot(vx[i] - vx[i - 1], vy[i] - vy[i - 1], vz[i] - vz[i - 1]);
    }
    const total = L[n - 1];
    if (total <= 1e-6) return;
    // per-vertex tangents (view space, y up)
    const T = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      T.push(norm3([vx[b] - vx[a], -(vy[b] - vy[a]), vz[b] - vz[a]]));
    }
    let s = 0;
    let seg = 0;
    for (;;) {
      while (seg < n - 2 && L[seg + 1] < s) seg++;
      const f = clamp((s - L[seg]) / (L[seg + 1] - L[seg] || 1));
      const r = lerp(pts[seg][3], pts[seg + 1][3], f);
      const ta = T[seg];
      const tb = T[seg + 1];
      let tx = lerp(ta[0], tb[0], f);
      let ty = lerp(ta[1], tb[1], f);
      let tz = lerp(ta[2], tb[2], f);
      const tl = 1 / (Math.hypot(tx, ty, tz) || 1);
      tx *= tl;
      ty *= tl;
      tz *= tl;
      const end = s >= total;
      const cap = s <= 0 ? (capStart ? -1 : 0) : end ? (capEnd ? 1 : 0) : 0;
      this.splat(lerp(vx[seg], vx[seg + 1], f), lerp(vy[seg], vy[seg + 1], f), lerp(vz[seg], vz[seg + 1], f), r, typeof m === 'function' ? m(s / total, s) : m, tx, ty, tz, cap);
      if (end) break;
      s = Math.min(total, s + Math.max(0.22, r * 0.16));
    }
  }

  /**
   * Sphere-trace an implicit solid. sdf(x, y, z) takes view-space px relative to the camera
   * origin (y up, z toward the viewer). box = [xmin, ymin, xmax, ymax, zBack, zFront] in the same
   * space. shadeFn(x, y, z, n, m) fills the material m (and may bend the normal n in place).
   */
  march(cam, sdf, box, shadeFn, o = {}) {
    const ss = this.ss;
    const W = this.W;
    const relax = o.relax ?? 0.85;
    const eps = o.eps ?? 0.04;
    const maxSteps = o.steps ?? 56;
    const e = o.e ?? 0.3;
    const thick = (o.thick ?? 1e6) * ss;
    const stepFn = o.stepFn ?? sdf;
    const X0 = Math.max(0, Math.floor((cam.ox + box[0]) * ss));
    const X1 = Math.min(W - 1, Math.ceil((cam.ox + box[2]) * ss));
    const Y0 = Math.max(Math.max(0, Math.ceil(this.clipTop * ss)), Math.floor((cam.oy - box[3]) * ss));
    const Y1 = Math.min(Math.min(this.H - 1, Math.ceil((cam.oy - box[1]) * ss)), Math.floor(this.clipY * ss) - 1);
    const zBack = box[4];
    const zFront = box[5];
    const m = mat(0, 0, 0);
    const n = [0, 0, 1];
    for (let py = Y0; py <= Y1; py++) {
      const y = cam.oy - (py + 0.5) / ss;
      for (let px = X0; px <= X1; px++) {
        const x = (px + 0.5) / ss - cam.ox;
        const i = py * W + px;
        if (this.z[i] >= zFront * ss) continue;
        if ((this.cut && py + 0.5 > this.cut[px]) || (this.cutTop && py + 0.5 < this.cutTop[px])) continue;
        let z = zFront;
        let hit = false;
        for (let k = 0; k < maxSteps; k++) {
          const d = stepFn(x, y, z);
          if (d < eps) {
            hit = true;
            break;
          }
          z -= d * relax;
          if (z < zBack) break;
        }
        if (!hit) continue;
        const Z = z * ss;
        if (Z <= this.z[i]) continue;
        // tetrahedral gradient
        const a = sdf(x + e, y - e, z - e);
        const b = sdf(x - e, y - e, z + e);
        const c = sdf(x - e, y + e, z - e);
        const d = sdf(x + e, y + e, z + e);
        let gx = a - b - c + d;
        let gy = -a - b + c + d;
        let gz = -a + b - c + d;
        const gl = 1 / (Math.hypot(gx, gy, gz) || 1);
        n[0] = gx * gl;
        n[1] = gy * gl;
        n[2] = gz * gl;
        if (n[2] < 0.02) {
          // grazing hit: keep the normal facing the viewer
          n[2] = 0.02;
          const l = 1 / Math.hypot(n[0], n[1], n[2]);
          n[0] *= l;
          n[1] *= l;
          n[2] *= l;
        }
        m.gl = 0;
        m.sh = 0.1;
        m.o = 1;
        m.a = 1;
        m.tr = 0;
        shadeFn(x, y, z, n, m);
        this.z[i] = Z;
        this.nx[i] = n[0];
        this.ny[i] = n[1];
        this.nz[i] = n[2];
        this.cr[i] = m.r;
        this.cg[i] = m.g;
        this.cb[i] = m.b;
        this.gl[i] = m.gl;
        this.sh[i] = m.sh;
        this.oc[i] = m.o;
        this.th[i] = thick;
        this.al[i] = m.a;
        this.tr[i] = m.tr ?? 0;
      }
    }
  }

  /** Screen-space ambient occlusion (radius in output px). Returns a Float32Array of 0..1. */
  ssao(radius, strength, K = 14, bias = 0.06) {
    const { W, H, z, nx, ny, nz } = this;
    const R = radius * this.ss;
    const out = new Float32Array(W * H).fill(1);
    const offs = new Float32Array(K * 2);
    for (let k = 0; k < K; k++) {
      const a = k * 2.399963;
      const r = Math.sqrt((k + 0.5) / K) * R;
      offs[k * 2] = Math.cos(a) * r;
      offs[k * 2 + 1] = Math.sin(a) * r;
    }
    const bR = bias * R;
    const eps = 0.02 * R * R;
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const zi = z[i];
        if (zi < -1e8) continue;
        const ang = ign(px, py) * TAU;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const ax = nx[i];
        const ay = ny[i];
        const az = nz[i];
        let occ = 0;
        for (let k = 0; k < K; k++) {
          const ox = offs[k * 2] * cs - offs[k * 2 + 1] * sn;
          const oy = offs[k * 2] * sn + offs[k * 2 + 1] * cs;
          const sx = Math.round(px + ox);
          const sy = Math.round(py + oy);
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          const zj = z[sy * W + sx];
          if (zj < -1e8) continue;
          const vz = zj - zi;
          const vn = ox * ax - oy * ay + vz * az - bR;
          if (vn <= 0) continue;
          occ += (vn * R) / (ox * ox + oy * oy + vz * vz + eps);
        }
        out[i] = Math.exp((-strength * occ) / K);
      }
    return out;
  }

  /** Soft key-light shadow from the depth buffer. Returns 0 (lit) .. 1 (shadowed). */
  shadow(maxDist, soft = 0.35) {
    const { W, H, z, th } = this;
    const ss = this.ss;
    const out = new Float32Array(W * H);
    const l2 = Math.hypot(KEY[0], KEY[1]);
    const lx = KEY[0] / l2;
    const ly = -KEY[1] / l2;
    const lz = KEY[2] / l2;
    const D = maxDist * ss;
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const zi = z[i];
        if (zi < -1e8) continue;
        let s = 0;
        const j0 = ign(px + 7, py + 3);
        for (let t = 1.5 + j0 * 1.5; t < D; t = t * 1.22 + 1) {
          const sx = Math.round(px + lx * t);
          const sy = Math.round(py + ly * t);
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) break;
          const j = sy * W + sx;
          const zj = z[j];
          if (zj < -1e8) continue;
          const d = zj - (zi + lz * t) - (0.6 + 0.12 * t);
          if (d <= 0 || d > th[j] + t) continue;
          const v = clamp(d / (soft * t + 1.5)) * (1 - (t / D) * (t / D));
          if (v > s) s = v;
        }
        out[i] = s;
      }
    return out;
  }

  /**
   * Shade every sample and box-filter down to the output resolution.
   * o.ao: [[radiusPx, strength], ...]   o.shadow: [maxDistPx, strength]
   * o.depth: [zBack, zFront, darkest, cool] depth cue in px   o.grade: post colour function
   */
  resolve(o = {}) {
    const { W, H, ss } = this;
    const n = W * H;
    const ao = new Float32Array(n).fill(1);
    for (const [rad, str] of o.ao ?? [[2.5, 0.5], [9, 0.55]]) {
      const a = this.ssao(rad, str, rad > 5 ? 18 : 12);
      for (let i = 0; i < n; i++) ao[i] *= a[i];
    }
    const sh = o.shadow ? this.shadow(o.shadow[0], o.shadow[2] ?? 0.35) : null;
    const shK = o.shadow ? o.shadow[1] : 0;
    const dp = o.depth;
    const tint = o.tint ?? true;
    const gain = o.gain ?? 1;
    const grade = o.grade ?? (tint ? (c) => gradeTint(c, gain) : gradeColour);
    const rimCut = o.rimCut ?? (tint ? 0.85 : 0);
    const img = new Img(this.w, this.h);
    const inv = 1 / (ss * ss);
    const nrm = [0, 0, 1];
    const alb = [0, 0, 0];
    for (let py = 0; py < H; py++) {
      const orow = Math.floor(py / ss) * this.w;
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const a = this.al[i];
        if (a <= 0 || this.z[i] < -1e8) continue;
        nrm[0] = this.nx[i];
        nrm[1] = this.ny[i];
        nrm[2] = this.nz[i];
        alb[0] = this.cr[i];
        alb[1] = this.cg[i];
        alb[2] = this.cb[i];
        let occ = ao[i] * this.oc[i];
        if (dp) {
          const t = clamp((this.z[i] / ss - dp[0]) / (dp[1] - dp[0]));
          const k = lerp(dp[2], 1, t);
          const cool = (1 - t) * (dp[3] ?? 0);
          alb[0] *= k * (1 - cool);
          alb[1] *= k * (1 - cool * 0.35);
          alb[2] *= k;
          occ *= lerp(dp[4] ?? 0.8, 1, t);
        }
        const tr = this.tr[i];
        if (tr > 0) {
          // translucent tissue: light wraps around the form and lifts the shadow side
          nrm[0] *= 1 - 0.45 * tr;
          nrm[1] += 0.2 * tr;
          nrm[2] += 0.5 * tr;
          const l = 1 / Math.hypot(nrm[0], nrm[1], nrm[2]);
          nrm[0] *= l;
          nrm[1] *= l;
          nrm[2] *= l;
          occ = lerp(occ, 1, 0.35 * tr);
        }
        let c = lit(alb, nrm, this.gl[i], this.sh[i], occ);
        const hemi = nrm[1] * 0.5 + 0.5;
        if (rimCut * (1 - tr) > 0) {
          // matte coral: keep the cool rim light only on edges that face up
          const fres = Math.pow(1 - clamp(nrm[2]), 2.6) * (0.1 + 0.3 * clamp(hemi)) * occ * rimCut * (1 - tr) * (1 - smoothstep(0.6, 0.98, hemi));
          c[0] = Math.max(0, c[0] - RIM[0] * fres);
          c[1] = Math.max(0, c[1] - RIM[1] * fres);
          c[2] = Math.max(0, c[2] - RIM[2] * fres);
        }
        if (sh && sh[i] > 0) {
          const k = occ * 0.9;
          const amb = [alb[0] * lerp(GROUND[0], SKY[0], hemi) * k, alb[1] * lerp(GROUND[1], SKY[1], hemi) * k, alb[2] * lerp(GROUND[2], SKY[2], hemi) * k];
          c = mix3(c, amb, sh[i] * shK);
        }
        c = grade(c);
        const q = (orow + Math.floor(px / ss)) * 4;
        const w = a * inv;
        img.d[q] += c[0] * w;
        img.d[q + 1] += c[1] * w;
        img.d[q + 2] += c[2] * w;
        img.d[q + 3] += w;
      }
    }
    return img;
  }
}

/** Soft floor: values below the knee are lifted so nothing falls under `lo` (linear light). */
function softFloor(v, lo = 0.072, knee = 0.18) {
  if (v >= knee) return v;
  return lo + (knee - lo) * Math.pow(Math.max(0, v) / knee, knee / (knee - lo));
}
/**
 * Grade for tintable pieces (takes the un-toned lit colour). The shading map is scaled so a
 * surface facing the viewer sits near 0.85 and one facing the key light near 1, rolled off
 * softly at the top, kept mostly neutral with a little warm light / cool shadow, and its blacks
 * are lifted so tinted shadows never go muddy.
 */
function gradeTint(c, gain = 1) {
  const l = Math.max(1e-4, lum(c));
  let v = 0.66 * gain * Math.pow(l, 1.1);
  if (v > 0.72) v = 0.72 + 0.28 * Math.tanh((v - 0.72) / 0.28);
  v = softFloor(v);
  const k = (v / l) * 0.5;
  return [Math.max(0, v + (c[0] - l) * k), Math.max(0, v + (c[1] - l) * k), Math.max(0, v + (c[2] - l) * k)];
}
const gradeColour = (c) => tone(c);

/** Remove stray specks: connected blobs smaller than minArea px, and orphaned faint fringe pixels. */
function despeckle(img, minArea = 14) {
  const { w, h, d } = img;
  const lab = new Int32Array(w * h);
  const stack = [];
  const T = 0.06;
  let nl = 0;
  const kill = [];
  for (let i = 0; i < w * h; i++) {
    if (lab[i] || d[i * 4 + 3] <= T) continue;
    nl++;
    const mine = [];
    stack.push(i);
    lab[i] = nl;
    while (stack.length) {
      const q = stack.pop();
      mine.push(q);
      const qx = q % w;
      const qy = (q - qx) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = qx + dx;
          const yy = qy + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!lab[j] && d[j * 4 + 3] > T) {
            lab[j] = nl;
            stack.push(j);
          }
        }
    }
    if (mine.length < minArea) for (const q of mine) kill.push(q);
  }
  if (!kill.length) return img;
  for (const q of kill) {
    lab[q] = 0;
    d[q * 4] = d[q * 4 + 1] = d[q * 4 + 2] = d[q * 4 + 3] = 0;
  }
  // faint fringe pixels left without a solid neighbour
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (lab[i] || d[i * 4 + 3] <= 0) continue;
      let keep = false;
      for (let dy = -1; dy <= 1 && !keep; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && lab[yy * w + xx]) {
            keep = true;
            break;
          }
        }
      if (!keep) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = d[i * 4 + 3] = 0;
    }
  return img;
}

/** Crop an image to its content (+margin) and wrap it as a sprite part pivoting at (px, py). */
function part(img, px, py, anim = null, at = [0, 0], margin = 3, sit = false) {
  despeckle(img);
  const b = bounds(img, 0.004);
  if (!b) return { img: new Img(2, 2), pivot: [1, 1], at, anim };
  if (sit) {
    // loose scatter: origin at the bottom-centre of what was drawn, resting 1 px into the ground
    px = Math.round((b.x0 + b.x1 + 1) / 2);
    py = b.y1 - 1;
  }
  const x0 = b.x0 - margin;
  const y0 = b.y0 - margin;
  const x1 = b.x1 + margin;
  const y1 = b.y1 + margin;
  return { img: crop(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1), pivot: [px - x0, py - y0], at, anim };
}
const sway = (amp, rate, phase) => ({ kind: 'sway', amp, rate, phase });
const def = (parts, tintable = true, lenPx = UNIT) => ({ lenPx, anchor: 'base', tintable, parts });

// ---------------------------------------------------------------------------- branching skeletons
/** Bounding box of a list of branches ({ pts: [[x, y, z, r], ...] }). */
function skelBounds(branches) {
  const b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 };
  for (const br of branches)
    for (const p of br.pts) {
      b.x0 = Math.min(b.x0, p[0] - p[3]);
      b.x1 = Math.max(b.x1, p[0] + p[3]);
      b.y0 = Math.min(b.y0, p[1] - p[3]);
      b.y1 = Math.max(b.y1, p[1] + p[3]);
      b.z0 = Math.min(b.z0, p[2] - p[3]);
      b.z1 = Math.max(b.z1, p[2] + p[3]);
    }
  return b;
}
/** Scale a skeleton about the origin so it spans targetW x targetH (uniform, fits both). */
function fitSkel(branches, targetW, targetH, sx = 1) {
  const b = skelBounds(branches);
  const s = Math.min(targetW / (b.x1 - b.x0), targetH / b.y1);
  for (const br of branches)
    for (const p of br.pts) {
      p[0] *= s * sx;
      p[1] *= s;
      p[2] *= s;
      p[3] *= s;
    }
  return s;
}

/**
 * Grow one branch: a gently bending, tapering polyline that leans toward `up`.
 * Returns { pts, level, len } with pts [x, y, z, r].
 */
function growBranch(R, p0, d0, r0, len, o) {
  const step = 2;
  const n = Math.max(3, Math.round(len / step));
  let p = p0.slice(0, 3);
  let d = norm3(d0);
  const bend = vscale(randPerp(d, R), (o.bend ?? 0.25) * R.range(0.3, 1));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([p[0], p[1], p[2], r0 * (1 - (1 - (o.taper ?? 0.6)) * Math.pow(t, o.taperPow ?? 1.2))]);
    const k = step / len;
    d = norm3([d[0] + bend[0] * k, d[1] + bend[1] * k + (o.tropism ?? 0.5) * k, d[2] + bend[2] * k]);
    p = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step];
  }
  return { pts, len };
}
/** Direction of a polyline at vertex i. */
const dirAt = (pts, i) => norm3(vsub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]).slice(0, 3));

// ---------------------------------------------------------------------------- shared builders
/**
 * A lumpy mound made of smoothly blended spheres (world [x, y, z, r]), sphere-traced.
 * shadeFn(x, y, z, n, m) works in view space like GBuf.march.
 */
function blobs(g, cam, list, k, shadeFn, o = {}) {
  const vb = list.map(([x, y, z, r, sy]) => {
    const q = cam.p(x, y, z);
    return [q[0] - cam.ox, cam.oy - q[1], q[2], r, 1 / (sy ?? 1)];
  });
  const box = [1e9, 1e9, -1e9, -1e9, 1e9, -1e9];
  for (const q of vb) {
    box[0] = Math.min(box[0], q[0] - q[3] - 2);
    box[1] = Math.min(box[1], q[1] - q[3] - 2);
    box[2] = Math.max(box[2], q[0] + q[3] + 2);
    box[3] = Math.max(box[3], q[1] + q[3] + 2);
    box[4] = Math.min(box[4], q[2] - q[3] - 2);
    box[5] = Math.max(box[5], q[2] + q[3] + 2);
  }
  const amp = o.noise ?? 0;
  const freq = o.freq ?? 0.12;
  const seed = o.seed ?? 0;
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (let i = 0; i < vb.length; i++) {
      const q = vb[i];
      const dy = (y - q[1]) * q[4];
      const dd = (Math.sqrt((x - q[0]) * (x - q[0]) + dy * dy + (z - q[2]) * (z - q[2])) - q[3]) * (q[4] > 1 ? 1 / q[4] : 1);
      d = smin(d, dd, k);
    }
    if (amp) d += (fbm3(x * freq, y * freq, z * freq, 2, seed) - 0.5) * amp;
    return d;
  };
  g.march(cam, sdf, box, shadeFn, { relax: o.relax ?? 0.8, ...o });
  return sdf;
}

/**
 * Sphere-trace a solid given in WORLD space (y up) through a pitched camera.
 * sdf(x, y, z) world; box [x0, y0, z0, x1, y1, z1] world; shadeFn(x, y, z, n, m) gets the world
 * position and the VIEW-space normal. o.stepFn: optional cheaper conservative distance.
 */
function solid(g, cam, sdf, box, shadeFn, o = {}) {
  const c = cam.c;
  const s = cam.s;
  const vb = [1e9, 1e9, -1e9, -1e9, 1e9, -1e9];
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? box[3] : box[0];
    const y = k & 2 ? box[4] : box[1];
    const z = k & 4 ? box[5] : box[2];
    const yv = y * c - z * s;
    const zv = y * s + z * c;
    vb[0] = Math.min(vb[0], x);
    vb[2] = Math.max(vb[2], x);
    vb[1] = Math.min(vb[1], yv);
    vb[3] = Math.max(vb[3], yv);
    vb[4] = Math.min(vb[4], zv);
    vb[5] = Math.max(vb[5], zv);
  }
  const f = (x, y, z) => sdf(x, y * c + z * s, -y * s + z * c);
  const st = o.stepFn;
  g.march(cam, f, vb, (x, y, z, n, m) => shadeFn(x, y * c + z * s, -y * s + z * c, n, m), { ...o, stepFn: st ? (x, y, z) => st(x, y * c + z * s, -y * s + z * c) : undefined });
}
/** Approximate distance to an ellipsoid centred at the origin. */
function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.sqrt((x * x) / (rx * rx) + (y * y) / (ry * ry) + (z * z) / (rz * rz));
  const k1 = Math.sqrt((x * x) / (rx * rx * rx * rx) + (y * y) / (ry * ry * ry * ry) + (z * z) / (rz * rz * rz * rz));
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}
/** Bounding box of a list of ellipsoids [x, y, z, rx, ry, rz] with a margin. */
function lobeBox(lobes, pad = 4) {
  const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
  for (const l of lobes)
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], l[k] - l[k + 3] - pad);
      b[k + 3] = Math.max(b[k + 3], l[k] + l[k + 3] + pad);
    }
  return b;
}

/**
 * Corallite knobs: small bumps packed in a spiral lattice over a branch, tilted toward its tip.
 * matFn(t, y) -> material.
 */
function corallites(g, cam, br, R, matFn, o = {}) {
  const pts = br.pts;
  const n = pts.length;
  const spacing = o.spacing ?? 2.5;
  const rb0 = o.r ?? 1.05;
  const total = (n - 1) * 2;
  let s = o.start ?? 1.5;
  let phi = R.range(0, TAU);
  const end = total - (o.end ?? 3);
  while (s < end) {
    const fi = s / 2;
    const i = Math.min(n - 2, Math.floor(fi));
    const f = fi - i;
    const a = pts[i];
    const b = pts[i + 1];
    const r = lerp(a[3], b[3], f);
    const T = dirAt(pts, i);
    let Uv = vcross(T, [0, 0, 1]);
    if (vlen(Uv) < 0.2) Uv = vcross(T, [1, 0, 0]);
    Uv = norm3(Uv);
    const Vv = vcross(T, Uv);
    phi += 2.399963;
    const ang = phi + R.range(-0.35, 0.35);
    const nr = vadd(vscale(Uv, Math.cos(ang)), vscale(Vv, Math.sin(ang)));
    s += (spacing * spacing) / (TAU * Math.max(1.2, r)) * R.range(0.8, 1.2);
    if (cam.d(nr)[2] < -0.3) continue;
    const rb = rb0 * R.range(0.8, 1.2) * (0.8 + r * 0.05);
    const c = [lerp(a[0], b[0], f) + nr[0] * (r - rb * 0.25) + T[0] * rb * 0.5, lerp(a[1], b[1], f) + nr[1] * (r - rb * 0.25) + T[1] * rb * 0.5, lerp(a[2], b[2], f) + nr[2] * (r - rb * 0.25) + T[2] * rb * 0.5];
    g.ball(cam, c[0], c[1], c[2], rb, matFn(s / total, c[1]));
  }
}

// ---------------------------------------------------------------------------- stony: branching
const STAGHORN = [
  // open, antler-like staghorn
  { prim: 6, spread: 1.14, lean: -0.04, len: [100, 128], r0: 7.1, levels: 3, kids: [[3, 4], [1, 3], [0, 1]], ang: [0.7, 1.1], kidLen: [0.42, 0.64], kidR: 0.8, tropism: 1.2, bend: 0.4, zs: 0.6, taper: 0.5 },
  // dense upright bush, leaning with the current
  { prim: 8, spread: 0.66, lean: 0.22, len: [86, 138], r0: 4.9, levels: 3, kids: [[3, 5], [2, 3], [0, 2]], ang: [0.42, 0.72], kidLen: [0.34, 0.56], kidR: 0.85, tropism: 0.5, bend: 0.3, zs: 0.7, taper: 0.52 },
  // low bottlebrush: main axes only, the brush is added afterwards
  { prim: 6, spread: 1.2, lean: 0.06, len: [70, 104], r0: 3.9, levels: 1, kids: [[1, 2]], ang: [0.6, 0.95], kidLen: [0.45, 0.7], kidR: 0.9, tropism: 0.55, bend: 0.4, zs: 0.6, taper: 0.62 },
];
function staghornSkeleton(R, P) {
  const out = [];
  const sub = (parent, level) => {
    if (level > P.levels) return;
    const [k0, k1] = P.kids[level - 1];
    const nk = R.int(k0, k1);
    const n = parent.pts.length - 1;
    let side = R.chance(0.5) ? 1 : -1;
    for (let k = 0; k < nk; k++) {
      const t0 = clamp(0.2 + ((k + R.range(0.15, 0.85)) / nk) * 0.64, 0.15, 0.88);
      const i = Math.round(t0 * n);
      const q = parent.pts[i];
      const pd = dirAt(parent.pts, i);
      // fork plane: mostly the picture plane, with some depth so branches cross each other
      let axis = norm3([R.range(-0.5, 0.5) * P.zs, R.range(-0.5, 0.5) * P.zs, side]);
      axis = norm3(vsub(axis, vscale(pd, vdot(axis, pd))));
      side = -side;
      const cd = rotAbout(pd, axis, R.range(P.ang[0], P.ang[1]));
      const len = parent.len * (1 - t0 * 0.5) * R.range(P.kidLen[0], P.kidLen[1]);
      if (len < 8) continue;
      const b = growBranch(R, q, cd, q[3] * P.kidR, len, { tropism: P.tropism * 1.6, bend: P.bend, taper: P.taper + 0.08 });
      b.level = level;
      out.push(b);
      sub(b, level + 1);
    }
  };
  for (let k = 0; k < P.prim; k++) {
    const f = P.prim === 1 ? 0.5 : k / (P.prim - 1);
    const a = (f * 2 - 1) * P.spread + P.lean + R.range(-0.1, 0.1);
    const zt = (k % 2 ? 1 : -1) * R.range(0.15, 0.5) * P.zs + R.range(-0.12, 0.12);
    const d = norm3([Math.sin(a), Math.cos(a), zt]);
    const len = R.range(P.len[0], P.len[1]) * (1 - 0.2 * Math.abs(f * 2 - 1));
    const b = growBranch(R, [Math.sin(a) * 9 + R.range(-3, 3), -6, zt * 9], d, P.r0 * R.range(0.9, 1.12), len, { tropism: P.tropism, bend: P.bend, taper: P.taper });
    b.level = 0;
    out.push(b);
    sub(b, 1);
  }
  return out;
}

function coralBranch(id, v, ss) {
  const R = rng(hashStr(id));
  const P = STAGHORN[v - 1];
  const branches = staghornSkeleton(R, P);
  const brush = v === 3;
  if (brush) {
    // bottlebrush: every axis carries a dense spiral of short, tip-ward leaning branchlets
    for (const br of branches.slice()) {
      const n = br.pts.length;
      let phi = R.range(0, TAU);
      for (let s = 7; s < br.len - 2; s += R.range(1.5, 2.3)) {
        const i = Math.min(n - 2, Math.floor(s / 2));
        const q = br.pts[i];
        const T = dirAt(br.pts, i);
        let Uv = vcross(T, [0, 0, 1]);
        if (vlen(Uv) < 0.2) Uv = vcross(T, [1, 0, 0]);
        Uv = norm3(Uv);
        const Vv = vcross(T, Uv);
        phi += 2.399963 + R.range(-0.3, 0.3);
        const out = vadd(vscale(Uv, Math.cos(phi)), vscale(Vv, Math.sin(phi)));
        const t = s / br.len;
        const d = norm3(vadd(vscale(out, 1), vscale(T, 0.55 + 0.5 * t)));
        const len = R.range(8, 13.5) * (1 - 0.45 * smoothstep(0.7, 1, t)) * (0.75 + 0.25 * smoothstep(0, 0.25, t));
        const b = growBranch(R, q, d, R.range(1.9, 2.4), len, { tropism: 0.5, bend: 0.3, taper: 0.7 });
        b.level = 9;
        b.twig = true;
        branches.push(b);
      }
    }
  }
  fitSkel(branches, 1.2 * UNIT - 4, (brush ? 0.84 : 1.1) * UNIT - 2);
  const b = skelBounds(branches);
  const pad = 8;
  const w = Math.ceil(b.x1 - b.x0) + pad * 2;
  const h = Math.ceil(b.y1) + pad + 22;
  const cam = camera(Math.round(-b.x0) + pad, Math.ceil(b.y1) + pad, 0.1);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  const top = b.y1;
  // light falls off inside the thicket and toward the base
  const occAt = (y) => lerp(0.68, 1, smoothstep(-8, top * 0.5, y));
  const m = grey(1);
  // low encrusting base that roots the colony on the rock
  const list = [];
  const bw = brush ? 24 : 17;
  for (let k = 0; k < 7; k++) list.push([((k + R.range(0.1, 0.9)) / 7 * 2 - 1) * bw, R.range(-6, -3), R.range(-7, 7), R.range(7.5, 10.5), 0.8]);
  blobs(g, cam, list, 12, (x, y, z, n, mm) => setGrey(mm, 0.86 + 0.12 * fbm3(x * 0.3, y * 0.3, z * 0.3, 2, 5), occAt(y)), { noise: 2.5, freq: 0.18, seed: 3 });
  for (const br of branches) {
    const tipLen = Math.min(0.55, (br.twig ? 5 : 12) / br.len);
    const body = br.twig ? 0.96 : 0.92;
    const matFn = (t, y) => setGrey(m, lerp(body, 1.14, smoothstep(1 - tipLen, 1, t)), occAt(y));
    const y0 = br.pts[0][1];
    const y1 = br.pts[br.pts.length - 1][1];
    g.tube(cam, br.pts, (t) => matFn(t, lerp(y0, y1, t)));
    if (!br.twig) corallites(g, cam, br, R, (t, y) => matFn(Math.min(t, 0.999), y), { spacing: brush ? 3 : 2.5, r: 1.0, end: 4 });
  }
  const img = g.resolve({ ao: [[2, 0.5], [6, 0.5], [16, 0.5]], shadow: [34, 0.65], depth: [b.z0, b.z1, 0.78, 0.12, 0.84], gain: 1.3 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- stony: brain
/**
 * Labyrinth (Turing-like) pattern on an N x N torus: repeated band-pass filtering with a hard
 * clamp grows random noise into evenly spaced meandering ridges. Returns values in 0..1.
 */
function labyrinth(R, N, wavelength, iters = 36) {
  let v = new Float32Array(N * N);
  for (let i = 0; i < v.length; i++) v[i] = R.range(-1, 1);
  const tmp = new Float32Array(N * N);
  const gauss = (src, dst, rad) => {
    const r = Math.ceil(rad * 2.6);
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * rad * rad));
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += src[y * N + ((x + i + N * 4) % N)] * k[i + r];
        tmp[y * N + x] = a;
      }
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += tmp[((y + i + N * 4) % N) * N + x] * k[i + r];
        dst[y * N + x] = a;
      }
  };
  const ra = wavelength / 6.54;
  const A = new Float32Array(N * N);
  const I = new Float32Array(N * N);
  for (let it = 0; it < iters; it++) {
    gauss(v, A, ra);
    gauss(v, I, ra * 2);
    for (let i = 0; i < v.length; i++) v[i] = clamp(v[i] + 3.2 * (A[i] - I[i]), -1, 1);
  }
  gauss(v, A, wavelength * 0.085);
  for (let i = 0; i < v.length; i++) A[i] = clamp(A[i] * 0.62 + 0.5);
  return A;
}
/** Smooth (quadratic B-spline) lookup into a tiling N x N grid. */
function gridAt(g, N, x, y) {
  const xi = Math.floor(x + 0.5);
  const yi = Math.floor(y + 0.5);
  const fx = x + 0.5 - xi;
  const fy = y + 0.5 - yi;
  const wx0 = 0.5 * (1 - fx) * (1 - fx);
  const wx2 = 0.5 * fx * fx;
  const wx1 = 1 - wx0 - wx2;
  const wy0 = 0.5 * (1 - fy) * (1 - fy);
  const wy2 = 0.5 * fy * fy;
  const wy1 = 1 - wy0 - wy2;
  const x0 = (((xi - 1) % N) + N) % N;
  const x1 = (x0 + 1) % N;
  const x2 = (x0 + 2) % N;
  const y0 = ((((yi - 1) % N) + N) % N) * N;
  const y1 = ((((yi % N) + N) % N)) * N;
  const y2 = ((((yi + 1) % N) + N) % N) * N;
  return (g[y0 + x0] * wx0 + g[y0 + x1] * wx1 + g[y0 + x2] * wx2) * wy0 + (g[y1 + x0] * wx0 + g[y1 + x1] * wx1 + g[y1 + x2] * wx2) * wy1 + (g[y2 + x0] * wx0 + g[y2 + x1] * wx1 + g[y2 + x2] * wx2) * wy2;
}

function coralBrain(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  // lobes: [x, y, z, rx, ry, rz]
  const lobes = v === 1
    ? [[0, 12, 0, 80, 92, 72]]
    : [[-16, 6, 0, 58, 86, 56], [38, 0, 6, 44, 64, 42], [-54, -6, 10, 28, 44, 28]];
  const wl = v === 1 ? 11.5 : 8.6;
  const amp = v === 1 ? 3.0 : 2.3;
  const N = 256;
  const lab = labyrinth(R, N, wl);
  const pitch = 0.16;
  const w = 190;
  const h = 150;
  const cam = camera(95, 126, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  // pattern coordinates: azimuthal-equidistant unwrap of the direction from a point under the
  // dome, about an axis leaning toward the viewer, so the meanders foreshorten at the silhouette
  const pc = [lobes[0][0] * 0.4, -18, 0];
  const ax = norm3([0, 0.45, 1]);
  const e1 = [1, 0, 0];
  const e2 = vcross(ax, e1);
  const Rm = 82;
  const pat = (x, y, z) => {
    const dx = x - pc[0];
    const dy = y - pc[1];
    const dz = z - pc[2];
    const il = 1 / (Math.hypot(dx, dy, dz) || 1);
    const ca = clamp((dx * ax[0] + dy * ax[1] + dz * ax[2]) * il, -1, 1);
    const al = Math.acos(ca);
    const k = (al / (Math.sin(al) || 1e-6)) * il * Rm;
    return gridAt(lab, N, (dx * e1[0] + dy * e1[1] + dz * e1[2]) * k + 91.3, (dx * e2[0] + dy * e2[1] + dz * e2[2]) * k + 37.7);
  };
  const base = (x, y, z) => {
    let d = 1e9;
    for (const l of lobes) d = smin(d, sdEllipsoid(x - l[0], y - l[1], z - l[2], l[3], l[4], l[5]), 14);
    return d + (fbm3(x * 0.022, y * 0.022, z * 0.022, 2, seed) - 0.5) * 9;
  };
  const sdf = (x, y, z) => {
    const d = base(x, y, z);
    if (d > amp + 1.5) return d - amp;
    return d - amp * pat(x, y, z) * smoothstep(-10, 6, y);
  };
  solid(g, cam, sdf, lobeBox(lobes, 8), (x, y, z, n, m) => {
    const hgt = pat(x, y, z);
    const grain = fbm3(x * 0.9, y * 0.9, z * 0.9, 2, 7) - 0.5;
    // pale ridge crests, shaded valleys, a faint groove along each crest
    const crest = smoothstep(0.82, 1, hgt);
    const val = lerp(0.6, 1.0, smoothstep(0.1, 0.8, hgt)) - 0.07 * crest + 0.07 * grain;
    setGrey(m, val, lerp(0.58, 1, smoothstep(0.05, 0.75, hgt)) * lerp(0.62, 1, smoothstep(-8, 30, y)));
  }, { relax: 0.8, steps: 60, e: 0.32 });
  const img = g.resolve({ ao: [[1.6, 0.6], [5, 0.45], [16, 0.5]], shadow: [14, 0.35], gain: 1.18 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- stony: boulder
function coralBoulder(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  let lobes;
  let knobs;
  if (v === 1) {
    // broad mound: a main dome shouldered by big rounded lobes
    lobes = [[0, 34, -8, 66, 84, 56], [-56, 12, 16, 40, 54, 38], [58, 8, 14, 42, 50, 38], [6, 2, 42, 40, 42, 28], [-28, 92, 10, 34, 36, 32], [34, 80, 8, 31, 33, 30]];
    knobs = [[-56, 58, 22, 10], [62, 50, 22, 9], [-30, 104, 14, 10], [18, 46, 54, 9], [80, 20, 22, 8]];
  } else {
    // taller, lopsided colony piled up from many nodular lumps
    lobes = [[-14, 24, -8, 56, 62, 50], [-30, 74, 0, 37, 36, 34], [14, 62, 6, 35, 33, 32], [46, 28, 8, 38, 40, 34], [-58, 16, 12, 32, 36, 30], [8, 12, 36, 37, 31, 26], [-8, 102, 2, 25, 22, 24], [68, 4, 18, 25, 26, 24], [-34, 42, 34, 25, 24, 20]];
    knobs = [[-52, 94, 10, 11], [30, 90, 14, 10], [60, 62, 20, 10], [-72, 46, 22, 9], [24, 40, 44, 9], [-22, 120, 8, 9], [84, 26, 20, 8]];
  }
  const tw = 1.25 * UNIT;
  const th = 1.0 * UNIT;
  // normalise the composition to the target size
  const bb = lobeBox(lobes, 0);
  const sc = Math.min(tw / (bb[3] - bb[0]), th / bb[4]);
  for (const l of lobes) for (let k = 0; k < 6; k++) l[k] *= sc;
  for (const k of knobs) for (let j = 0; j < 4; j++) k[j] *= sc;
  const pitch = 0.14;
  const w = Math.ceil(tw) + 24;
  const h = Math.ceil(th) + 44;
  const cam = camera(Math.round(w / 2 - (bb[0] + bb[3]) * sc * 0.5), Math.ceil(th) + 22, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (const l of lobes) d = smin(d, sdEllipsoid(x - l[0], y - l[1], z - l[2], l[3], l[4], l[5]), 5.5);
    for (const k of knobs) d = smin(d, Math.hypot(x - k[0], y - k[1], z - k[2]) - k[3], 6);
    // tuck the skirt in at the ground and roughen the whole mass
    d = Math.max(d, -(y + 14));
    return d + (fbm3(x * 0.04, y * 0.04, z * 0.04, 3, seed) - 0.5) * 8 + 2.5 * smoothstep(6, -8, y);
  };
  solid(g, cam, sdf, lobeBox(lobes.concat(knobs.map((k) => [k[0], k[1], k[2], k[3], k[3], k[3]])), 6), (x, y, z, n, m) => {
    // fine corallite pores, broad mottling, pale growing crowns of the lumps
    const wv = worley3(x * 0.46, y * 0.46, z * 0.46, seed);
    const pit = smoothstep(0.4, 0.15, wv[0]);
    const mott = fbm3(x * 0.045, y * 0.045, z * 0.045, 3, seed + 5) - 0.5;
    const crown = smoothstep(0.35, 0.95, n[1]);
    setGrey(m, 0.84 + 0.2 * mott - 0.2 * pit + 0.1 * crown, (1 - 0.25 * pit) * lerp(0.56, 1, smoothstep(-8, 40, y)));
  }, { relax: 0.8, steps: 56, e: 0.35 });
  const img = g.resolve({ ao: [[2.2, 0.6], [7, 0.75], [20, 0.7]], shadow: [26, 0.6], gain: 1.06 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- stony: encrusting
function coralEncrust(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  // plates: [x, y, z, rx, rz, tilt about z (rad), lip, phase]
  const plates = v === 1
    // tiers of thin shelves stepping up a hidden core
    ? [[-18, 3, 12, 56, 34, 0.04, 4, 0.3], [28, 9, 8, 44, 28, -0.07, 4, 1.7], [-32, 17, 0, 38, 25, 0.1, 4, 3.1], [14, 24, -4, 40, 24, -0.08, 4, 4.4], [-12, 33, -10, 30, 20, 0.06, 3.5, 5.3], [16, 41, -15, 20, 14, -0.05, 3, 0.9]]
    // a low crust of broad overlapping lobes with raised lips
    : [[-30, 2, 10, 38, 30, 0.1, 6, 0.9], [26, 3, 12, 42, 30, -0.1, 6, 2.2], [-4, 9, -2, 40, 26, 0.02, 5.5, 3.6], [-40, 13, -8, 24, 20, 0.2, 5, 5.0], [34, 15, -8, 26, 20, -0.2, 5, 0.2], [0, 21, -16, 22, 16, 0.0, 4.5, 1.4]];
  const thick = v === 1 ? 3.6 : 4.2;
  const k0 = 0.86;
  const prep = plates.map((p) => ({ x: p[0] * k0, y: p[1], z: p[2], rx: p[3] * k0, rz: p[4], c: Math.cos(p[5]), s: Math.sin(p[5]), lip: p[6], ph: p[7], rm: Math.min(p[3] * k0, p[4]) }));
  /** distance to one plate; P1 receives the normalised radius and the angle. */
  const P1 = [0, 0, 0];
  const plate = (p, x, y, z) => {
    const dx = x - p.x;
    const dy0 = y - p.y;
    const lx = dx * p.c + dy0 * p.s;
    const ly = -dx * p.s + dy0 * p.c;
    const lz = z - p.z;
    const ang = Math.atan2(lz / p.rz, lx / p.rx);
    const edge = 1 + 0.1 * Math.sin(3 * ang + p.ph) + 0.06 * Math.sin(5 * ang + p.ph * 2.3) + 0.035 * Math.sin(11 * ang + p.ph * 5);
    const rho = Math.hypot(lx / p.rx, lz / p.rz) / edge;
    // gently drooping shelf with an upturned, slightly wavy lip
    const rc = Math.min(rho, 1.15);
    const ys = p.lip * rc * rc * rc - 2.4 * rc + 1.3 * Math.sin(4 * ang + p.ph) * rc * rc;
    const t = thick * (1 - 0.5 * Math.min(1, rho));
    P1[0] = ly - ys;
    P1[1] = rho;
    P1[2] = ang;
    return smax(Math.abs(ly - ys) - t * 0.5, (rho - 1) * p.rm, 2.2) * 0.8;
  };
  const core = v === 1 ? [[0, 4, -22, 26, 31, 13]] : [[0, -3, -14, 32, 14, 14]];
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (const c of core) d = smin(d, sdEllipsoid(x - c[0], y - c[1], z - c[2], c[3], c[4], c[5]), 6);
    for (const p of prep) d = Math.min(d, plate(p, x, y, z));
    return d;
  };
  const pitch = 0.36;
  const w = 170;
  const h = 96;
  const cam = camera(85, 74, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 9.5, 1.5, hashStr(id) & 255);
  solid(g, cam, sdf, [-80, -12, -50, 80, 52, 56], (x, y, z, n, m) => {
    // which surface are we on?
    let best = 1e9;
    let rho = 0;
    let side = 0;
    let ang = 0;
    for (const p of prep) {
      const d = plate(p, x, y, z);
      if (d < best) {
        best = d;
        side = P1[0];
        rho = P1[1];
        ang = P1[2];
      }
    }
    if (best < 0.6) {
      const top = side > 0 ? 1 : 0;
      const ring = Math.cos(rho * 30 + 3 * fbm(x * 0.06, z * 0.06, 2, seed));
      const ridge = Math.cos(ang * 34 + 2 * Math.sin(rho * 7));
      const wv = worley(x * 0.3 + seed, z * 0.3 + y * 0.2, seed);
      const pap = smoothstep(0.34, 0.12, wv.f1);
      // pale growing edge, growth rings, radial ridges and small papillae on top; plain shade beneath
      const val = 0.7 + 0.12 * smoothstep(0.1, 0.7, rho) + 0.28 * smoothstep(0.74, 1, rho) + top * (0.06 * ring + 0.07 * ridge * smoothstep(0.2, 0.6, rho) + 0.12 * pap * (1 - smoothstep(0.8, 1, rho)));
      setGrey(m, val, top ? lerp(0.74, 1, smoothstep(0.1, 0.7, rho)) : lerp(0.5, 0.8, smoothstep(0.4, 1, rho)));
    } else setGrey(m, 0.72, 0.6);
  }, { relax: 0.7, steps: 70, e: 0.3 });
  const img = g.resolve({ ao: [[1.6, 0.6], [5, 0.7], [12, 0.5]], shadow: [24, 0.8, 0.3] });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- stony: mushroom / leather
function coralMushroom(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  // caps: [x, z, cap height, cap radius, stalk radius, folds, fold amp, lean, phase]
  const caps = v === 1
    ? [[0, 0, 52, 52, 14, 6, 7, 0.04, 0.8]]
    : [[-10, 0, 62, 44, 12, 5, 10, -0.16, 2.6], [34, 14, 30, 22, 7.5, 4, 4.5, 0.3, 4.4]];
  const prep = caps.map((c) => ({ x: c[0], z: c[1], h: c[2], R: c[3], rs: c[4], nf: c[5], fa: c[6], lean: c[7], ph: c[8] }));
  const Q = [0, 0, 0];
  const one = (p, x, y, z) => {
    // lean the whole polyp
    const lx = x - p.x - p.lean * y;
    const lz = z - p.z;
    const q = Math.hypot(lx, lz);
    const ang = Math.atan2(lz, lx);
    // stalk: waisted column flaring into the cap and the foot
    const t = clamp(y / p.h);
    const rs = p.rs * (1 + 0.5 * Math.exp(-Math.max(0, y + 4) / 7) + 0.9 * t * t * t * t - 0.12 * Math.sin(t * PI)) + 1.2 * Math.sin(ang * 3 + p.ph + y * 0.1);
    const dStalk = smax(q - rs, y - p.h, 3);
    // cap: thick disc with a folded, drooping margin
    const edge = 1 + 0.07 * Math.sin(p.nf * ang + p.ph + 1.1) + 0.04 * Math.sin((p.nf * 2 + 1) * ang + p.ph * 3);
    const rho = q / (p.R * edge);
    const rc = Math.min(rho, 1.1);
    const fold = p.fa * rc * rc * Math.sin(p.nf * ang + p.ph + 0.6 * Math.sin(ang * 2 + p.ph));
    const ys = p.h + 5 * (1 - rc * rc) - 6.5 * rc * rc * rc + fold;
    const th = lerp(8.5, 4.5, clamp(rho));
    const dCap = smax(Math.abs(y - ys) - th * 0.5, (rho - 1) * p.R, 3) * 0.72;
    Q[0] = rho;
    Q[1] = y - ys;
    Q[2] = dCap;
    return smin(dStalk, dCap, 5);
  };
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (const p of prep) d = Math.min(d, one(p, x, y, z));
    // polyps of one colony share an encrusting foot
    if (prep.length > 1) d = smin(d, sdEllipsoid(x - 12, y + 7, z - 6, 40, 9, 16), 5);
    return Math.max(d, -(y + 12));
  };
  const pitch = 0.3;
  const w = 164;
  const h = 124;
  const cam = camera(v === 1 ? 80 : 76, 102, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  solid(g, cam, sdf, [-74, -12, -60, 78, 86, 60], (x, y, z, n, m) => {
    let best = 1e9;
    let rho = 0;
    let dy = 0;
    let cap = false;
    for (const p of prep) {
      const d = one(p, x, y, z);
      if (d < best) {
        best = d;
        rho = Q[0];
        dy = Q[1];
        cap = Q[2] < 1.2;
      }
    }
    if (cap && dy > -0.5) {
      // top of the cap: retracted polyps as a field of small dimples with pale collars
      const wv = worley(x * 0.24 + seed, z * 0.24, seed);
      const dot = smoothstep(0.3, 0.1, wv.f1);
      const collar = smoothstep(0.46, 0.3, wv.f1) - dot;
      setGrey(m, 0.86 + 0.12 * collar - 0.3 * dot + 0.12 * smoothstep(0.75, 1, rho), 1 - 0.25 * dot);
    } else if (cap) {
      // underside of the cap: fine radial pleats, in shadow
      setGrey(m, 0.74, lerp(0.55, 0.85, smoothstep(0.3, 1, rho)));
    } else setGrey(m, 0.8 + 0.08 * (fbm3(x * 0.25, y * 0.12, z * 0.25, 2, seed) - 0.5), lerp(0.6, 0.9, smoothstep(-8, 22, y)));
  }, { relax: 0.7, steps: 70, e: 0.3 });
  const img = g.resolve({ ao: [[1.8, 0.55], [6, 0.6], [16, 0.5]], shadow: [34, 0.8, 0.4] });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- stony: fire coral
/**
 * A thick upright plate: a sheet of spheres filling the region under a crest profile, closed by
 * a rounded rim tube along its free edge. pos(s, y) -> world point for arc position s along the
 * base (px) and height y (px); top(s) is the crest height. matFn(s, y, edgeDist, m) -> material.
 */
function plate(g, cam, len, pos, top, rAt, matFn, y0 = -9) {
  const m = grey(1);
  const step = 0.62;
  const e = 0.6;
  for (let s = 0; s <= len; s += step) {
    const t = top(s);
    for (let y = y0; y <= t; y += step) {
      const p = pos(s, y);
      const tu = cam.d(vsub(pos(s + e, y), pos(s - e, y)));
      const tv = cam.d(vsub(pos(s, y + e), pos(s, y - e)));
      let n = vcross(tu, tv);
      const l = vlen(n);
      if (l < 1e-9) continue;
      n = vscale(n, (n[2] < 0 ? -1 : 1) / l);
      const q = cam.p(p[0], p[1], p[2]);
      g.sheet(q[0], q[1], q[2], rAt(s, y), matFn(s, y, Math.min(t - y, s, len - s), m), n[0], n[1], n[2]);
    }
  }
  // rim: follow the outline up one end, along the crest and down the other
  const rim = [];
  for (let y = y0; y < top(0); y += 1) rim.push([0, y]);
  for (let s = 0; s <= len; s += 0.5) rim.push([s, top(s)]);
  for (let y = top(len); y > y0; y -= 1) rim.push([len, y]);
  const pts = rim.map(([s, y]) => {
    const p = pos(s, y);
    return [p[0], p[1], p[2], rAt(s, y) * 1.12];
  });
  g.tube(cam, pts, (t) => {
    const k = rim[Math.min(rim.length - 1, Math.round(t * (rim.length - 1)))];
    return matFn(k[0], k[1], 0, m);
  });
}

function coralFire(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  // blades: base centre (x, z), length, heading (rad from the x axis), height, lean
  const N = v === 1 ? 7 : 7;
  const blades = [];
  for (let k = 0; k < N; k++) {
    const f = k / (N - 1);
    const side = f * 2 - 1;
    if (v === 1) {
      // broad wavy plates with gently lobed crests, fanning out from the middle
      blades.push({ x: side * 46 + R.range(-5, 5), z: R.range(-12, 12) - (k % 2) * 12, len: R.range(40, 58), head: side * 0.45 + R.range(-0.5, 0.5), h: (124 - 44 * side * side) * R.range(0.8, 1.04), lean: side * 0.24 + R.range(-0.05, 0.05), lobes: R.range(1.4, 2.6), fork: 0 });
    } else {
      // taller, narrower plates whose crests split into blunt fingers; the colony leans
      blades.push({ x: side * 40 + R.range(-6, 6) + 4, z: R.range(-12, 12) - (k % 2) * 9, len: R.range(26, 42), head: side * 0.75 + R.range(-0.5, 0.5), h: (134 - 52 * Math.pow(Math.abs(side + 0.3), 1.6)) * R.range(0.78, 1.04), lean: side * 0.3 + 0.12 + R.range(-0.06, 0.06), lobes: R.range(2.2, 3.4), fork: 1 });
    }
  }
  const pitch = 0.12;
  const w = 200;
  const h = 176;
  const cam = camera(100, 154, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  let zmin = 1e9;
  let zmax = -1e9;
  blades.forEach((b, bi) => {
    const s0 = seed + bi * 37;
    const ch = Math.cos(b.head);
    const sh = Math.sin(b.head);
    const ph = R.range(0, TAU);
    const wv = R.range(5, 8.5);
    const wf = R.range(1.2, 2.1);
    const vf = R.range(5, 8);
    // crest: square shoulders, a few rounded lobes; deep clefts for the fingered form
    const top = (s) => {
      const u = clamp(s / b.len);
      const shoulder = Math.pow(smoothstep(-0.02, 0.2, u) * smoothstep(1.02, 0.8, u), 0.6);
      const lob = 0.5 + 0.5 * Math.cos(u * b.lobes * TAU + ph);
      const n = vnoise(u * 3.1 + s0, 2.2, s0) + 0.35 * vnoise(u * 9.5 + s0, 7.2, s0);
      return b.h * (0.55 + 0.45 * shoulder) * (b.fork ? 0.6 + 0.3 * Math.pow(lob, 0.6) + 0.1 * n : 0.8 + 0.1 * lob + 0.1 * n) - 9;
    };
    const pos = (s, y) => {
      const u = s / b.len;
      const vv = clamp((y + 9) / b.h);
      // the sheet undulates sideways, more so toward the crest, and widens upward
      const off = wv * Math.sin(u * wf * TAU + ph + vv * 1.8) * (0.35 + 0.65 * vv) + 3 * Math.sin(vv * 4 + ph * 2) + 1.3 * Math.sin(u * vf * TAU + ph * 3) * vv;
      const lx = (u - 0.5) * b.len * (1 + 0.3 * vv);
      return [b.x + lx * ch - off * sh + b.lean * y, y, b.z + lx * sh + off * ch];
    };
    plate(g, cam, b.len, pos, top, (s, y) => lerp(3.0, 1.9, clamp((y + 9) / b.h)), (s, y, ed, m) => {
      const p = pos(s, y);
      zmin = Math.min(zmin, p[2]);
      zmax = Math.max(zmax, p[2]);
      // paler growing edge, faint growth banding, scattered pores
      const band = 0.04 * Math.sin(y * 0.5 + 2.2 * vnoise(s * 0.08, y * 0.03, s0));
      const pore = smoothstep(0.3, 0.12, worley(s * 0.42 + s0, y * 0.42, s0).f1) * -0.12;
      return setGrey(m, 0.86 + 0.26 * smoothstep(8, 0.5, ed) + band + pore, lerp(0.64, 1, smoothstep(-6, 40, y)));
    });
  });
  // shared encrusting base
  const list = [];
  for (let k = 0; k < 8; k++) list.push([((k + R.range(0.1, 0.9)) / 8 * 2 - 1) * 44, R.range(-7, -4), R.range(-10, 10), R.range(8, 11), 0.8]);
  blobs(g, cam, list, 12, (x, y, z, n, mm) => setGrey(mm, 0.84, 0.74), { noise: 2.5, freq: 0.18, seed });
  const img = g.resolve({ ao: [[2, 0.5], [7, 0.6], [18, 0.55]], shadow: [40, 0.7, 0.4], depth: [zmin - 4, zmax + 4, 0.76, 0.12, 0.84], gain: 1.15 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- stony: pillar
function coralPillar(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  // pillars: [x, z, height, radius, lean]
  const defs = v === 1
    ? [[-8, -4, 214, 10.5, -0.02], [18, 4, 168, 9.5, 0.05], [-30, 6, 142, 9, -0.08], [36, -8, 108, 8.5, 0.1], [4, 16, 92, 8.5, 0.02], [-46, -6, 70, 8, -0.13], [22, 20, 46, 7.5, 0.1]]
    : [[10, -6, 206, 12, 0.07], [-26, 2, 150, 11, -0.16], [42, 6, 120, 10, 0.22], [-6, 16, 74, 10, -0.03], [-50, 12, 44, 9, -0.26], [30, 22, 34, 8.5, 0.2]];
  const pillars = [];
  for (const d of defs) {
    const b = fleshy(R, growBranch(R, [d[0], -8, d[1]], norm3([Math.sin(d[4]), Math.cos(d[4]), 0]), d[3], d[2] + 8, { tropism: 0.12, bend: 0.14, taper: 0.8, taperPow: 2.2 }), 0.07, 0);
    pillars.push(b);
    if (v === 2 && d[2] > 140) {
      // the tallest pillars of this colony fork near the top
      const n = b.pts.length - 1;
      const i = Math.round(n * R.range(0.62, 0.72));
      const side = d[4] >= 0 ? 1 : -1;
      const f = fleshy(R, growBranch(R, b.pts[i], norm3([side * 0.55, 0.8, R.range(-0.3, 0.3)]), b.pts[i][3] * 0.82, (d[2] - i * 2) * R.range(0.5, 0.75), { tropism: 0.7, bend: 0.2, taper: 0.8, taperPow: 2.2 }), 0.07, 0);
      pillars.push(f);
    }
  }
  const sb = skelBounds(pillars);
  const pad = 9;
  const w = Math.ceil(sb.x1 - sb.x0) + pad * 2 + 20;
  const h = Math.ceil(sb.y1) + pad + 22;
  const cam = camera(Math.round(-sb.x0) + pad + 10, Math.ceil(sb.y1) + pad, 0.1);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  const m = grey(1);
  const top = sb.y1;
  const occAt = (y) => lerp(0.7, 1, smoothstep(-8, top * 0.4, y));
  // encrusting base
  const list = [];
  for (let k = 0; k < 10; k++) list.push([lerp(sb.x0 + 6, sb.x1 - 6, (k + R.range(0.1, 0.9)) / 10), R.range(-9, -5), R.range(-10, 14), R.range(9, 13)]);
  blobs(g, cam, list, 12, (x, y, z, n, mm) => setGrey(mm, 0.8 + 0.1 * (fbm3(x * 0.3, y * 0.3, z * 0.3, 2, seed) - 0.5), occAt(y)), { noise: 3, freq: 0.16, seed });
  for (const b of pillars) {
    const y0 = b.pts[0][1];
    const y1 = b.pts[b.pts.length - 1][1];
    g.tube(cam, b.pts, (t) => setGrey(m, 0.9, occAt(lerp(y0, y1, t))));
    // extended polyps: a dense fuzz of tiny tentacle tufts standing off the surface
    const n = b.pts.length;
    const tipP = b.pts[n - 1];
    const tipT = dirAt(b.pts, n - 1);
    const cnt = Math.round(b.len * b.pts[0][3] * 1.25);
    const capN = Math.round(tipP[3] * tipP[3] * 0.8);
    for (let k = 0; k < cnt + capN; k++) {
      let q;
      let nr;
      if (k < cnt) {
        const fi = R.range(0.02, 1) * (n - 1);
        const i = Math.min(n - 2, Math.floor(fi));
        q = b.pts[i];
        const T = dirAt(b.pts, i);
        // tufts lean every which way so they never line up in rows
        nr = norm3(vadd(vadd(randPerp(T, R), vscale(T, R.range(-0.7, 0.9))), vscale(randPerp(T, R), 0.35)));
      } else {
        // the rounded crown of the pillar is just as fuzzy
        q = tipP;
        nr = norm3(vadd(vscale(randPerp(tipT, R), R.range(0, 1.2)), tipT));
      }
      const dv = cam.d(nr);
      if (dv[2] < -0.25) continue;
      const len = R.range(0.8, 2.0);
      const rr = R.range(0.6, 0.9);
      const a = vadd(q, vscale(nr, q[3] - 0.3));
      const e = vadd(a, vscale(nr, len));
      const o = occAt(a[1]);
      g.tube(cam, [[a[0], a[1], a[2], rr], [e[0], e[1], e[2], rr * 0.8]], (t) => setGrey(m, lerp(0.9, 1.08, t), o));
    }
  }
  const img = g.resolve({ ao: [[1.5, 0.45], [6, 0.55], [16, 0.6]], shadow: [40, 0.7, 0.4], depth: [sb.z0, sb.z1, 0.78, 0.12, 0.84], gain: 1.22 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- sea whips
function whip(id, v, ss) {
  const R = rng(hashStr(id));
  const stalks = [];
  if (v === 1) {
    // a sheaf of slender whips of different heights, leaning apart a little
    const hs = [250, 190, 146, 104, 222];
    hs.forEach((hgt, k) => {
      const a = (k / (hs.length - 1) * 2 - 1) * 0.07 + R.range(-0.015, 0.015);
      const pts = [];
      const ph = R.range(0, TAU);
      const amp = R.range(1.5, 3.5);
      const n = Math.ceil(hgt / 2);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const y = -8 + t * (hgt + 8);
        pts.push([(k - 2) * 2.2 + Math.sin(a) * y + amp * Math.sin(t * 3.3 + ph) * t + a * 34 * t * t, y, (k % 2 ? 1 : -1) * 3 + 4 * Math.sin(t * 2 + ph), lerp(2.5, 1.35, t)]);
      }
      stalks.push({ pts, len: hgt });
    });
  } else {
    // wire coral: one long stalk with a lazy S that winds into an open spiral, plus a short companion
    const pts = [];
    let x = -6;
    let y = -8;
    let a = 0.02;
    const n = 190;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([x, y, 6 * Math.sin(t * 9) * smoothstep(0.6, 1, t), lerp(2.7, 1.45, t)]);
      // heading: slow S below, then tightening curl
      const curl = smoothstep(0.66, 1, t);
      a += 0.006 * Math.cos(t * 7.5 + 0.6) * (1 - curl) + curl * 0.3;
      x += Math.sin(a) * 1.5;
      y += Math.cos(a) * 1.5;
    }
    stalks.push({ pts, len: 285 });
    const p2 = [];
    for (let i = 0; i <= 50; i++) {
      const t = i / 50;
      p2.push([6 + 6 * t * t + 2 * Math.sin(t * 5), -8 + t * 104, -4 + 2 * t, lerp(2.3, 1.3, t)]);
    }
    stalks.push({ pts: p2, len: 105 });
  }
  const sb = skelBounds(stalks);
  const pad = 8;
  const w = Math.ceil(sb.x1 - sb.x0) + pad * 2 + 8;
  const h = Math.ceil(sb.y1) + pad + 20;
  const cam = camera(Math.round(-sb.x0) + pad + 4, Math.ceil(sb.y1) + pad, 0);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  const m = grey(1);
  const occAt = (y) => lerp(0.68, 1, smoothstep(-6, 50, y));
  for (const st of stalks) {
    const n = st.pts.length;
    g.tube(cam, st.pts, (t) => setGrey(m, 0.8, occAt(st.pts[Math.min(n - 1, Math.round(t * (n - 1)))][1])));
    // polyps: paired rows of tiny pale knobs, a little irregular
    let acc = 0;
    let flip = 1;
    for (let i = 3; i < n - 1; i++) {
      acc += vlen(vsub(st.pts[i], st.pts[i - 1]));
      if (acc < 2.1) continue;
      acc = 0;
      flip = -flip;
      const q = st.pts[i];
      const T = dirAt(st.pts, i);
      const side = norm3(vcross(T, [0, 0, 1]));
      for (const sgn of [flip, -flip * (R.chance(0.7) ? 1 : 0)]) {
        if (!sgn) continue;
        const nr = norm3([side[0] * sgn + R.range(-0.3, 0.3), side[1] * sgn + R.range(-0.3, 0.3), R.range(0.0, 0.9)]);
        const rb = R.range(0.85, 1.25);
        g.ball(cam, q[0] + nr[0] * (q[3] + rb * 0.35), q[1] + nr[1] * (q[3] + rb * 0.35), q[2] + nr[2] * (q[3] + rb * 0.35), rb, setGrey(m, 1.06, occAt(q[1])));
      }
    }
  }
  // small holdfast
  const foot = [];
  for (let k = 0; k < 5; k++) foot.push([((k + R.range(0.2, 0.8)) / 5 * 2 - 1) * 9, R.range(-8, -6), R.range(-3, 3), R.range(4.5, 6), 0.7]);
  blobs(g, cam, foot, 6, (x, y, z, nn, mm) => setGrey(mm, 0.8, 0.7));
  const img = g.resolve({ ao: [[1.5, 0.5], [5, 0.4]], shadow: [10, 0.4], gain: 1.15 });
  return def([part(img, cam.ox, cam.oy, sway(1.6 + 0.5 * v, 0.2 + 0.04 * v, R.range(0, 1)))]);
}

// ---------------------------------------------------------------------------- stony: table
/**
 * A table coral tier as an implicit solid: a stalk flaring into a thin dished plate with an
 * irregular outline. Local frame: origin at the stalk foot, y up. Returns helpers for placing
 * the fingers on the plate.
 */
function tableTier(R, P) {
  const N = 720;
  const ph = [R.range(0, TAU), R.range(0, TAU), R.range(0, TAU), R.range(0, TAU)];
  const ol = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU;
    ol[i] = P.R * (1 + 0.06 * Math.sin(2 * a + ph[0]) + 0.045 * Math.sin(3 * a + ph[1]) + 0.03 * Math.sin(5 * a + ph[2]) + 0.018 * Math.sin(9 * a + ph[3]) + 0.014 * Math.sin(17 * a + ph[0] * 3));
  }
  const outline = (ang) => {
    const f = ((ang / TAU + 1) % 1) * N;
    const i = Math.floor(f);
    return ol[i] + (ol[i + 1] - ol[i]) * (f - i);
  };
  const cr = Math.cos(P.roll);
  const sr = Math.sin(P.roll);
  const ct = Math.cos(P.tip ?? 0);
  const st = Math.sin(P.tip ?? 0);
  // world -> local: translate, roll about z, tip about x
  const toLocal = (x, y, z) => {
    const dx = x - P.x;
    const dy = y - P.y;
    const dz = z - P.z;
    const x1 = dx * cr + dy * sr;
    const y1 = -dx * sr + dy * cr;
    return [x1, y1 * ct + dz * st, -y1 * st + dz * ct];
  };
  const toWorld = (lx, ly, lz) => {
    const y1 = ly * ct - lz * st;
    const z1 = ly * st + lz * ct;
    return [P.x + lx * cr - y1 * sr, P.y + lx * sr + y1 * cr, P.z + z1];
  };
  const yb = P.h + P.dish - P.rim; // level where the body reaches the rim radius
  const topAt = (q, Ro) => P.h + P.dish * (q / Ro) * (q / Ro);
  const stalkR = (y) => P.rs * (1 + 0.5 * Math.exp(-Math.max(0, y + 3) / 8));
  const K = P.k ?? 3.2;
  const seed = Math.floor(R.range(0, 1000));
  const Rmax = P.R * 1.17;
  const yMax = P.h + P.dish * 1.37 + 1;
  /** fast: conservative stepping distance for the sphere tracer (the top is seen at a grazing angle). */
  const sdfLocal = (lx, ly, lz, fast) => {
    const q = Math.hypot(lx, lz);
    if (fast) {
      if (q - Rmax > 6) return q - Rmax;
      if (ly - yMax > 6) return ly - yMax;
    }
    const Ro = outline(Math.atan2(lz, lx));
    const u = clamp((ly - P.ya) / (yb - P.ya));
    const uk = Math.pow(u, K - 1);
    const rs = stalkR(ly);
    const rb = rs + (Ro - rs) * uk * u;
    const slope = ((Ro - rs) * K * uk) / (yb - P.ya);
    let d1 = q - rb;
    // lumpy stalk and underside
    if (d1 < 9 && u < 0.98) d1 -= (fbm3(lx * 0.09, ly * 0.09, lz * 0.09, 2, seed) - 0.5) * 7 * (1 - u * u);
    d1 /= Math.sqrt(1 + slope * slope);
    const d2 = ly - topAt(Math.min(q, Ro), Ro);
    if (fast && d2 > d1 && d2 > 0.1) return d2 * 2.6;
    return smax(smax(d1, d2, 3), -(ly + (P.foot ?? 13)), 3);
  };
  const sdf = (x, y, z) => {
    const l = toLocal(x, y, z);
    return sdfLocal(l[0], l[1], l[2], false);
  };
  const sdfFast = (x, y, z) => {
    const l = toLocal(x, y, z);
    return sdfLocal(l[0], l[1], l[2], true);
  };
  return { P, outline, toLocal, toWorld, topAt, sdf, sdfFast, yb };
}

function coralTable(id, v, ss) {
  const R = rng(hashStr(id));
  const tiers = [];
  if (v === 1) {
    tiers.push(tableTier(R, { x: 4, y: 0, z: 0, R: 128, rs: 19, h: 90, dish: 8, rim: 5, ya: 6, roll: -0.045, tip: 0.02 }));
  } else {
    // two tiers: a broad lower table and a smaller one growing above its shoulder
    tiers.push(tableTier(R, { x: -16, y: 0, z: 0, R: 110, rs: 18, h: 62, dish: 7, rim: 5, ya: 4, roll: 0.05, tip: 0.02 }));
    tiers.push(tableTier(R, { x: 56, y: 56, z: -30, R: 72, rs: 11, h: 46, dish: 6, rim: 4.5, ya: 2, roll: -0.09, tip: 0.03, foot: 6, k: 2.6 }));
  }
  const pitch = 0.135;
  const w = 324;
  const h = 164;
  const cam = camera(162, 142, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 11.5, 1.5, hashStr(id) & 255);
  const c = cam.c;
  const sn = cam.s;
  const m = grey(1);
  for (const T of tiers) {
    const P = T.P;
    const sdfV = (x, y, z) => T.sdf(x, y * c + z * sn, -y * sn + z * c);
    const stepFn = (x, y, z) => T.sdfFast(x, y * c + z * sn, -y * sn + z * c);
    const ext = P.R * 1.14;
    const p0 = cam.p(P.x, P.y, P.z);
    const cx = p0[0] - cam.ox;
    const cy = cam.oy - p0[1];
    const box = [cx - ext, cy - 16, cx + ext, cy + (P.h + P.dish + 6) * c + ext * sn + 4, p0[2] - ext, p0[2] + ext + P.h];
    g.march(cam, sdfV, box, (x, y, z, n, mm) => {
      const l = T.toLocal(x, y * c + z * sn, -y * sn + z * c);
      const q = Math.hypot(l[0], l[2]);
      const ang = Math.atan2(l[2], l[0]);
      const Ro = T.outline(ang);
      const rho = q / Ro;
      const yt = P.h + P.dish * rho * rho;
      const under = smoothstep(yt - 2.5, yt - 6, l[1]);
      // radial ribs and growth rings under the plate, mottling on the stalk
      const rib = Math.cos(ang * 40 + 2.5 * Math.sin(rho * 9));
      const ring = Math.cos(rho * 34 + 2 * fbm(ang * 3, rho * 4, 2, 11));
      let val = 0.8 + 0.09 * rib * smoothstep(0.2, 0.5, rho) * under + 0.04 * ring * under + 0.12 * (fbm3(x * 0.2, y * 0.2, z * 0.2, 2, 3) - 0.5);
      // pale growing margin
      val += 0.22 * smoothstep(0.88, 0.99, rho) * (1 - under * 0.5);
      const o = lerp(1, lerp(0.5, 0.92, smoothstep(0.2, 1, rho)), under) * lerp(0.66, 1, smoothstep(-6, 24, l[1]));
      setGrey(mm, val, o);
      // ribs as relief: tilt the normal around the axis
      const k = 0.38 * Math.sin(ang * 40 + 2.5 * Math.sin(rho * 9)) * smoothstep(0.15, 0.45, rho) * under;
      if (k !== 0) {
        n[0] += -Math.sin(ang) * k;
        n[2] += Math.cos(ang) * k * c;
        n[1] += -Math.cos(ang) * k * sn;
        const il = 1 / Math.hypot(n[0], n[1], n[2]);
        n[0] *= il;
        n[1] *= il;
        n[2] *= il;
      }
    }, { relax: 0.75, steps: 64, stepFn });
    // ragged growing margin: short branchlets pushing out of the rim
    for (let a0 = 0; a0 < TAU; a0 += R.range(2.6, 4.2) / P.R) {
      const Ro = T.outline(a0);
      const len = R.range(4, 9);
      const up = R.range(-0.1, 0.45);
      const ca = Math.cos(a0);
      const sa = Math.sin(a0);
      const y0 = T.topAt(Ro, Ro) - R.range(1.5, 4);
      const a = T.toWorld(ca * (Ro - 4), y0, sa * (Ro - 4));
      const bq = T.toWorld(ca * (Ro + len), y0 + up * len, sa * (Ro + len));
      const r0 = R.range(1.8, 2.5);
      g.tube(cam, [[a[0], a[1], a[2], r0], [bq[0], bq[1], bq[2], r0 * 0.7]], (t) => setGrey(m, lerp(0.86, 1.08, t), 0.95));
    }
    // fingers: jittered hex lattice over the plate
    const sp = P.R > 100 ? 6.1 : 5.4;
    for (let j = -Math.ceil(ext / (sp * 0.866)); j * sp * 0.866 < ext; j++)
      for (let i = -Math.ceil(ext / sp); i * sp < ext; i++) {
        const lx = (i + (j & 1) * 0.5) * sp + R.range(-1.6, 1.6);
        const lz = j * sp * 0.866 + R.range(-1.6, 1.6);
        const q = Math.hypot(lx, lz);
        const ang = Math.atan2(lz, lx);
        const Ro = T.outline(ang);
        const rho = q / Ro;
        if (rho > 0.975) continue;
        const ly = T.topAt(q, Ro) - 1.5;
        const edge = smoothstep(0.8, 0.975, rho);
        const patch = fbm(lx * 0.035 + 7, lz * 0.035, 2, 5);
        const len = lerp(R.range(7, 11.5) * (0.7 + 0.6 * patch), R.range(3, 5), edge) * (R.chance(0.07) ? 1.4 : 1);
        const lean = 0.12 + 0.75 * rho * rho;
        const dl = norm3([(lx / (q || 1)) * lean + R.range(-0.28, 0.28), 1, (lz / (q || 1)) * lean + R.range(-0.28, 0.28)]);
        const a = T.toWorld(lx, ly, lz);
        const bq = T.toWorld(lx + dl[0] * len, ly + dl[1] * len, lz + dl[2] * len);
        const r0 = R.range(2.1, 2.9) * lerp(1, 0.75, edge);
        const tone0 = lerp(0.84, 1, rho) * (0.9 + 0.2 * patch) * R.range(0.94, 1.04) + 0.14 * edge;
        g.tube(cam, [[a[0], a[1], a[2], r0], [bq[0], bq[1], bq[2], r0 * 0.62]], (t) => setGrey(m, lerp(0.6, 1.02, t * t) * tone0, lerp(0.45, 1, t)));
      }
  }
  const img = g.resolve({ ao: [[1.8, 0.7], [5, 0.6], [18, 0.5]], shadow: [60, 0.85, 0.5], gain: 1.12 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- gorgonian sea fans
/**
 * Grow a planar branching net by space colonisation: twigs race toward attractor points scattered
 * inside the fan outline, then free tips are tied to neighbouring twigs so the branches close
 * into the lacy mesh of a sea fan. Returns chains ([x, y, r] polylines) and cross links.
 */
function fanNet(R, P) {
  const { inside, sp, stem } = P;
  const D = 2.0;
  const di = sp * 3;
  const dk = sp * (P.kill ?? 0.42);
  // attractors: jittered hex lattice inside the outline
  const A = [];
  for (let j = 0; j * sp * 0.866 < P.h + 10; j++)
    for (let i = -Math.ceil(P.w / sp); i * sp < P.w; i++) {
      const x = (i + (j & 1) * 0.5) * sp + R.range(-0.42, 0.42) * sp;
      const y = j * sp * 0.866 + R.range(-0.42, 0.42) * sp;
      if (inside(x, y)) A.push([x, y, 1]);
    }
  const nodes = []; // [x, y, parent]
  const cell = di;
  const grid = new Map();
  const key = (x, y) => Math.floor(x / cell) * 4096 + Math.floor(y / cell);
  const addNode = (x, y, parent) => {
    nodes.push([x, y, parent, 0, 0, 0]);
    const k = key(x, y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(nodes.length - 1);
    return nodes.length - 1;
  };
  let last = -1;
  for (let y = -10; y <= stem; y += D) last = addNode(P.stemX ? P.stemX(y) : 0, y, last);
  const nearest = (x, y, maxD) => {
    let best = -1;
    let bd = maxD * maxD;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const arr = grid.get((cx + i) * 4096 + cy + j);
        if (!arr) continue;
        for (const q of arr) {
          const dx = nodes[q][0] - x;
          const dy = nodes[q][1] - y;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = q;
          }
        }
      }
    return best;
  };
  for (let iter = 0; iter < 500; iter++) {
    const pull = new Map();
    let alive = 0;
    for (const a of A) {
      if (!a[2]) continue;
      alive++;
      const q = nearest(a[0], a[1], di);
      if (q < 0) continue;
      const n = nodes[q];
      const dx = a[0] - n[0];
      const dy = a[1] - n[1];
      const l = Math.hypot(dx, dy) || 1;
      let e = pull.get(q);
      if (!e) pull.set(q, (e = [0, 0, 1e9, 0, 0]));
      e[0] += dx / l;
      e[1] += dy / l;
      if (l < e[2]) {
        e[2] = l;
        e[3] = dx / l;
        e[4] = dy / l;
      }
    }
    if (!alive || !pull.size) break;
    let grown = 0;
    for (const [q, e] of pull) {
      const n = nodes[q];
      // bias growth away from the holdfast so branches keep radiating
      const rx = n[0];
      const ry = n[1] - stem * 0.4;
      const rl = Math.hypot(rx, ry) || 1;
      let dx = e[0] + (rx / rl) * 0.2 + R.range(-0.05, 0.05);
      let dy = e[1] + (ry / rl) * 0.2 + R.range(-0.05, 0.05);
      let l = Math.hypot(dx, dy);
      let nx = n[0] + (dx / (l || 1)) * D;
      let ny = n[1] + (dy / (l || 1)) * D;
      if (l < 0.3 || nearest(nx, ny, D * 0.6) >= 0) {
        // pulls cancel out or the way is taken: head for the closest attractor instead
        nx = n[0] + e[3] * D;
        ny = n[1] + e[4] * D;
        if (nearest(nx, ny, D * 0.6) >= 0) continue;
      }
      addNode(nx, ny, q);
      grown++;
    }
    for (const a of A) if (a[2] && nearest(a[0], a[1], dk) >= 0) a[2] = 0;
    if (!grown) break;
  }
  // cross links: tie free tips and stretches of thin twig to a neighbouring twig of another
  // lineage, so the branches close into elongated mesh cells
  const dead = new Uint8Array(nodes.length);
  let kids = nodes.map(() => []);
  for (let i = 1; i < nodes.length; i++) kids[nodes[i][2]].push(i);
  const links = [];
  const lgrid = new Map();
  const lcell = sp * 1.5;
  // two nodes are related when their paths to the root meet within n steps (same twig family)
  const anc = new Set();
  const collect = (i, n) => {
    anc.clear();
    let c = i;
    for (let k = 0; k < n && c >= 0; k++) {
      anc.add(c);
      c = nodes[c][2];
    }
  };
  const related = (j, n) => {
    let c = j;
    for (let k = 0; k < n && c >= 0; k++) {
      if (anc.has(c)) return true;
      c = nodes[c][2];
    }
    return false;
  };
  const tryLink = (i, maxD, minGap) => {
    const n = nodes[i];
    let best = -1;
    let bd = maxD * maxD;
    const cx = Math.floor(n[0] / cell);
    const cy = Math.floor(n[1] / cell);
    collect(i, 10);
    for (let j = -1; j <= 1; j++)
      for (let ii = -1; ii <= 1; ii++) {
        const arr = grid.get((cx + ii) * 4096 + cy + j);
        if (!arr) continue;
        for (const q of arr) {
          if (dead[q] || q === i) continue;
          const dx = nodes[q][0] - n[0];
          const dy = nodes[q][1] - n[1];
          const d = dx * dx + dy * dy;
          if (d >= bd || d < 3) continue;
          if (related(q, 10)) continue;
          bd = d;
          best = q;
        }
      }
    if (best < 0) return false;
    const mx = (n[0] + nodes[best][0]) / 2;
    const my = (n[1] + nodes[best][1]) / 2;
    const gx = Math.floor(mx / lcell);
    const gy = Math.floor(my / lcell);
    for (let j = -1; j <= 1; j++)
      for (let ii = -1; ii <= 1; ii++) {
        const arr = lgrid.get((gx + ii) * 4096 + gy + j);
        if (arr) for (const q of arr) if (Math.hypot(q[0] - mx, q[1] - my) < minGap) return false;
      }
    const k = gx * 4096 + gy;
    if (!lgrid.has(k)) lgrid.set(k, []);
    lgrid.get(k).push([mx, my]);
    links.push([i, best]);
    return true;
  };
  // tips first; short spurs that find no partner are thorns and get pruned
  for (let i = nodes.length - 1; i > 0; i--) {
    if (kids[i].length) continue;
    if (tryLink(i, sp * (P.linkTip ?? 1.9), sp * 0.45)) continue;
    const run = [];
    let c = i;
    while (c > 0 && kids[c].length <= (c === i ? 0 : 1) && run.length < 3) {
      run.push(c);
      c = nodes[c][2];
    }
    if (run.length < 3) for (const q of run) dead[q] = 1;
  }
  kids = nodes.map(() => []);
  for (let i = 1; i < nodes.length; i++) if (!dead[i]) kids[nodes[i][2]].push(i);
  // subtree weight (number of tips) -> radius
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (dead[i]) continue;
    const n = nodes[i];
    if (!kids[i].length) n[3] = 1;
    if (n[2] >= 0) nodes[n[2]][3] += n[3];
  }
  for (const n of nodes) n[4] = Math.min(P.rMax ?? 3.6, P.rTip * Math.pow(Math.max(1, n[3]), P.pow ?? 0.22));
  // chains follow the heaviest child; others start new chains
  const chains = [];
  const pending = [[-1, 0]];
  while (pending.length) {
    const [from, first] = pending.pop();
    const ch = from >= 0 ? [from] : [];
    let c = first;
    for (;;) {
      ch.push(c);
      const ks = kids[c];
      if (!ks.length) break;
      let best = ks[0];
      for (const k of ks) if (nodes[k][3] > nodes[best][3]) best = k;
      for (const k of ks) if (k !== best) pending.push([c, k]);
      c = best;
    }
    chains.push(ch);
  }
  const order = [];
  for (let i = 0; i < nodes.length; i++) if (!dead[i] && kids[i].length && nodes[i][3] <= (P.linkW ?? 9)) order.push(i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(R() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const i of order) if (R.chance(P.linkMid ?? 0.5)) tryLink(i, sp * (P.linkReach ?? 1.5), sp * (P.linkGap ?? 1.15));
  return { nodes, chains, links };
}

/** Laplacian smoothing of a polyline's interior points. */
function smoothLine(pts, passes = 2, k = 0.5) {
  for (let p = 0; p < passes; p++)
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i][0] += ((pts[i - 1][0] + pts[i + 1][0]) / 2 - pts[i][0]) * k;
      pts[i][1] += ((pts[i - 1][1] + pts[i + 1][1]) / 2 - pts[i][1]) * k;
    }
  return pts;
}

const FANS = [
  // broad rounded fan
  { w: 152, h: 198, stem: 16, sp: 3.7, rTip: 0.8, pow: 0.23, lean: 0.0, wedge: 0.92, n: 2.5, cy: 0.56, scallop: 0.07, lobes: [], linkMid: 0.6 },
  // leaning fan cleft into two unequal lobes
  { w: 142, h: 198, stem: 20, sp: 4.0, rTip: 0.84, pow: 0.24, lean: 0.24, wedge: 0.86, n: 2.3, cy: 0.58, scallop: 0.09, lobes: [[-0.12, 0.5, 0.2, 0.84]], linkMid: 0.55 },
  // tall ragged fan with three fingers and a more open mesh
  { w: 148, h: 198, stem: 14, sp: 4.7, rTip: 0.92, pow: 0.24, lean: -0.1, wedge: 0.98, n: 2.1, cy: 0.52, scallop: 0.16, lobes: [[-0.36, 0.42, 0.16, 0.8], [0.3, 0.5, 0.17, 1]], linkMid: 0.4, linkReach: 1.3 },
];

function coralFan(id, v, ss) {
  const R = rng(hashStr(id));
  const P = { ...FANS[v - 1] };
  const seed = hashStr(id) & 1023;
  const a = P.w / 2;
  const y0 = P.stem * 0.6;
  const cy = P.h * P.cy;
  const bUp = P.h - cy;
  const bDn = cy - y0;
  // outline: a wedge radiating from the holdfast, closed by a rounded, scalloped top; `lobes`
  // cut V-shaped clefts [angle, start radius 0..1, width, height factor of the lobe left of it]
  P.inside = (x, y) => {
    const dy = y - y0;
    if (dy <= 0.5) return false;
    const xs = x - P.lean * a * (y / P.h) * (y / P.h) * 1.3;
    const th = Math.atan2(xs, dy);
    const edge = (fbm(th * 4 + 20, seed * 0.37, 3, seed) - 0.5) * 2;
    if (Math.abs(th) > P.wedge * (1 + 0.1 * edge)) return false;
    let lim = 1 + P.scallop * (edge + 0.5 * Math.sin(th * 13 + seed));
    const r = Math.hypot(xs, dy) / P.h;
    for (const [la, lr, lw, lh] of P.lobes) {
      if (th < la) lim *= lh;
      if (r > lr && Math.abs(th - la) < lw * (r - lr) * 1.6) return false;
    }
    const ex = Math.abs(xs) / a;
    const ey = Math.abs(y - cy) / (y > cy ? bUp : bDn * 1.25);
    return Math.pow(ex, P.n) + Math.pow(ey, P.n) < Math.pow(lim, P.n);
  };
  const net = fanNet(R, P);
  const pad = 8;
  const w = P.w + 70;
  const h = P.h + pad + 22;
  const cam = camera(Math.round(w / 2), P.h + pad + 4, 0);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, seed);
  const m = grey(1);
  // gentle warp of the sheet in depth, and a value field: paler toward the growing margin
  const zAt = (x, y) => 9 * Math.sin(x * 0.035 + seed) * Math.cos(y * 0.021 + seed * 0.7) + 5 * Math.sin(y * 0.05 + x * 0.02);
  const wave = (x, y) => 0.5 + 0.5 * Math.sin(x * 0.035 + seed + 1.2) * Math.cos(y * 0.021 + seed * 0.7);
  const valAt = (x, y, r) => {
    const hgt = clamp(y / P.h);
    return (0.76 + 0.2 * hgt + 0.1 * wave(x, y)) * lerp(1, 0.84, smoothstep(1.2, 3, r));
  };
  for (const ch of net.chains) {
    if (ch.length < 2) continue;
    const pl = smoothLine(ch.map((i) => [net.nodes[i][0], net.nodes[i][1], net.nodes[i][4]]), 3);
    const pts = pl.map((q) => [q[0], q[1], zAt(q[0], q[1]) + q[2], q[2]]);
    g.tube(cam, pts, (t) => {
      const q = pts[Math.min(pts.length - 1, Math.round(t * (pts.length - 1)))];
      return setGrey(m, valAt(q[0], q[1], q[3]), lerp(0.7, 1, smoothstep(-4, 44, q[1])));
    });
    // polyps: tiny pale knobs alternating along both sides of every twig
    let flip = R.chance(0.5) ? 1 : -1;
    for (let i = 2; i < pts.length - 1; i += 2) {
      const q = pts[i];
      if (q[1] < 16) continue;
      const dx = pts[i + 1][0] - pts[i - 1][0];
      const dy = pts[i + 1][1] - pts[i - 1][1];
      const l = Math.hypot(dx, dy) || 1;
      flip = -flip;
      const rb = R.range(0.62, 0.9);
      const off = q[3] + rb * 0.15;
      g.ball(cam, q[0] - (dy / l) * off * flip, q[1] + (dx / l) * off * flip, q[2] + 0.3, rb, setGrey(m, valAt(q[0], q[1], 0) + 0.14, 1));
    }
  }
  for (const [ia, ib] of net.links) {
    const na = net.nodes[ia];
    const nb = net.nodes[ib];
    const r = P.rTip * 0.9;
    g.tube(cam, [[na[0], na[1], zAt(na[0], na[1]) + r, r], [nb[0], nb[1], zAt(nb[0], nb[1]) + r, r]], setGrey(m, valAt(na[0], na[1], r), 1));
  }
  // holdfast: the stem flares into a small encrusting foot
  const sr = net.nodes[0][4];
  g.tube(cam, [[0, -12, 0, sr * 2.6], [0, -5, 0, sr * 2.0], [0, 3, zAt(0, 3), sr * 1.25], [0, 12, zAt(0, 12) + sr, sr]], (t) => setGrey(m, 0.78, lerp(0.62, 0.8, t)));
  const foot = [];
  for (let k = 0; k < 6; k++) foot.push([((k + R.range(0.2, 0.8)) / 6 * 2 - 1) * 11, R.range(-8, -6), R.range(-3, 3), R.range(5, 7), 0.7]);
  blobs(g, cam, foot, 7, (x, y, z, n, mm) => setGrey(mm, 0.76, 0.66), { noise: 1.5, freq: 0.25, seed });
  const img = g.resolve({ ao: [[1.6, 0.5], [5, 0.35]], shadow: [10, 0.4], gain: 1.1 });
  return def([part(img, cam.ox, cam.oy, sway(1.8 + 0.3 * v, 0.2 + 0.03 * v, R.range(0, 1)))]);
}

// ---------------------------------------------------------------------------- soft tree corals
const SOFT = [
  // upright tree with a rounded crown
  { trunk: 38, tr0: 11.5, lean: 0.05, limbs: 6, spread: 1.42, limbLen: [44, 60], twigs: [3, 5], twin: 0 },
  // lopsided: a long leaning trunk, one limb drooping away
  { trunk: 50, tr0: 10.5, lean: -0.34, limbs: 5, spread: 1.3, limbLen: [40, 60], twigs: [3, 4], twin: 0, droop: 1 },
  // low and wide: twin trunks from one base, many small florets
  { trunk: 26, tr0: 10, lean: 0.36, limbs: 4, spread: 1.3, limbLen: [34, 50], twigs: [3, 4], twin: 1 },
];
/** Fleshy irregular girth: slow bulges plus fine transverse wrinkles. */
function fleshy(R, br, bulge = 0.14, wrinkle = 0.035) {
  const s0 = R.range(0, 100);
  const n = br.pts.length;
  for (let i = 0; i < n; i++) {
    const q = br.pts[i];
    q[3] *= 1 + bulge * (vnoise(i * 0.16 + s0, 1.5, 3) - 0.5) * 2 + wrinkle * Math.sin(i * 1.9 + s0);
  }
  return br;
}
function softSkeleton(R, P) {
  const limbs = [];
  const florets = [];
  const addFloret = (pt, dir, rad, group) => florets.push({ c: [pt[0] + dir[0] * rad * 0.5, pt[1] + dir[1] * rad * 0.5, pt[2] + dir[2] * rad * 0.5], dir, rad, group });
  const tree = (bx, lean, scale, gflip) => {
    const trunk = fleshy(R, growBranch(R, [bx, -6, 0], norm3([Math.sin(lean), Math.cos(lean), 0]), P.tr0 * scale, P.trunk * scale, { tropism: 0.3, bend: 0.35, taper: 0.74, taperPow: 0.8 }), 0.12, 0.04);
    trunk.kind = 'trunk';
    trunk.group = 0;
    // the trunk swells where it grips the rock
    for (const q of trunk.pts) q[3] *= 1 + 0.42 * Math.exp(-Math.max(0, q[1] + 6) / 7);
    limbs.push(trunk);
    const n = trunk.pts.length - 1;
    for (let k = 0; k < P.limbs; k++) {
      const f = P.limbs === 1 ? 0.5 : k / (P.limbs - 1);
      const out = Math.abs(f * 2 - 1);
      let a = (f * 2 - 1) * P.spread + lean * 0.5 + R.range(-0.1, 0.1);
      const zt = (k % 2 ? 1 : -1) * R.range(0.3, 0.65) * (gflip ? -1 : 1);
      const group = zt > 0 ? 1 : 0;
      // outer limbs leave the trunk lower down and sweep upward
      const at = trunk.pts[Math.round(n * clamp(1 - 0.3 * out * out + R.range(-0.05, 0.03), 0.6, 1))];
      const droop = P.droop && k === P.limbs - 1;
      if (droop) a = 1.05;
      const d = norm3([Math.sin(a), Math.cos(a) * 0.9 + 0.1, zt]);
      const len = R.range(P.limbLen[0], P.limbLen[1]) * scale * (droop ? 1.2 : 1) * (1 - 0.12 * out);
      // a drooping limb arches out and sags under its own weight
      const limb = fleshy(R, growBranch(R, at, d, at[3] * (droop ? 0.46 : 0.54), len, { tropism: droop ? -1.5 : 0.6 + 0.9 * out, bend: 0.5, taper: 0.62 }), 0.12, 0.03);
      limb.kind = 'limb';
      limb.group = group;
      limbs.push(limb);
      const ln = limb.pts.length - 1;
      addFloret(limb.pts[ln], dirAt(limb.pts, ln), R.range(8.5, 10.5) * scale, group);
      const nt = R.int(P.twigs[0], P.twigs[1]);
      let side = R.chance(0.5) ? 1 : -1;
      for (let j = 0; j < nt; j++) {
        const t0 = clamp(0.22 + ((j + R.range(0.2, 0.8)) / nt) * 0.7, 0.2, 0.93);
        const i = Math.round(t0 * ln);
        const q = limb.pts[i];
        const pd = dirAt(limb.pts, i);
        let axis = norm3([R.range(-0.7, 0.7), R.range(-0.7, 0.7), side]);
        axis = norm3(vsub(axis, vscale(pd, vdot(axis, pd))));
        side = -side;
        const cd = rotAbout(pd, axis, R.range(0.6, 1.15));
        const tl = len * R.range(0.24, 0.42) * (1 - t0 * 0.3);
        const twig = growBranch(R, q, cd, q[3] * 0.74, tl, { tropism: 0.7, bend: 0.5, taper: 0.7 });
        twig.kind = 'twig';
        twig.group = group;
        limbs.push(twig);
        const tn = twig.pts.length - 1;
        addFloret(twig.pts[tn], dirAt(twig.pts, tn), R.range(7, 9.5) * scale, group);
        // one or two side bundles on short stalks
        const ns = tl > 13 ? R.int(1, 2) : R.int(0, 1);
        for (let e = 0; e < ns; e++) {
          const mi = Math.round(tn * R.range(0.3, 0.75));
          const td = dirAt(twig.pts, mi);
          const md = norm3(vadd(vscale(rotAbout(td, randPerp(td, R), R.range(0.8, 1.3)), 1), [0, 0.3, 0]));
          const st = growBranch(R, twig.pts[mi], md, twig.pts[mi][3] * 0.75, R.range(5, 8), { tropism: 0.5, bend: 0.3, taper: 0.8 });
          st.kind = 'twig';
          st.group = group;
          limbs.push(st);
          addFloret(st.pts[st.pts.length - 1], md, R.range(5.5, 7.5) * scale, group);
        }
      }
    }
    return trunk;
  };
  const roots = [];
  if (P.twin) {
    roots.push(tree(-12, -P.lean, 1, false));
    roots.push(tree(13, P.lean + 0.2, 0.86, true));
  } else roots.push(tree(0, P.lean, 1, false));
  return { limbs, florets, roots };
}

/** A fluffy polyp bundle: a shaded core studded with small polyps, each with a crown of tentacle tips. */
function floret(g, cam, R, fl, occ, m) {
  const { c, dir, rad } = fl;
  g.ball(cam, c[0], c[1], c[2], rad * 0.7, setGrey(m, 0.72, occ * 0.72));
  const n = Math.round(rad * rad * 0.42);
  const off = R.range(0, 1);
  for (let k = 0; k < n; k++) {
    // Fibonacci sphere, skipping the side that faces back down the branch
    const yy = 1 - (2 * (k + 0.5)) / n;
    const rr = Math.sqrt(1 - yy * yy);
    const ph = (k + off) * 2.399963;
    const d = [rr * Math.cos(ph), yy, rr * Math.sin(ph)];
    if (vdot(d, dir) < -0.55) continue;
    const dv = cam.d(d);
    if (dv[2] < -0.45) continue;
    const jit = R.range(0.86, 1.12);
    const pr = R.range(1.75, 2.5);
    const px = c[0] + d[0] * rad * jit;
    const py = c[1] + d[1] * rad * jit;
    const pz = c[2] + d[2] * rad * jit;
    const v = R.range(0.84, 0.96);
    // stalk
    g.ball(cam, c[0] + d[0] * rad * 0.7, c[1] + d[1] * rad * 0.7, c[2] + d[2] * rad * 0.7, pr * 0.9, setGrey(m, 0.76, occ * 0.82));
    g.ball(cam, px, py, pz, pr, setGrey(m, v, occ));
    // tentacle tips
    const u = norm3(vcross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const w = vcross(d, u);
    const nt = 5;
    const a0 = R.range(0, TAU);
    for (let j = 0; j < nt; j++) {
      const a = a0 + (j / nt) * TAU;
      const e = [d[0] * 0.75 + (u[0] * Math.cos(a) + w[0] * Math.sin(a)) * 0.85, d[1] * 0.75 + (u[1] * Math.cos(a) + w[1] * Math.sin(a)) * 0.85, d[2] * 0.75 + (u[2] * Math.cos(a) + w[2] * Math.sin(a)) * 0.85];
      g.ball(cam, px + e[0] * pr, py + e[1] * pr, pz + e[2] * pr, pr * 0.42, setGrey(m, 1.06, occ));
    }
  }
}

function coralSoft(id, v, ss) {
  const R = rng(hashStr(id));
  const P = SOFT[v - 1];
  const sk = softSkeleton(R, P);
  // fit: florets count toward the bounds
  const all = sk.limbs.concat(sk.florets.map((f) => ({ pts: [[f.c[0], f.c[1], f.c[2], f.rad + 2.5]] })));
  const b0 = skelBounds(all);
  const sc = Math.min((1.2 * UNIT - 4) / (b0.x1 - b0.x0), (1.1 * UNIT - 2) / b0.y1);
  for (const l of sk.limbs) for (const q of l.pts) for (let k = 0; k < 4; k++) q[k] *= sc;
  for (const f of sk.florets) {
    f.c = vscale(f.c, sc);
    f.rad *= Math.sqrt(sc);
  }
  const b = skelBounds(sk.limbs.concat(sk.florets.map((f) => ({ pts: [[f.c[0], f.c[1], f.c[2], f.rad + 3.5]] }))));
  const pad = 8;
  const w = Math.ceil(b.x1 - b.x0) + pad * 2;
  const h = Math.ceil(b.y1) + pad + 26;
  const cam = camera(Math.round(-b.x0) + pad, Math.ceil(b.y1) + pad, 0.1);
  const top = b.y1;
  const occAt = (y) => lerp(0.66, 1, smoothstep(-8, top * 0.5, y));
  const m = grey(1);
  const layers = [];
  for (let grp = 0; grp < 2; grp++) {
    const g = new GBuf(w, h, ss);
    g.foot(cam.oy, 11.5, 1.5, hashStr(id) & 255);
    const RR = rng(hashStr(id) + 77 + grp);
    for (const l of sk.limbs) {
      if (l.group !== grp) {
        // the trunk still hides the roots of the front limbs: draw it as a hold-out
        if (grp === 1 && l.kind === 'trunk') {
          m.a = 0;
          g.tube(cam, l.pts, setGrey(m, 0.8, 1));
          m.a = 1;
        }
        continue;
      }
      const trunk = l.kind === 'trunk';
      const y0 = l.pts[0][1];
      const y1 = l.pts[l.pts.length - 1][1];
      m.tr = trunk ? 0.9 : 0.6;
      g.tube(cam, l.pts, (t) => setGrey(m, trunk ? 0.8 : 0.8, occAt(lerp(y0, y1, t))));
      // sclerites: pale needle-like streaks lying in the tissue
      const n = l.pts.length;
      const cnt = Math.round(l.len * (trunk ? 3.2 : l.kind === 'limb' ? 1.4 : 0.5));
      for (let k = 0; k < cnt; k++) {
        const i = Math.min(n - 3, Math.floor(RR.range(0.03, 0.95) * (n - 1)));
        const q = l.pts[i];
        const T = dirAt(l.pts, i);
        const nr = randPerp(T, RR);
        if (cam.d(nr)[2] < 0.05) continue;
        const sl = RR.range(3, 7) * (trunk ? 1 : 0.7);
        const sr = RR.range(0.36, 0.55);
        const off = q[3] - sr * 0.45;
        const tw = RR.range(-0.25, 0.25);
        const sd = norm3(vadd(T, vscale(vcross(T, nr), tw)));
        const a = vadd(q, vscale(nr, off));
        const e = vadd(a, vscale(sd, sl));
        m.tr = 0.5;
        g.tube(cam, [[a[0], a[1], a[2], sr], [e[0], e[1], e[2], sr]], setGrey(m, 1.2, occAt(a[1])));
      }
    }
    m.tr = 0;
    for (const fl of sk.florets) if (fl.group === grp) floret(g, cam, RR, fl, occAt(fl.c[1]), m);
    layers.push(g.resolve({ ao: [[1.8, 0.55], [5, 0.5], [13, 0.45]], shadow: [26, 0.5], depth: [b.z0, b.z1, 0.8, 0.1, 0.86], gain: 1.3 }));
  }
  // the front group throws a soft shadow on the back group
  const shadow = blur(layers[1], 3.5);
  const back = layers[0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sy = Math.max(0, y - 3);
      const k = 1 - 0.3 * shadow.d[(sy * w + x) * 4 + 3];
      const i = (y * w + x) * 4;
      back.d[i] *= k;
      back.d[i + 1] *= k;
      back.d[i + 2] *= k;
    }
  const ph = R.range(0, 1);
  return def([part(back, cam.ox, cam.oy, sway(2.2, 0.22, ph)), part(layers[1], cam.ox, cam.oy, sway(3, 0.22, ph + 0.18))]);
}

// ---------------------------------------------------------------------------- ribbon painter
/**
 * Painter's-algorithm layer for thin overlapping ribbons (grass blades, leaves, fronds), which
 * need real partial alpha and so cannot share a depth buffer. Ribbons are stamped back to front;
 * each one first lays a soft contact shadow on whatever is already underneath.
 */
class Paint {
  constructor(w, h, ss) {
    this.w = w;
    this.h = h;
    this.ss = ss;
    this.W = w * ss;
    this.H = h * ss;
    this.d = new Float32Array(this.W * this.H * 4);
    this.mark = new Int32Array(this.W * this.H);
    this.id = 0;
  }

  /**
   * path: [{ x, y (canvas px), hw (projected half width px), ...user data }]. shadeFn(p0, p1, f,
   * u, out) gets the two neighbouring path points, the blend f between them and the lateral
   * coordinate u in -1..1 and writes straight-alpha linear rgba. o.shadow: [extra px, strength].
   */
  ribbon(path, shadeFn, o = {}) {
    const { W, H, ss, d, mark } = this;
    const out = [0, 0, 0, 0];
    const [sw, sk] = o.shadow ?? [3.5, 0.3];
    const sox = (o.shadowOff ?? [1.2, 2.2])[0] * ss;
    const soy = (o.shadowOff ?? [1.2, 2.2])[1] * ss;
    for (let pass = sk > 0 ? 0 : 1; pass < 2; pass++) {
      const id = ++this.id;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        const dx = (b.x - a.x) * ss;
        const dy = (b.y - a.y) * ss;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const nx = -dy / len;
        const ny = dx / len;
        const steps = Math.max(1, Math.ceil(len / 0.5));
        for (let k = 0; k < steps; k++) {
          const f = (k + 0.5) / steps;
          const cx = (a.x + (b.x - a.x) * f) * ss + (pass ? 0 : sox);
          const cy = (a.y + (b.y - a.y) * f) * ss + (pass ? 0 : soy);
          const hw = (a.hw + (b.hw - a.hw) * f) * ss;
          const ext = pass ? hw : hw + sw * ss;
          if (ext <= 0.2) continue;
          for (let q = -ext; q <= ext; q += 0.5) {
            const X = Math.floor(cx + nx * q);
            const Y = Math.floor(cy + ny * q);
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const idx = Y * W + X;
            if (mark[idx] === id) continue;
            mark[idx] = id;
            const j = idx * 4;
            if (!pass) {
              if (d[j + 3] <= 0) continue;
              const fall = 1 - smoothstep(hw * 0.6, ext, Math.abs(q));
              const m = 1 - sk * fall;
              d[j] *= m;
              d[j + 1] *= m;
              d[j + 2] *= m;
              continue;
            }
            shadeFn(a, b, f, q / hw, out);
            const al = out[3];
            if (al <= 0) continue;
            const inv = 1 - al;
            d[j] = out[0] * al + d[j] * inv;
            d[j + 1] = out[1] * al + d[j + 1] * inv;
            d[j + 2] = out[2] * al + d[j + 2] * inv;
            d[j + 3] = al + d[j + 3] * inv;
          }
        }
      }
    }
  }

  /** Disc with a spherical normal (bubbles, berries, buds). shadeFn(nx, ny, nz, out). */
  disc(cx, cy, r, shadeFn, o = {}) {
    const { W, H, ss, d } = this;
    const out = [0, 0, 0, 0];
    const X = cx * ss;
    const Y = cy * ss;
    const R = r * ss;
    const [sw, sk] = o.shadow ?? [2.5, 0.3];
    const E = R + sw * ss;
    for (let py = Math.max(0, Math.floor(Y - E)); py <= Math.min(H - 1, Math.ceil(Y + E + 2 * ss)); py++)
      for (let px = Math.max(0, Math.floor(X - E)); px <= Math.min(W - 1, Math.ceil(X + E + ss)); px++) {
        const dx = px + 0.5 - X;
        const dy = py + 0.5 - Y;
        const dd = Math.hypot(dx, dy);
        const j = (py * W + px) * 4;
        if (dd >= R) {
          // contact shadow, shifted away from the light
          const ds = Math.hypot(dx - 0.8 * ss, dy - 1.6 * ss);
          if (sk > 0 && ds < E && d[j + 3] > 0) {
            const m = 1 - sk * (1 - smoothstep(R * 0.7, E, ds));
            d[j] *= m;
            d[j + 1] *= m;
            d[j + 2] *= m;
          }
          continue;
        }
        shadeFn(dx / R, -dy / R, Math.sqrt(Math.max(0, 1 - (dd * dd) / (R * R))), out);
        const al = out[3];
        const inv = 1 - al;
        d[j] = out[0] * al + d[j] * inv;
        d[j + 1] = out[1] * al + d[j + 1] * inv;
        d[j + 2] = out[2] * al + d[j + 2] * inv;
        d[j + 3] = al + d[j + 3] * inv;
      }
  }

  resolve() {
    const { W, H, ss, d } = this;
    const img = new Img(this.w, this.h);
    const inv = 1 / (ss * ss);
    for (let py = 0; py < H; py++) {
      const orow = Math.floor(py / ss) * this.w;
      for (let px = 0; px < W; px++) {
        const j = (py * W + px) * 4;
        if (d[j + 3] <= 0) continue;
        const q = (orow + Math.floor(px / ss)) * 4;
        img.d[q] += d[j] * inv;
        img.d[q + 1] += d[j + 1] * inv;
        img.d[q + 2] += d[j + 2] * inv;
        img.d[q + 3] += d[j + 3] * inv;
      }
    }
    return img;
  }
}

/** Shade a point of a tintable thin blade with the shared rig (matte, slightly translucent). */
function litBlade(v, n, ao, gain = 1, gloss = 0.1, sheen = 0.16) {
  // thin tissue: wrap the light a little so faces turned from the key do not go dead
  const nn = norm3([n[0] * 0.8, n[1] * 0.8 + 0.12, n[2] + 0.25]);
  const c = lit([N0[0] * v, N0[1] * v, N0[2] * v], nn, gloss, sheen, ao);
  const fres = Math.pow(1 - clamp(nn[2]), 2.6) * (0.1 + 0.3 * clamp(nn[1] * 0.5 + 0.5)) * ao * 0.8;
  return gradeTint([Math.max(0, c[0] - RIM[0] * fres), Math.max(0, c[1] - RIM[1] * fres), Math.max(0, c[2] - RIM[2] * fres)], gain);
}

// ---------------------------------------------------------------------------- seagrass
const GRASS = [
  // balanced fountain
  { n: 11, lean: 0.0, spread: 0.4, len: [170, 330], hw: [5.4, 7.6], droop: [0.25, 0.9], base: 15, twist: 0.4, w: 296 },
  // dense, swept to the right by the current
  { n: 14, lean: 0.2, spread: 0.34, len: [160, 330], hw: [5.0, 7.2], droop: [0.3, 0.9], base: 18, twist: 0.5, sweep: 1, w: 300 },
  // sparse, tall and nearly upright
  { n: 8, lean: -0.08, spread: 0.2, len: [210, 330], hw: [4.6, 6.2], droop: [0.1, 0.5], base: 11, twist: 0.6, w: 220 },
  // wide low splay with a few tall blades
  { n: 12, lean: -0.14, spread: 0.6, len: [130, 320], hw: [5.6, 8.0], droop: [0.4, 1.15], base: 17, twist: 0.35, low: 1, w: 304 },
];
/** Build one blade: a ribbon path with a frame for lighting. Model space: y up from the ground. */
function grassBlade(R, P, k, ox, oy) {
  const f = P.n === 1 ? 0.5 : k / (P.n - 1);
  const side = f * 2 - 1 + R.range(-0.25, 0.25);
  const th0 = side * P.spread + P.lean + R.range(-0.05, 0.05);
  let L = R.range(P.len[0], P.len[1]);
  if (P.low) L = Math.abs(side) > 0.45 ? R.range(P.len[0], P.len[0] * 1.5) : R.range(P.len[1] * 0.75, P.len[1]);
  // blades droop outward; a few curl the other way, and a current can comb them all one way
  let droop = R.range(P.droop[0], P.droop[1]) * (side + P.lean * 1.5 >= 0 ? 1 : -1) * (0.45 + 0.55 * Math.min(1, Math.abs(side) + 0.3));
  if (P.sweep) droop = Math.abs(droop) * 0.9 + 0.1;
  else if (R.chance(0.15)) droop *= -0.4;
  const wob = R.range(-0.18, 0.18);
  const wph = R.range(0, TAU);
  const hw0 = R.range(P.hw[0], P.hw[1]);
  const tw0 = R.range(-0.5, 0.5);
  const tw1 = R.chance(P.twist) ? (R.chance(0.5) ? 1 : -1) * R.range(2.2, 3.6) : R.range(-0.7, 0.7);
  const twAt = R.range(0.35, 0.75);
  const bx = side * P.base * 0.55 + R.range(-2.5, 2.5);
  const path = [];
  let x = bx;
  let y = -10;
  const step = 1.5;
  const n = Math.ceil(L / step);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const th = th0 + droop * Math.pow(t, 1.7) + wob * Math.sin(t * 5 + wph) * t;
    const psi = tw0 + tw1 * smoothstep(twAt - 0.22, twAt + 0.22, t);
    let hw = hw0 * (0.72 + 0.28 * smoothstep(0, 0.12, t)) * (1 - 0.4 * Math.pow(t, 1.6));
    if (t > 0.9) hw *= Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.9) / 0.1, 2))) * 0.9 + 0.1 * (1 - (t - 0.9) / 0.1);
    const cp = Math.cos(psi);
    const sp = Math.sin(psi);
    // frame: T along the blade, Pn across it in the picture plane, Z toward the viewer
    const Tx = Math.sin(th);
    const Ty = Math.cos(th);
    const Px = Math.cos(th);
    const Py = -Math.sin(th);
    const back = cp < 0;
    const sg = back ? -1 : 1;
    // face normal (toward the viewer) and width axis; the outer side of the arch catches top light
    const arch = 0.45 * Math.sign(droop || 1) * smoothstep(0.05, 0.6, t);
    const N = norm3([-Px * sp * sg + Px * arch, -Py * sp * sg + Py * arch + 0.1, cp * sg]);
    path.push({ x: ox + x, y: oy - y, hw: hw * (Math.abs(cp) * 0.94 + 0.06), t, N, B: [Px * cp, Py * cp, sp], back, len: L, face: smoothstep(0.25, 0.7, Math.abs(cp)) });
    x += Tx * step;
    y += Ty * step;
  }
  return { path, L, side, top: y };
}

function grassTuft(id, v, ss) {
  const R = rng(hashStr(id));
  const P = GRASS[v - 1];
  let blades = [];
  for (let k = 0; k < P.n; k++) blades.push(grassBlade(R, P, k, 0, 0));
  // fit the tuft to its target box (positions only, so blade widths stay natural)
  let x0 = 1e9;
  let x1 = -1e9;
  let top = 0;
  for (const b of blades)
    for (const q of b.path) {
      x0 = Math.min(x0, q.x - q.hw);
      x1 = Math.max(x1, q.x + q.hw);
      top = Math.max(top, -q.y);
    }
  const sx = clamp(P.w / (x1 - x0), 0.7, 1.35);
  const sy = clamp(316 / top, 0.75, 1.35);
  const w = Math.ceil((x1 - x0) * sx) + 24;
  const h = 316 + 12 + 22;
  const ox = Math.round(-x0 * sx) + 12;
  const oy = 316 + 12;
  for (const b of blades)
    for (const q of b.path) {
      q.x = ox + q.x * sx;
      q.y = oy + q.y * sy;
    }
  // depth order: random, but the tallest blades tend to stand at the back
  blades.forEach((b) => (b.depth = R.range(0, 1) - 0.35 * (b.L / P.len[1])));
  blades.sort((a, b) => a.depth - b.depth);
  const parts = [];
  const per = Math.ceil(blades.length / 3);
  const out = [0, 0, 0, 0];
  for (let layer = 0; layer < 3; layer++) {
    const group = blades.slice(layer * per, (layer + 1) * per);
    if (!group.length) continue;
    const pt = new Paint(w, h, ss);
    const dk = [0.76, 0.88, 1][layer];
    const cool = [0.1, 0.05, 0][layer];
    for (const b of group) {
      const seed = Math.floor(R.range(0, 9999));
      const own = R.range(0.93, 1.06); // every blade is a slightly different green
      pt.ribbon(b.path, (p0, p1, f, u, o) => {
        const t = p0.t + (p1.t - p0.t) * f;
        const N = p0.N;
        const B = p0.B;
        // cupped cross-section with a raised mid-rib
        const cup = -u * 0.55 + (Math.abs(u) < 0.2 ? -Math.sign(u) * 0.5 * (1 - Math.abs(u) / 0.2) : 0);
        const n = norm3([N[0] + B[0] * cup, N[1] + B[1] * cup, N[2] + B[2] * cup * 0.3]);
        const rib = Math.exp(-(u * u) / 0.012);
        const vein = 0.035 * Math.cos(u * 11) + 0.05 * (fbm(t * 26 + seed, u * 1.5, 2, seed) - 0.5);
        // dark sheath at the base, paler toward the tip
        let val = lerp(0.52, 1, smoothstep(0, 0.42, t)) * (0.9 + 0.12 * t) * (1 - 0.14 * u * u) + vein;
        val += (p0.back ? -0.07 : 0.13) * rib * p0.face;
        if (p0.back) val *= 0.84;
        val *= dk * own;
        const ao = lerp(0.55, 1, smoothstep(0, 0.3, t));
        const c = litBlade(val, n, ao, 1.22);
        o[0] = c[0] * (1 - cool);
        o[1] = c[1] * (1 - cool * 0.3);
        o[2] = c[2];
        o[3] = lerp(1, 0.42, smoothstep(0.8, 1, t));
      }, { shadow: [4, 0.3] });
    }
    const img = pt.resolve();
    const gx = Math.round(group.reduce((a, b) => a + (b.path[0].x - ox), 0) / group.length);
    parts.push(part(img, ox + gx, oy, sway(4.2 + layer * 1.1 + R.range(0, 0.6), 0.27 + layer * 0.045, R.range(0, 1)), [gx, 0]));
  }
  return def(parts, true, 320);
}

// ---------------------------------------------------------------------------- sponges
/**
 * Hollow tube sponges as one implicit solid. tubes: [{ x, z, h, r, lx, lz (lean per px of
 * height), bend, wall, flare }]. Returns { sdf, info } where info(x, y, z) -> [tube index,
 * radial coordinate relative to the wall, depth below the lip].
 */
function tubeCluster(tubes, k, seed, ribs = 0) {
  const I = [0, 0, 0];
  const one = (t, x, y, z) => {
    const yy = clamp(y, -14, t.h + 4);
    const lx = x - t.x - t.lx * yy - t.bend * yy * yy;
    const lz = z - t.z - t.lz * yy;
    const q = Math.hypot(lx, lz);
    const f = clamp(yy / t.h);
    // barrel profile: narrow foot, swelling middle, slightly pinched lip
    let r = t.r * (0.72 + 0.4 * Math.sin(PI * Math.pow(f, 0.75)) * (1 - 0.28 * f) + (t.flare ?? 0) * f * f);
    if (ribs) r *= 1 + 0.045 * Math.cos(Math.atan2(lz, lx) * ribs + y * 0.05 + t.x);
    r += (fbm3(x * 0.11, y * 0.11, z * 0.11, 2, seed) - 0.5) * 3.2;
    const outer = smax(q - r, y - t.h, 2.2);
    const inner = smax(q - (r - t.wall), t.h - (t.depth ?? t.h * 0.7) - y, 2);
    I[1] = (q - (r - t.wall)) / t.wall;
    I[2] = t.h - y;
    return smax(outer, -inner, 1.6) * 0.85;
  };
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (const t of tubes) d = smin(d, one(t, x, y, z), k);
    return d;
  };
  const info = (x, y, z) => {
    let best = 1e9;
    const out = [0, 0, 0];
    tubes.forEach((t, i) => {
      const d = one(t, x, y, z);
      if (d < best) {
        best = d;
        out[0] = i;
        out[1] = I[1];
        out[2] = I[2];
      }
    });
    return out;
  };
  return { sdf, info };
}

function spongeTube(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  const tubes = v === 1
    ? [
      { x: -4, z: -4, h: 104, r: 11.5, lx: -0.03, lz: 0, bend: 0.0004, wall: 3.2 },
      { x: 20, z: 6, h: 74, r: 10.5, lx: 0.13, lz: 0.02, bend: 0.0006, wall: 3 },
      { x: -24, z: 8, h: 58, r: 10, lx: -0.2, lz: 0.03, bend: -0.0008, wall: 3 },
      { x: 4, z: 18, h: 34, r: 8.5, lx: 0.05, lz: 0.1, bend: 0, wall: 2.8 },
    ]
    : [
      { x: -14, z: -2, h: 86, r: 15, lx: -0.12, lz: 0, bend: -0.0006, wall: 3.6, flare: 0.1 },
      { x: 16, z: 4, h: 100, r: 13.5, lx: 0.1, lz: 0, bend: 0.0007, wall: 3.4, flare: 0.08 },
      { x: 0, z: 20, h: 44, r: 11, lx: 0.02, lz: 0.12, bend: 0, wall: 3 },
      { x: 34, z: 16, h: 20, r: 7, lx: 0.2, lz: 0.1, bend: 0, wall: 2.4 },
    ];
  const { sdf, info } = tubeCluster(tubes, 7, seed, v === 1 ? 0 : 9);
  const pitch = 0.32;
  const w = 124;
  const h = 150;
  const cam = camera(62, 128, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  solid(g, cam, (x, y, z) => Math.max(sdf(x, y, z), -(y + 13)), [-58, -13, -34, 58, 112, 40], (x, y, z, n, m) => {
    const q = info(x, y, z);
    const inside = smoothstep(0.62, 0.3, q[1]) * smoothstep(-0.5, 1.5, q[2]);
    // small pores, the pale lip, and the cavity falling into darkness
    const wv = worley3(x * 0.33, y * 0.33, z * 0.33, seed);
    const pore = smoothstep(0.34, 0.14, wv[0]) * (1 - inside);
    const lip = smoothstep(4.5, 0.5, Math.abs(q[2])) * (1 - inside);
    const val = 0.84 - 0.22 * pore + 0.16 * lip + 0.08 * (fbm3(x * 0.07, y * 0.07, z * 0.07, 2, seed + 3) - 0.5);
    const cav = lerp(1, lerp(0.42, 0.1, smoothstep(0, 12, q[2])), inside);
    setGrey(m, val * lerp(1, 0.7, inside), cav * lerp(0.64, 1, smoothstep(-8, 26, y)) * (1 - 0.2 * pore));
  }, { relax: 0.75, steps: 70, e: 0.3 });
  const img = g.resolve({ ao: [[1.8, 0.55], [6, 0.6], [16, 0.45]], shadow: [26, 0.65, 0.4], gain: 1.3 });
  return def([part(img, cam.ox, cam.oy)]);
}

function spongeVase(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  const H = 86;
  const ph = R.range(0, TAU);
  const I = [0, 0, 0];
  const NF = 12;
  const one = (x, y, z) => {
    const lx = x - 0.07 * y - 2 * Math.sin(y * 0.05);
    const q = Math.hypot(lx, z);
    const ang = Math.atan2(z, lx);
    const f = clamp(y / H);
    // ragged lip: the rim rises and dips around the cup
    const top = H + 3.2 * Math.sin(2 * ang + ph) + 2.2 * Math.sin(5 * ang + ph * 2) + 1.2 * Math.sin(9 * ang + ph * 3);
    // flaring cup with slightly irregular ribs down the outer wall
    const depth = 0.5 + 0.5 * Math.sin(ang * 3 + ph * 1.7);
    const rib = Math.cos(NF * ang + 1.6 * Math.sin(f * 3 + ph) + 0.7 * Math.sin(ang * 2 + ph));
    const body = 11 + 35 * Math.pow(f, 1.2) + 4 * Math.exp(-Math.max(0, y + 4) / 6);
    const lump = (fbm3(x * 0.08, y * 0.08, z * 0.08, 2, seed) - 0.5) * 3;
    const rOut = body * (1 + (0.05 + 0.035 * depth) * rib * smoothstep(0.05, 0.4, f)) * (1 + 0.05 * Math.sin(2 * ang + ph * 0.6)) + lump;
    const wall = lerp(8, 4.6, f);
    // the inner wall follows the outer one, with the ribs only faintly echoed
    const rIn = body * (1 + 0.012 * rib) * (1 + 0.05 * Math.sin(2 * ang + ph * 0.6)) + lump * 0.5 - wall;
    const outer = smax(q - rOut, y - top, 2.8);
    const inner = smax(q - rIn, 18 - y, 4);
    I[0] = (q - rIn) / wall;
    I[1] = top - y;
    I[2] = ang;
    return smax(outer, -inner, 2.2) * 0.78;
  };
  const sdf = (x, y, z) => Math.max(one(x, y, z), -(y + 13));
  const pitch = 0.34;
  const w = 130;
  const h = 136;
  const cam = camera(62, 112, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 10.5, 1.5, hashStr(id) & 255);
  solid(g, cam, sdf, [-58, -13, -56, 62, 98, 56], (x, y, z, n, m) => {
    one(x, y, z);
    const inside = smoothstep(0.62, 0.3, I[0]) * smoothstep(-0.5, 2, I[1]);
    // pores: crisp little pits scattered over the outer wall, larger vents inside
    const wv = worley3(x * 0.42, y * 0.42, z * 0.42, seed);
    const pore = smoothstep(0.3, 0.14, wv[0]) * (wv[2] > 0.35 ? 1 : 0);
    const lip = smoothstep(5.5, 0.5, Math.abs(I[1])) * (1 - inside);
    const mott = fbm3(x * 0.06, y * 0.06, z * 0.06, 2, seed + 4) - 0.5;
    const val = 0.88 - 0.24 * pore * (1 - inside * 0.5) + 0.16 * lip + 0.1 * mott;
    const cav = lerp(1, lerp(0.5, 0.07, smoothstep(0, 32, I[1])), inside);
    setGrey(m, val * lerp(1, 0.66, inside), cav * (1 - 0.2 * pore) * lerp(0.64, 1, smoothstep(-8, 26, y)));
  }, { relax: 0.7, steps: 76, e: 0.3 });
  const img = g.resolve({ ao: [[1.8, 0.5], [6, 0.55], [16, 0.45]], shadow: [30, 0.7, 0.4], gain: 1.32 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- hanging growths
function hang(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  const w = 104;
  const h = 122;
  const cam = camera(52, 18, 0.0);
  const g = new GBuf(w, h, ss);
  g.ceiling(cam.oy, 10.5, 1.5, seed);
  const m = grey(1);
  const K = 0.86;
  if (v === 1) {
    // drooping sponge lobes: plump teardrops of different lengths fused along the ceiling
    const lobes = [[-19, 44, 6, 9.5, -0.14], [-2, 76, 0, 13, 0.02], [17, 54, 5, 10.5, 0.14], [30, 28, -2, 7.5, 0.3], [-32, 24, -3, 7, -0.35], [8, 27, 12, 7.5, 0.0], [-9, 20, 13, 5.5, -0.1]];
    const L = lobes.map((l) => ({ x: l[0] * K, len: l[1] * K, z: l[2] * K, r: l[3] * K, lean: l[4], ph: R.range(0, TAU), wob: R.range(1.5, 3.5) }));
    const one = (l, x, y, z) => {
      // y is negative below the ceiling
      const t = clamp(-y / l.len, -0.2, 1.2);
      const cx = l.x + l.lean * -y + l.wob * Math.sin(t * 3.2 + l.ph);
      // narrow neck swelling to a heavy rounded tip
      const r = l.r * (0.36 + 0.7 * Math.pow(clamp(t), 1.5) - 0.06 * Math.sin(t * 9 + l.ph));
      const q = Math.hypot(x - cx, z - l.z);
      return smax(q - r, -y - l.len - l.r * 0.5, l.r * 1.1) * 0.78;
    };
    const sdf = (x, y, z) => {
      let d = 1e9;
      for (const l of L) d = smin(d, one(l, x, y, z), 4.5);
      // root mass in the ceiling
      d = smin(d, sdEllipsoid(x + 1, y - 6, z - 2, 31, 8.5, 12), 7);
      return d + (fbm3(x * 0.12, y * 0.12, z * 0.12, 2, seed) - 0.5) * 2.6;
    };
    solid(g, cam, sdf, [-46, -96, -20, 46, 13, 26], (x, y, z, n, mm) => {
      // pitted sponge skin, slightly paler on the swollen tips
      const wv = worley3(x * 0.4, y * 0.4, z * 0.4, seed);
      const pore = smoothstep(0.32, 0.14, wv[0]) * (wv[2] > 0.3 ? 1 : 0);
      let tip = 0;
      for (const l of L) tip = Math.max(tip, smoothstep(l.r * 1.6, l.r * 0.3, Math.hypot(x - (l.x + l.lean * l.len), y + l.len * 0.92)));
      setGrey(mm, 0.84 - 0.24 * pore + 0.12 * tip + 0.1 * (fbm3(x * 0.06, y * 0.06, z * 0.06, 2, seed + 9) - 0.5), (1 - 0.22 * pore) * lerp(0.6, 1, smoothstep(6, -22, y)));
    }, { relax: 0.72, steps: 64, e: 0.3 });
  } else {
    // stalactite-like fingers: knobbly cones of different lengths, slightly curved
    const fingers = [[-22, 52, -0.08, 8.5], [-6, 86, 0.02, 10], [12, 64, 0.1, 9], [26, 38, 0.24, 7.5], [-34, 30, -0.3, 7], [3, 40, 0.05, 7.5]];
    const list = [];
    fingers.forEach((f, k) => {
      const b = fleshy(R, growBranch(R, [f[0] * K, 9, (k % 2 ? 6 : -3) + (k === 5 ? 9 : 0)], norm3([Math.sin(f[2]), -Math.cos(f[2]), 0]), f[3] * K, f[1] * K + 9, { tropism: -0.25, bend: 0.3, taper: 0.3, taperPow: 0.9 }), 0.12, 0.05);
      list.push(b);
    });
    const occ = (y) => lerp(0.62, 1, smoothstep(8, -24, y));
    blobs(g, cam, [[-15, 7, 0, 11], [0, 8, 2, 12], [15, 7, 0, 11], [-28, 6, 0, 8], [27, 6, 0, 8]], 9, (x, y, z, n, mm) => setGrey(mm, 0.84, occ(y)), { noise: 3, freq: 0.15, seed });
    for (const b of list) {
      const n = b.pts.length;
      g.tube(cam, b.pts, (t) => setGrey(m, lerp(0.8, 1.06, smoothstep(0.8, 1, t)), occ(b.pts[Math.min(n - 1, Math.round(t * (n - 1)))][1])));
      corallites(g, cam, b, R, (t, y) => setGrey(m, lerp(0.84, 1.06, smoothstep(0.75, 1, t)), occ(y)), { spacing: 2.7, r: 1.05, end: 3 });
      // a few stubby side knobs
      for (let k = 0; k < 3; k++) {
        const i = Math.floor(R.range(0.2, 0.75) * (n - 1));
        const q = b.pts[i];
        const nr = randPerp(dirAt(b.pts, i), R);
        if (nr[2] < -0.2) continue;
        g.ball(cam, q[0] + nr[0] * q[3] * 0.8, q[1] + nr[1] * q[3] * 0.8 - 1, q[2] + nr[2] * q[3] * 0.8, q[3] * R.range(0.42, 0.6), setGrey(m, 0.86, occ(q[1])));
      }
    }
  }
  const img = g.resolve({ ao: [[1.8, 0.55], [6, 0.6], [14, 0.4]], shadow: [18, 0.45, 0.4], gain: 1.2 });
  return def([part(img, cam.ox, cam.oy, sway(2, 0.24 + 0.03 * v, R.range(0, 1)))]);
}

// ---------------------------------------------------------------------------- barnacles
function barnacle(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  // cones: [x, z, base radius, height, tilt x, tilt z]
  const cones = v === 1
    ? [[-11, -2, 13.5, 17, -0.14, 0], [12, 0, 12, 15, 0.16, 0.05], [0, 11, 8.5, 10.5, 0.02, 0.3], [-25, 6, 7.5, 9, -0.32, 0.2], [26, 8, 7, 8.5, 0.36, 0.2], [-1, -12, 7.5, 12, 0, -0.2]]
    : [[-24, 0, 8.5, 10.5, -0.2, 0], [-9, 4, 9.5, 12, -0.05, 0.1], [7, -1, 8, 10, 0.08, -0.05], [21, 3, 9.5, 11.5, 0.2, 0.1], [-16, 12, 5.5, 6.5, -0.2, 0.35], [0, 13, 6, 7, 0, 0.4], [14, 13, 5.2, 6, 0.2, 0.4], [29, 11, 4.6, 5.5, 0.4, 0.3], [-30, 10, 4.6, 5.5, -0.4, 0.3]];
  const C = cones.map((c) => ({ x: c[0], z: c[1], rb: c[2], h: c[3], tx: c[4], tz: c[5], ph: R.range(0, TAU) }));
  const I = [0, 0, 0];
  const one = (c, x, y, z) => {
    // tilt the axis outward
    const lx = x - c.x - c.tx * y;
    const lz = z - c.z - c.tz * y;
    const q = Math.hypot(lx, lz);
    const ang = Math.atan2(lz, lx);
    const f = clamp(y / c.h);
    // six ribbed wall plates
    const rib = 1 + 0.06 * Math.cos(ang * 12 + c.ph) + 0.05 * Math.cos(ang * 6 + c.ph * 2);
    const r = c.rb * (1 - 0.56 * Math.pow(f, 0.85)) * rib;
    const outer = smax((q - r) * 0.86, y - c.h, 1.4);
    const crater = smax(q - c.rb * 0.31 * (0.55 + 0.45 * f), c.h * 0.45 - y, 1.2);
    I[0] = q - c.rb * 0.31;
    I[1] = c.h - y;
    I[2] = ang;
    return smax(outer, -crater, 1.1) * 0.85;
  };
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (const c of C) d = smin(d, one(c, x, y, z), 1.6);
    d = smin(d, sdEllipsoid(x, y + 3, z - 4, v === 1 ? 34 : 36, 6, 16), 3);
    return d;
  };
  const pitch = 0.5;
  const w = 92;
  const h = 56;
  const cam = camera(46, 40, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 5.5, 0.7, hashStr(id) & 255);
  solid(g, cam, sdf, [-40, -8, -22, 40, 20, 24], (x, y, z, n, m) => {
    let best = 1e9;
    let q0 = 0;
    let dep = 0;
    let ang = 0;
    for (const c of C) {
      const d = one(c, x, y, z);
      if (d < best) {
        best = d;
        q0 = I[0];
        dep = I[1];
        ang = I[2];
      }
    }
    const inside = smoothstep(0.8, -0.6, q0) * smoothstep(0.2, 1.6, dep);
    const growth = 0.05 * Math.cos(dep * 2.3);
    const seam = 0.1 * smoothstep(0.92, 1, Math.cos(ang * 6));
    setGrey(m, (0.88 + growth - seam + 0.12 * smoothstep(2.5, 0.3, dep)) * lerp(1, 0.6, inside), lerp(1, lerp(0.5, 0.12, smoothstep(0, 5, dep)), inside) * lerp(0.7, 1, smoothstep(-3, 6, y)));
  }, { relax: 0.72, steps: 64, e: 0.25 });
  const img = g.resolve({ ao: [[1.3, 0.5], [4, 0.6], [9, 0.4]], shadow: [12, 0.6, 0.4], gain: 1.12 });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- small algae
/** A leaf / pinna as a ribbon path with a lighting frame. pts(t) -> [x, y] in canvas px. */
function leafPath(curve, n, hwAt, psiAt, extra = {}) {
  const path = [];
  let prev = curve(0);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = curve(t);
    const q = curve(Math.min(1, t + 0.01));
    const p0 = curve(Math.max(0, t - 0.01));
    const dx = q[0] - p0[0];
    const dy = -(q[1] - p0[1]);
    const l = Math.hypot(dx, dy) || 1;
    const Px = dy / l;
    const Py = -dx / l;
    const psi = psiAt(t);
    const cp = Math.cos(psi);
    const sp = Math.sin(psi);
    const back = cp < 0;
    const sg = back ? -1 : 1;
    path.push({ x: p[0], y: p[1], hw: hwAt(t) * (Math.abs(cp) * 0.92 + 0.08), t, N: norm3([-Px * sp * sg + (extra.arch ?? 0) * Px, -Py * sp * sg + (extra.arch ?? 0) * Py + 0.12, cp * sg]), B: [Px * cp, Py * cp, sp], back });
    prev = p;
  }
  return path;
}

function weed(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  const w = 124;
  const h = 112;
  const ox = 62;
  const oy = 92;
  if (v === 3) {
    // low bubbly clump (sea grapes): glossy beads crowded on short runners
    const g = new GBuf(w, h, ss);
    const cam = camera(ox, oy, 0.2);
    g.foot(oy, 8.5, 1.2, seed);
    const m = grey(1, 1, 0.55, 0.3);
    const beads = [];
    // a few arching runners define the mound; beads cluster along them
    for (let k = 0; k < 7; k++) {
      const a = (k / 6) * 2 - 1;
      const len = R.range(22, 40) * (1 - 0.25 * a * a);
      const dir = norm3([a * 1.1 + R.range(-0.15, 0.15), 0.9, R.range(-0.6, 0.6)]);
      const br = growBranch(R, [a * 12, -5, R.range(-5, 5)], dir, 1.6, len, { tropism: -0.5 * Math.abs(a), bend: 0.5, taper: 0.8 });
      g.tube(cam, br.pts, setGrey(m, 0.7, 0.7));
      const n = br.pts.length;
      for (let i = 1; i < n; i += 1) {
        const q = br.pts[i];
        const T = dirAt(br.pts, i);
        for (let j = 0; j < 2; j++) {
          const nr = randPerp(T, R);
          const r = R.range(2.6, 4.8) * (0.75 + 0.25 * (i / n));
          beads.push([q[0] + nr[0] * (r + 0.6), q[1] + nr[1] * (r + 0.6), q[2] + nr[2] * (r + 0.6), r]);
        }
      }
    }
    for (let k = 0; k < 26; k++) beads.push([R.range(-30, 30), R.range(-4, 5), R.range(-8, 12), R.range(2.6, 4.6)]);
    for (const q of beads) g.ball(cam, q[0], q[1], q[2], q[3], setGrey(m, R.range(0.84, 1.0), lerp(0.62, 1, smoothstep(-6, 22, q[1]))));
    const img = g.resolve({ ao: [[1.6, 0.6], [5, 0.6], [11, 0.4]], shadow: [14, 0.5, 0.4] });
    return def([part(img, ox, oy, sway(2, 0.3, R.range(0, 1)))]);
  }
  const parts = [];
  const out = [0, 0, 0, 0];
  const shadeLeaf = (dk, sd) => (p0, p1, f, u, o) => {
    const t = p0.t + (p1.t - p0.t) * f;
    const N = p0.N;
    const B = p0.B;
    const cup = -u * 0.6 + (Math.abs(u) < 0.16 ? -Math.sign(u) * 0.55 * (1 - Math.abs(u) / 0.16) : 0);
    const n = norm3([N[0] + B[0] * cup, N[1] + B[1] * cup, N[2] + B[2] * cup * 0.3]);
    const rib = Math.exp(-(u * u) / 0.01);
    // side veins sweep outward from the mid-rib
    const vein = 0.05 * Math.cos((t * 14 - Math.abs(u) * 3.2) * 2.2 + sd);
    let val = lerp(0.6, 1, smoothstep(0, 0.4, t)) * (1 - 0.12 * u * u) + vein * (1 - rib) + (p0.back ? -0.06 : 0.1) * rib;
    if (p0.back) val *= 0.86;
    const c = litBlade(val * dk, n, lerp(0.6, 1, smoothstep(0, 0.35, t)), 1.08);
    o[0] = c[0];
    o[1] = c[1];
    o[2] = c[2];
    o[3] = 1;
  };
  if (v === 1) {
    // rounded leafy clump: broad ovate leaves with wavy margins
    const leaves = [];
    const N = 11;
    for (let k = 0; k < N; k++) {
      const f = k / (N - 1);
      const side = f * 2 - 1 + R.range(-0.12, 0.12);
      const th0 = side * 1.05;
      const L = R.range(46, 72) * (1 - 0.3 * Math.abs(side));
      const droop = side * R.range(0.3, 0.9);
      const hw = R.range(8.5, 12);
      const wavPh = R.range(0, TAU);
      const bx = side * 7;
      const curve = (t) => {
        const th = th0 + droop * t * t;
        // integrate a gently bending mid-rib
        const a = th0 + droop * t * t * 0.45;
        return [ox + bx + Math.sin(a) * L * t, oy + 6 - Math.cos(a) * L * t * (1 - 0.1 * Math.abs(th))];
      };
      const path = leafPath(curve, 44, (t) => hw * Math.pow(Math.sin(PI * Math.pow(t, 0.52)), 0.62) * (1 + 0.1 * Math.sin(t * 16 + wavPh)) + 0.5, (t) => 0.5 * Math.sin(t * 5 + wavPh) + side * 0.3, { arch: 0.35 * Math.sign(droop || 1) });
      leaves.push({ path, depth: R.range(0, 1) - 0.3 * (1 - Math.abs(side)), sd: R.range(0, 6) });
    }
    leaves.sort((a, b) => a.depth - b.depth);
    for (let layer = 0; layer < 2; layer++) {
      const pt = new Paint(w, h, ss);
      const grp = leaves.slice(layer ? 5 : 0, layer ? N : 5);
      for (const lf of grp) pt.ribbon(lf.path, shadeLeaf(layer ? 1 : 0.82, lf.sd), { shadow: [3.5, 0.34] });
      parts.push(part(pt.resolve(), ox, oy, sway(3 + layer, 0.3 + 0.05 * layer, R.range(0, 1))));
    }
    return def(parts);
  }
  // feathery fronds: a mid-rib carrying two neat rows of pinnae that shorten toward the tip
  const fronds = [];
  const N = 6;
  for (let k = 0; k < N; k++) {
    const f = k / (N - 1);
    const side = f * 2 - 1 + R.range(-0.1, 0.1);
    const th0 = side * 0.85;
    const L = R.range(44, 68) * (1 - 0.22 * Math.abs(side));
    const droop = side * R.range(0.35, 0.8) + R.range(-0.1, 0.1);
    fronds.push({ th0, L, droop, bx: side * 6, depth: R.range(0, 1) - 0.3 * (1 - Math.abs(side)), sd: R.range(0, 6) });
  }
  fronds.sort((a, b) => a.depth - b.depth);
  for (let layer = 0; layer < 2; layer++) {
    const pt = new Paint(w, h, ss);
    const dk = layer ? 1 : 0.82;
    for (const fr of fronds.slice(layer ? 3 : 0, layer ? N : 3)) {
      const rachis = (t) => {
        const a = fr.th0 + fr.droop * t * t * 0.5;
        return [ox + fr.bx + Math.sin(a) * fr.L * t, oy + 8 - Math.cos(a) * fr.L * t];
      };
      const np = Math.round(fr.L / 3.3);
      for (let i = 2; i < np; i++) {
        const t = i / np;
        const p = rachis(t);
        const q = rachis(Math.min(1, t + 0.02));
        const ang = Math.atan2(q[0] - p[0], -(q[1] - p[1]));
        const plen = 11.5 * Math.pow(Math.sin(PI * Math.pow(t, 0.55)), 0.7) * (0.88 + 0.24 * R());
        for (const sgn of [-1, 1]) {
          const a = ang + sgn * (1.05 - 0.35 * t) + R.range(-0.08, 0.08);
          const curve = (s) => [p[0] + Math.sin(a + sgn * -0.35 * s) * plen * s, p[1] - Math.cos(a + sgn * -0.35 * s) * plen * s];
          const path = leafPath(curve, 8, (s) => 1.05 * Math.sin(PI * Math.pow(s * 0.92 + 0.04, 0.7)) + 0.3, () => 0.25 * sgn);
          pt.ribbon(path, (p0, p1, ff, u, o) => {
            const s = p0.t + (p1.t - p0.t) * ff;
            const c = litBlade((0.78 + 0.26 * s) * dk, norm3([p0.N[0] - p0.B[0] * u * 0.7, p0.N[1] - p0.B[1] * u * 0.7 + 0.1, p0.N[2]]), lerp(0.62, 1, smoothstep(0.05, 0.5, t)) * (0.75 + 0.25 * s), 1.2);
            o[0] = c[0];
            o[1] = c[1];
            o[2] = c[2];
            o[3] = lerp(1, 0.75, smoothstep(0.6, 1, s));
          }, { shadow: [1.6, 0.22], shadowOff: [0.6, 1.1] });
        }
      }
      const rp = leafPath(rachis, 40, (t) => 1.5 * (1 - 0.6 * t) + 0.3, () => 0);
      pt.ribbon(rp, (p0, p1, ff, u, o) => {
        const t = p0.t + (p1.t - p0.t) * ff;
        const c = litBlade((0.7 + 0.2 * t) * dk, norm3([p0.N[0] - p0.B[0] * u * 0.8, p0.N[1] - p0.B[1] * u * 0.8 + 0.1, p0.N[2]]), lerp(0.6, 1, smoothstep(0, 0.4, t)), 1.2);
        o[0] = c[0];
        o[1] = c[1];
        o[2] = c[2];
        o[3] = 1;
      }, { shadow: [1.5, 0.2] });
    }
    parts.push(part(pt.resolve(), ox, oy, sway(3 + layer, 0.32 + 0.05 * layer, R.range(0, 1))));
  }
  return def(parts);
}

// ---------------------------------------------------------------------------- seabed scatter
function pebbles(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  // stones: [x, z, rx, ry, rz, tone]
  const sets = [
    [[-24, 0, 20, 16, 15, 0.92], [5, 9, 11, 9, 9, 0.8], [23, -2, 14, 13, 12, 1.0], [40, 8, 6.5, 5.5, 6, 0.86], [-44, 9, 7.5, 6, 7, 0.96]],
    [[-36, 4, 10, 8.5, 8, 0.84], [-18, -3, 13, 12.5, 11, 1.0], [2, 7, 9.5, 7.5, 9, 0.9], [18, 0, 12, 10.5, 10, 0.8], [36, 5, 10, 8.5, 8, 0.96], [-5, 15, 5, 4, 5, 1.0], [27, 15, 4.5, 3.6, 4.5, 0.86]],
    [[-32, 2, 14, 12, 12, 0.88], [30, 4, 11, 10, 9, 0.98], [44, 11, 5.5, 4.6, 5, 0.82]],
  ][v - 1];
  const stones = sets.map((q) => ({ x: q[0], z: q[1], rx: q[2], ry: q[3], rz: q[4], tone: q[5], rot: R.range(-0.25, 0.25) }));
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (const q of stones) {
      const dx = x - q.x;
      const dy = y - q.ry * 0.42;
      const c = Math.cos(q.rot);
      const s = Math.sin(q.rot);
      d = Math.min(d, sdEllipsoid(dx * c + dy * s, -dx * s + dy * c, z - q.z, q.rx, q.ry, q.rz));
    }
    return d + (fbm3(x * 0.16, y * 0.16, z * 0.16, 2, seed) - 0.5) * 2.2;
  };
  const pitch = 0.3;
  const w = 128;
  const h = 62;
  const cam = camera(64, 48, pitch);
  const g = new GBuf(w, h, ss);
  g.foot(cam.oy, 2.5, 0.7, hashStr(id) & 255);
  solid(g, cam, sdf, [-56, -4, -18, 56, 32, 24], (x, y, z, n, m) => {
    let best = 1e9;
    let tone0 = 1;
    for (const q of stones) {
      const d = sdEllipsoid(x - q.x, y - q.ry * 0.42, z - q.z, q.rx, q.ry, q.rz);
      if (d < best) {
        best = d;
        tone0 = q.tone;
      }
    }
    const wv = worley3(x * 0.5, y * 0.5, z * 0.5, seed);
    const speck = smoothstep(0.3, 0.12, wv[0]) * (wv[2] > 0.5 ? -0.16 : 0.08);
    setGrey(m, tone0 * (0.86 + 0.14 * (fbm3(x * 0.1, y * 0.1, z * 0.1, 3, seed + 4) - 0.5) * 2) + speck, lerp(0.55, 1, smoothstep(-2, 6, y)));
    m.gl = 0.08;
    m.sh = 0.16;
  }, { relax: 0.8, steps: 56, e: 0.28 });
  // coral rubble: broken branch pieces lying among the stones
  const m = grey(1);
  const rubble = [
    [[6, 3.4, 18, 0.2, 0.06, 19, 3.9]],
    [[-48, 3, 13, -0.15, 0.2, 14, 3.4]],
    [[-4, 3.8, 6, 0.12, 0.1, 32, 4.3], [10, 3.2, 18, -0.3, 0.3, 22, 3.6], [-46, 3, 15, 0.5, 0.2, 15, 3.2]],
  ][v - 1];
  for (const rb of rubble) {
    const [bx, by, bz, ang, lift, len, r0] = rb;
    const d = norm3([Math.cos(ang), lift, Math.sin(ang) * 0.5]);
    const br = growBranch(R, [bx - d[0] * len * 0.5, by, bz], d, r0, len, { tropism: -0.08, bend: 0.25, taper: 0.72 });
    const o = (y) => lerp(0.6, 1, smoothstep(-1, 5, y));
    g.tube(cam, br.pts, (t) => setGrey(m, lerp(0.88, 1.04, smoothstep(0.7, 1, t)), o(br.pts[0][1])));
    corallites(g, cam, br, R, (t, y) => setGrey(m, 0.98, o(y)), { spacing: 3.1, r: 0.9, end: 2 });
    if (len > 16) {
      const i = Math.round((br.pts.length - 1) * 0.45);
      const fd = norm3([d[0] * 0.5 - d[2] * 0.3, 0.75, d[2] * 0.5 + 0.3]);
      const fk = growBranch(R, br.pts[i], fd, br.pts[i][3] * 0.85, len * 0.36, { tropism: 0.1, bend: 0.2, taper: 0.7 });
      g.tube(cam, fk.pts, (t) => setGrey(m, lerp(0.9, 1.06, t), o(fk.pts[0][1])));
      corallites(g, cam, fk, R, (t, y) => setGrey(m, 0.98, o(y)), { spacing: 3.1, r: 0.9, end: 2 });
    }
  }
  const img = g.resolve({ ao: [[1.5, 0.5], [4.5, 0.6], [10, 0.4]], shadow: [10, 0.5, 0.4] });
  return def([part(img, cam.ox, cam.oy)]);
}

// ---------------------------------------------------------------------------- coloured: shells
function shell(id, v, ss) {
  const R = rng(hashStr(id));
  const seed = hashStr(id) & 1023;
  const s4 = Math.max(ss, 4);
  const K = 1.22; // authored small, enlarged to the kit size
  const w = 60;
  const h = 46;
  const cam = camera(30, 36, 0);
  const g = new GBuf(w, h, s4);
  g.foot(cam.oy, 2, 0.7, hashStr(id) & 255);
  const relief = (box, zf, shadeFn, o) =>
    g.relief(cam, box.map((q) => q * K), (x, y) => {
      const z = zf(x / K, y / K);
      return z < -1e8 ? z : z * K;
    }, (x, y, z, n, m) => shadeFn(x / K, y / K, z / K, n, m), o);
  if (v === 1) {
    // scallop: ribbed fan with two little ears at the hinge, propped up at an angle
    const rot = -0.3;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const Rm = 15.5;
    const NR = 9;
    const hx = 3;
    const hy = 2.5;
    const local = (x, y) => [(x - hx) * cr + (y - hy) * sr, -(x - hx) * sr + (y - hy) * cr];
    const zf = (x, y) => {
      const [lx, ly] = local(x, y);
      const r = Math.hypot(lx, ly);
      const th = Math.atan2(lx, ly);
      let zz = EMPTY;
      // ears
      const ex = Math.abs(lx);
      if (ex < 6.2 - ly * 0.9 && ly > -0.6 && ly < 3.6) zz = 1.2 + 0.5 * (1 - ex / 6.2);
      if (Math.abs(th) < 1.12) {
        const Ro = Rm * Math.pow(Math.cos(th * 0.82), 0.5) * (1 + 0.035 * Math.cos(th * NR * 2));
        const rho = r / Ro;
        if (rho < 1) {
          const dome = 5.2 * Math.pow(1 - rho * rho, 0.55) * smoothstep(0, 0.3, rho + 0.12) + 0.6;
          const rib = 0.75 * Math.cos(th * NR * 2) * smoothstep(0.08, 0.5, rho) * (1 - 0.5 * rho * rho);
          const ring = 0.16 * Math.cos(rho * 24);
          zz = Math.max(zz, dome + rib + ring);
        }
      }
      return zz;
    };
    const cream = hex('#f6e3c4');
    const peach = hex('#f0a987');
    const rose = hex('#d9737a');
    relief([-22, -3, 22, 24], zf, (x, y, z, n, m) => {
      const [lx, ly] = local(x, y);
      const r = Math.hypot(lx, ly);
      const th = Math.atan2(lx, ly);
      const Ro = Rm * Math.pow(Math.cos(clamp(th, -1.2, 1.2) * 0.82), 0.5);
      const rho = r / Ro;
      // concentric colour bands, a darker umbo and pale rib crests
      const band = smoothstep(0.35, 0.65, 0.5 + 0.5 * Math.sin(rho * 11.5 + 1.5 * vnoise(th * 3, 1, seed)));
      let c = mix3(cream, peach, band * 0.8);
      c = mix3(c, rose, smoothstep(0.5, 0.05, rho) * 0.75 + 0.2 * band * smoothstep(0.6, 1, rho));
      c = mul3(c, 0.93 + 0.1 * Math.cos(th * NR * 2));
      setRGB(m, c, lerp(0.72, 1, smoothstep(-1, 6, y)));
      m.gl = 0.2;
      m.sh = 0.22;
    }, { strength: 1.5 });
  } else if (v === 2) {
    // spired snail shell: whorls stepping down to a point, lying on its side
    const ax = norm3([0.86, 0.5, 0.1]);
    const base = [-8, 6.4, 0];
    const whorls = [];
    let pos = 0;
    let r = 7.4;
    for (let k = 0; k < 7; k++) {
      whorls.push([base[0] + ax[0] * pos, base[1] + ax[1] * pos, base[2] + ax[2] * pos, r, pos]);
      pos += r * 0.86;
      r *= 0.7;
    }
    const sdf0 = (x, y, z) => {
      let d = 1e9;
      for (const q of whorls) d = smin(d, sdEllipsoid(x - q[0], y - q[1], z - q[2], q[3], q[3] * 1.06, q[3]), 0.7);
      return d;
    };
    const cream = hex('#f3e2c2');
    const tan = hex('#c98a55');
    const brown = hex('#8f5636');
    solid(g, cam, (x, y, z) => sdf0(x / K, y / K, z / K) * K, [-18 * K, -3, -10 * K, 22 * K, 24 * K, 10 * K], (X, Y, Z, n, m) => {
      const x = X / K;
      const y = Y / K;
      const z = Z / K;
      // coordinates along the axis and around it give spiral bands of flame-like marks
      const dx = x - base[0];
      const dy = y - base[1];
      const dz = z - base[2];
      const t = dx * ax[0] + dy * ax[1] + dz * ax[2];
      const px = dx - ax[0] * t;
      const py = dy - ax[1] * t;
      const pz = dz - ax[2] * t;
      const ang = Math.atan2(py, pz);
      const spiral = t * 1.25 + ang * 0.45;
      const flame = smoothstep(0.25, 0.6, 0.5 + 0.5 * Math.sin(spiral * 4.2)) * smoothstep(0.35, 0.65, vnoise(ang * 2.4 + t * 0.7, t * 0.9, seed));
      let c = mix3(cream, tan, flame * 0.9);
      c = mix3(c, brown, flame * smoothstep(0.5, 0.9, vnoise(ang * 5, t * 2, seed + 3)) * 0.6);
      // sutures: the grooves where one whorl meets the next
      let sut = 0;
      for (let k = 0; k < whorls.length - 1; k++) {
        const mid = (whorls[k][4] + whorls[k + 1][4]) / 2 + whorls[k][3] * 0.16;
        sut = Math.max(sut, smoothstep(0.75, 0.1, Math.abs(t - mid)));
      }
      setRGB(m, mix3(c, brown, sut * 0.55), lerp(0.7, 1, smoothstep(-1, 5, y)) * (1 - 0.3 * sut));
      m.gl = 0.3;
      m.sh = 0.25;
    }, { relax: 0.8, steps: 48, e: 0.22 });
  } else {
    // clam valve with concentric growth ridges and a broken, jagged edge
    const ux = 1;
    const uy = 13.5;
    const zf = (x, y) => {
      const ex = (x - 1) / 17;
      const ey = (y - 6.2) / 9.2;
      const rr = ex * ex + ey * ey;
      if (rr >= 1) return EMPTY;
      // the break: a ragged bite out of the right-hand margin
      const bite = Math.hypot(x - 18, y - 3.5) - 9.5 + 3.2 * (vnoise(x * 0.55, y * 0.55, seed) - 0.5) + 1.2 * Math.sin(Math.atan2(y - 3.5, x - 18) * 7);
      if (bite < 0) return EMPTY;
      const d = Math.hypot((x - ux) / 17, (y - uy) / 15);
      const dome = 6.2 * Math.pow(1 - rr, 0.55) + 0.5;
      return dome + 0.42 * Math.cos(d * 44) * smoothstep(0.1, 0.4, d) + 0.25 * smoothstep(1.6, 0, bite);
    };
    const white = hex('#f7eee2');
    const pink = hex('#eab2ae');
    const mauve = hex('#b98aa6');
    relief([-20, -3, 22, 20], zf, (x, y, z, n, m) => {
      const d = Math.hypot((x - ux) / 17, (y - uy) / 15);
      const ang = Math.atan2(x - ux, uy - y);
      const ray = smoothstep(0.55, 0.9, 0.5 + 0.5 * Math.cos(ang * 9 + 2 * vnoise(ang * 2, 3, seed)));
      let c = mix3(white, pink, smoothstep(0.75, 0.15, d) * 0.9 + 0.25 * (0.5 + 0.5 * Math.cos(d * 22)));
      c = mix3(c, mauve, ray * 0.45 * smoothstep(0.2, 0.7, d));
      // the broken edge shows chalky shell
      const bite = Math.hypot(x - 18, y - 3.5) - 9.5;
      c = mix3(c, hex('#fffaf0'), smoothstep(2.4, 0.4, bite) * 0.6);
      setRGB(m, c, lerp(0.72, 1, smoothstep(-1, 6, y)));
      m.gl = 0.22;
      m.sh = 0.22;
    }, { strength: 1.4 });
  }
  const img = g.resolve({ tint: false, ao: [[1.2, 0.5], [3.5, 0.5]], shadow: [6, 0.4, 0.4] });
  return def([part(img, cam.ox, cam.oy, null, [0, 0], 3, true)], false);
}

// ---------------------------------------------------------------------------- coloured: Christmas-tree worms
function xmasWorm(id, v, ss) {
  const R = rng(hashStr(id));
  const s4 = Math.max(ss, 4);
  const w = 56;
  const h = 58;
  const cam = camera(28, 46, 0.22);
  const g = new GBuf(w, h, s4);
  g.foot(cam.oy, 2.5, 0.7, hashStr(id) & 255);
  const pal = v === 1
    ? { base: hex('#e2491f'), mid: hex('#ff8a1e'), tip: hex('#ffe066'), tube: hex('#e9dcc6') }
    : { base: hex('#1f4fc4'), mid: hex('#3d8bf0'), tip: hex('#f4f8ff'), tube: hex('#dfe3ea') };
  const m = mat(0, 0, 0, 1, 0.12, 0.16);
  const crowns = [[-7.5, 0, 26, 8.2, 0.0, 1], [7, 2, 22.5, 7.2, 2.1, -1]];
  for (const [cx, cz, H, R0, ph, hand] of crowns) {
    const lean = cx * 0.012;
    // calcareous tube collar
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      g.ball(cam, cx + Math.cos(a) * 2.2, 0.6, cz + Math.sin(a) * 2.2, 1.9, setRGB(m, pal.tube, 0.8));
    }
    // central stalk
    g.tube(cam, [[cx, -1, cz, 1.6], [cx + lean * H, H * 0.9, cz, 0.7]], setRGB(m, mul3(pal.base, 0.8), 0.8));
    // radioles: fine feathery rays set along a descending spiral, longest at the bottom whorl
    const turns = 4.6;
    const n = 150;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const a = ph + hand * t * turns * TAU;
      const y0 = 2.5 + t * (H - 4);
      const rad = R0 * Math.pow(1 - t, 0.8) + 0.9;
      const up = 0.42 + 0.3 * t;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const ax0 = cx + lean * y0;
      const pts = [];
      for (let k = 0; k <= 4; k++) {
        const s = k / 4;
        // rays curve gently upward toward their tips
        pts.push([ax0 + dx * rad * s, y0 + rad * up * s * s + 0.3 * s, cz + dz * rad * s, lerp(0.62, 0.34, s)]);
      }
      const band = 0.5 + 0.5 * Math.sin(t * 34);
      g.tube(cam, pts, (s) => {
        let c = s < 0.55 ? mix3(pal.base, pal.mid, s / 0.55) : mix3(pal.mid, pal.tip, (s - 0.55) / 0.45);
        c = mix3(c, pal.tip, 0.22 * band * s);
        return setRGB(m, c, lerp(0.62, 1, s) * lerp(0.8, 1, t));
      });
    }
  }
  const img = g.resolve({ tint: false, ao: [[1.0, 0.45], [3, 0.5]], shadow: [6, 0.35, 0.4] });
  return def([part(img, cam.ox, cam.oy)], false);
}

// ---------------------------------------------------------------------------- coloured: urchin
function urchinDecor(id, v, ss) {
  const R = rng(hashStr(id));
  const s4 = Math.max(ss, 4);
  const w = 70;
  const h = 62;
  const cam = camera(35, 44, 0.25);
  const g = new GBuf(w, h, s4);
  const body = hex('#2a1436');
  const spineA = hex('#4a2463');
  const spineB = hex('#8a5aa8');
  const m = mat(0, 0, 0, 1, 0.35, 0.2);
  const cy = 9;
  const rb = 10.5;
  // test (body): a slightly flattened dark dome
  solid(g, cam, (x, y, z) => sdEllipsoid(x, y - cy, z, rb, rb * 0.78, rb), [-12, -2, -12, 12, 20, 12], (x, y, z, n, mm) => {
    setRGB(mm, mul3(body, 1 + 0.5 * vnoise(x * 0.8, y * 0.8, 5)), 0.7);
    mm.gl = 0.3;
    mm.sh = 0.2;
  });
  // short spines in rows radiating over the upper hemisphere
  const n = 190;
  for (let i = 0; i < n; i++) {
    const yy = 1 - (1.35 * (i + 0.5)) / n;
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    const a = i * 2.399963;
    const d = norm3([rr * Math.cos(a) + R.range(-0.08, 0.08), yy * 0.82 + R.range(-0.05, 0.05), rr * Math.sin(a) + R.range(-0.08, 0.08)]);
    if (d[1] < -0.3) continue;
    const len = R.range(6.5, 10.5) * (0.8 + 0.2 * Math.abs(d[0]));
    const p0 = [d[0] * rb * 0.9, cy + d[1] * rb * 0.72, d[2] * rb * 0.9];
    const p1 = [p0[0] + d[0] * len, p0[1] + d[1] * len, p0[2] + d[2] * len];
    const mixk = R.range(0, 1);
    g.tube(cam, [[p0[0], p0[1], p0[2], 0.95], [p1[0], p1[1], p1[2], 0.3]], (t) => {
      const c = mix3(mix3(spineA, spineB, mixk * 0.6), hex('#d9c2e6'), smoothstep(0.7, 1, t) * 0.55);
      return setRGB(m, mul3(c, 0.75 + 0.5 * t), lerp(0.55, 1, t));
    });
  }
  const img = g.resolve({ tint: false, ao: [[1.2, 0.5], [3.5, 0.6]], shadow: [6, 0.4, 0.4] });
  // tucked in a hollow: a soft dark recess painted behind and under the animal
  const hollow = new Img(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cam.ox) / 22;
      const dy = (y + 0.5 - (cam.oy - 5)) / 9.5;
      const a = 0.62 * smoothstep(1, 0.25, Math.hypot(dx, dy));
      if (a <= 0) continue;
      const i = (y * w + x) * 4;
      hollow.d[i] = 0.012 * a;
      hollow.d[i + 1] = 0.014 * a;
      hollow.d[i + 2] = 0.03 * a;
      hollow.d[i + 3] = a;
    }
  over(hollow, img);
  return def([part(hollow, cam.ox, cam.oy)], false);
}

// ---------------------------------------------------------------------------- registry
const BUILDERS = {
  coral_branch: coralBranch,
  coral_table: coralTable,
  coral_fan: coralFan,
  coral_soft: coralSoft,
  grass_tuft: grassTuft,
  coral_brain: coralBrain,
  coral_boulder: coralBoulder,
  coral_encrust: coralEncrust,
  coral_mushroom: coralMushroom,
  coral_fire: coralFire,
  coral_pillar: coralPillar,
  whip,
  sponge_tube: spongeTube,
  sponge_vase: spongeVase,
  hang,
  barnacle,
  weed,
  pebbles,
  shell,
  xmas_worm: xmasWorm,
  urchin_decor: urchinDecor,
};
const COUNTS = { coral_branch: 3, coral_table: 2, coral_brain: 2, coral_boulder: 2, coral_encrust: 2, coral_mushroom: 2, coral_fire: 2, coral_pillar: 2, coral_soft: 3, coral_fan: 3, whip: 2, sponge_tube: 2, sponge_vase: 1, hang: 2, barnacle: 2, grass_tuft: 4, weed: 3, pebbles: 3, shell: 3, xmas_worm: 2, urchin_decor: 1 };

export const IDS = Object.entries(COUNTS).flatMap(([k, n]) => Array.from({ length: n }, (_, i) => `${k}_${i + 1}`));

export function build(id, opts = {}) {
  const m = /^(.*)_(\d+)$/.exec(id);
  const fn = m && BUILDERS[m[1]];
  if (!fn) throw new Error(`Unknown flora sprite ${id}`);
  return fn(id, Number(m[2]), opts.ss ?? 3);
}
