/**
 * Core of the offline art renderer: float image buffers, a supersampled "CPU pixel shader"
 * runner, noise, colour maths and file output.
 *
 * Everything is computed in linear light with straight (non-premultiplied) alpha returned by the
 * shader callbacks; buffers store premultiplied linear RGBA so filtering and compositing are
 * correct. Files are written as sRGB with colour bled under transparent pixels, so bilinear
 * scaling on the device never picks up dark fringes.
 */
import sharp from 'sharp';

// ---------------------------------------------------------------------------- maths
export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const fract = (v) => v - Math.floor(v);
export const TAU = Math.PI * 2;
export const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mulc = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------------------- colour
const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const l2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** '#rrggbb' -> linear [r,g,b]. */
export function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [s2l(((n >> 16) & 255) / 255), s2l(((n >> 8) & 255) / 255), s2l((n & 255) / 255)];
}
export function toHex(c) {
  const b = c.map((v) => Math.round(clamp(l2s(clamp(v))) * 255));
  return '#' + b.map((v) => v.toString(16).padStart(2, '0')).join('');
}
/** Scale saturation around luminance. */
export function saturate(c, k) {
  const l = lum(c);
  return [l + (c[0] - l) * k, l + (c[1] - l) * k, l + (c[2] - l) * k];
}
/** Filmic-ish shoulder so highlights roll off instead of clipping. */
export function tone(c) {
  const f = (v) => (v <= 0.6 ? v : 0.6 + (1 - Math.exp(-(v - 0.6) * 2.2)) * 0.4);
  return [f(Math.max(0, c[0])), f(Math.max(0, c[1])), f(Math.max(0, c[2]))];
}

// ---------------------------------------------------------------------------- noise
export function hash2(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** Value noise in [0,1]. `period` > 0 makes it tile. */
export function vnoise(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const w = (i) => (period > 0 ? ((i % period) + period) % period : i);
  const a = hash2(w(xi), w(yi), seed);
  const b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed);
  const d = hash2(w(xi + 1), w(yi + 1), seed);
  const u = fade(xf);
  const v = fade(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, oct = 4, seed = 0, period = 0, gain = 0.5, lac = 2) {
  let s = 0;
  let a = 0.5;
  let n = 0;
  let p = period;
  for (let i = 0; i < oct; i++) {
    s += vnoise(x, y, seed + i * 17, p) * a;
    n += a;
    a *= gain;
    x *= lac;
    y *= lac;
    p *= lac;
  }
  return s / n;
}
/** Worley / cellular noise: distance to nearest and second-nearest feature point + cell id. */
export function worley(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  let px = 0;
  let py = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      let cx = xi + i;
      let cy = yi + j;
      const wx = period > 0 ? ((cx % period) + period) % period : cx;
      const wy = period > 0 ? ((cy % period) + period) % period : cy;
      const ox = hash2(wx, wy, seed);
      const oy = hash2(wx, wy, seed + 91);
      const dx = cx + ox - x;
      const dy = cy + oy - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 7);
        px = cx + ox;
        py = cy + oy;
      } else if (d < f2) f2 = d;
    }
  return { f1, f2, id, px, py };
}
/** Small deterministic PRNG for placement code. */
export function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => Math.floor(a + (b - a + 1) * next());
  next.pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
  next.chance = (p) => next() < p;
  return next;
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------- images
export class Img {
  /** Premultiplied linear RGBA, row-major, y down. */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Float32Array(w * h * 4);
  }
  get(x, y, out) {
    const i = (y * this.w + x) * 4;
    out[0] = this.d[i];
    out[1] = this.d[i + 1];
    out[2] = this.d[i + 2];
    out[3] = this.d[i + 3];
    return out;
  }
  alpha(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.d[(y * this.w + x) * 4 + 3];
  }
  clone() {
    const o = new Img(this.w, this.h);
    o.d.set(this.d);
    return o;
  }
}

/**
 * Run a pixel shader with ss x ss supersampling.
 * fn(x, y, out): x,y are pixel coordinates in the final image (pixel centres at +0.5); write
 * straight-alpha linear colour into out[0..3]. Return false (or leave alpha 0) for empty samples.
 */
export function shade(w, h, ss, fn) {
  const img = new Img(w, h);
  const out = [0, 0, 0, 0];
  const inv = 1 / (ss * ss);
  // Rotated-grid offsets reduce stair-stepping on near-horizontal and near-vertical edges.
  const offs = [];
  for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) offs.push([(i + 0.5 + (j % 2 ? 0.17 : -0.17)) / ss, (j + 0.5 + (i % 2 ? -0.17 : 0.17)) / ss]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < offs.length; k++) {
        out[3] = 0;
        if (fn(x + offs[k][0], y + offs[k][1], out) === false) continue;
        const al = out[3];
        if (al <= 0) continue;
        r += out[0] * al;
        g += out[1] * al;
        b += out[2] * al;
        a += al;
      }
      const i = (y * w + x) * 4;
      img.d[i] = r * inv;
      img.d[i + 1] = g * inv;
      img.d[i + 2] = b * inv;
      img.d[i + 3] = a * inv;
    }
  }
  return img;
}

/** Source-over composite src onto dst at integer offset. */
export function over(dst, src, ox = 0, oy = 0, opacity = 1) {
  for (let y = 0; y < src.h; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= dst.w) continue;
      const si = (y * src.w + x) * 4;
      const sa = src.d[si + 3] * opacity;
      if (sa <= 0) continue;
      const di = (dy * dst.w + dx) * 4;
      const k = 1 - sa;
      dst.d[di] = src.d[si] * opacity + dst.d[di] * k;
      dst.d[di + 1] = src.d[si + 1] * opacity + dst.d[di + 1] * k;
      dst.d[di + 2] = src.d[si + 2] * opacity + dst.d[di + 2] * k;
      dst.d[di + 3] = sa + dst.d[di + 3] * k;
    }
  }
  return dst;
}

/** Bounding box of pixels with alpha above the threshold, or null when empty. */
export function bounds(img, thr = 0.004) {
  let x0 = img.w;
  let y0 = img.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (img.d[(y * img.w + x) * 4 + 3] > thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export function crop(img, x0, y0, w, h) {
  const o = new Img(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= img.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= img.w) continue;
      const si = (sy * img.w + sx) * 4;
      const di = (y * w + x) * 4;
      o.d[di] = img.d[si];
      o.d[di + 1] = img.d[si + 1];
      o.d[di + 2] = img.d[si + 2];
      o.d[di + 3] = img.d[si + 3];
    }
  }
  return o;
}

/** Separable gaussian blur (premultiplied, so edges stay clean). */
export function blur(img, radius) {
  if (radius <= 0) return img.clone();
  const r = Math.ceil(radius * 2.5);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * radius * radius));
    k.push(v);
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Img(img.w, img.h);
  const out = new Img(img.w, img.h);
  const pass = (src, dst, dx, dy) => {
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        let a0 = 0;
        let a1 = 0;
        let a2 = 0;
        let a3 = 0;
        for (let i = -r; i <= r; i++) {
          const sx = Math.min(src.w - 1, Math.max(0, x + i * dx));
          const sy = Math.min(src.h - 1, Math.max(0, y + i * dy));
          const si = (sy * src.w + sx) * 4;
          const w = k[i + r];
          a0 += src.d[si] * w;
          a1 += src.d[si + 1] * w;
          a2 += src.d[si + 2] * w;
          a3 += src.d[si + 3] * w;
        }
        const di = (y * src.w + x) * 4;
        dst.d[di] = a0;
        dst.d[di + 1] = a1;
        dst.d[di + 2] = a2;
        dst.d[di + 3] = a3;
      }
  };
  pass(img, tmp, 1, 0);
  pass(tmp, out, 0, 1);
  return out;
}

/**
 * Convert to 8-bit sRGB RGBA with straight alpha. Fully transparent pixels take the colour of the
 * nearest opaque pixel (a few dilation passes) so filtered sampling has no dark halo.
 */
export function toRGBA8(img, bleed = 6) {
  const { w, h } = img;
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  const has = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = img.d[i * 4 + 3];
    if (a > 1e-4) {
      rgb[i * 3] = img.d[i * 4] / a;
      rgb[i * 3 + 1] = img.d[i * 4 + 1] / a;
      rgb[i * 3 + 2] = img.d[i * 4 + 2] / a;
      has[i] = 1;
    }
  }
  for (let pass = 0; pass < bleed; pass++) {
    const add = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (has[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++) {
            const xx = x + k;
            const yy = y + j;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (!has[q]) continue;
            r += rgb[q * 3];
            g += rgb[q * 3 + 1];
            b += rgb[q * 3 + 2];
            c++;
          }
        if (c) add.push(i, r / c, g / c, b / c);
      }
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k];
      rgb[i * 3] = add[k + 1];
      rgb[i * 3 + 1] = add[k + 2];
      rgb[i * 3 + 2] = add[k + 3];
      has[i] = 1;
    }
    if (!add.length) break;
  }
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(clamp(l2s(clamp(rgb[i * 3]))) * 255);
    out[i * 4 + 1] = Math.round(clamp(l2s(clamp(rgb[i * 3 + 1]))) * 255);
    out[i * 4 + 2] = Math.round(clamp(l2s(clamp(rgb[i * 3 + 2]))) * 255);
    out[i * 4 + 3] = Math.round(clamp(img.d[i * 4 + 3]) * 255);
  }
  return out;
}

/** Build an Img from 8-bit sRGB straight-alpha RGBA (e.g. a canvas readback). */
export function fromRGBA8(buf, w, h) {
  const img = new Img(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = buf[i * 4 + 3] / 255;
    img.d[i * 4] = s2l(buf[i * 4] / 255) * a;
    img.d[i * 4 + 1] = s2l(buf[i * 4 + 1] / 255) * a;
    img.d[i * 4 + 2] = s2l(buf[i * 4 + 2] / 255) * a;
    img.d[i * 4 + 3] = a;
  }
  return img;
}

export async function savePng(img, file) {
  await sharp(toRGBA8(img), { raw: { width: img.w, height: img.h, channels: 4 } }).png({ compressionLevel: 9 }).toFile(file);
}

/** Lossy WebP with a lossless alpha plane; `exact` keeps the bled colour under transparent pixels. */
export async function saveWebp(img, file, quality = 82, opts = {}) {
  await sharp(toRGBA8(img), { raw: { width: img.w, height: img.h, channels: 4 } })
    .webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true, exact: true, ...opts })
    .toFile(file);
}

export async function saveJpeg(img, file, quality = 84) {
  // Opaque output: composite on black first.
  const buf = toRGBA8(img, 0);
  await sharp(buf, { raw: { width: img.w, height: img.h, channels: 4 } }).flatten({ background: '#000000' }).jpeg({ quality, mozjpeg: true }).toFile(file);
}

/** Paste several images on a dark checker for review sheets. Returns an Img. */
export function contactSheet(items, cols, cell, bg = [0.02, 0.09, 0.16]) {
  const rows = Math.ceil(items.length / cols);
  const sheet = new Img(cols * cell.w, rows * cell.h);
  for (let y = 0; y < sheet.h; y++)
    for (let x = 0; x < sheet.w; x++) {
      const i = (y * sheet.w + x) * 4;
      const t = y / sheet.h;
      const c = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 1 : 0.92;
      sheet.d[i] = (bg[0] + t * 0.02) * c;
      sheet.d[i + 1] = (bg[1] + (1 - t) * 0.1) * c;
      sheet.d[i + 2] = (bg[2] + (1 - t) * 0.16) * c;
      sheet.d[i + 3] = 1;
    }
  items.forEach((it, k) => {
    const cx = (k % cols) * cell.w;
    const cy = Math.floor(k / cols) * cell.h;
    over(sheet, it, cx + Math.floor((cell.w - it.w) / 2), cy + Math.floor((cell.h - it.h) / 2));
  });
  return sheet;
}
