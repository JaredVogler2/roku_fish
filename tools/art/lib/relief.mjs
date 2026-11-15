/**
 * Height-field renderer for stone, sand and other solid scenery.
 *
 * A piece is described by a sampler that returns, for any point, how far inside the outline it
 * is, its height (px, toward the viewer) and its albedo. The renderer then does what a 3D
 * renderer would: normals from the height field, ambient occlusion from how far a point sits
 * below its surroundings, and soft cast shadows marched toward the key light. That gives lit
 * tops, shadowed undersides and dark crevices - depth the device only has to blit.
 *
 * The sampler is also evaluated in a margin outside the image, so a piece that tiles or joins a
 * neighbour (three-slice caps and middles) is shaded as part of the larger shape and has no seam.
 */
import { Img, clamp, smoothstep, tone } from './core.mjs';
import { KEY, KEY_COL, SKY, GROUND, RIM } from './light.mjs';

const PLANAR = Math.hypot(KEY[0], KEY[1]);
const LX = KEY[0] / PLANAR; // toward the light, image space (y down)
const LY = -KEY[1] / PLANAR;
const SLOPE = KEY[2] / PLANAR; // rise of a light ray per pixel travelled in the image plane

/**
 * @param w,h     output size in px
 * @param sample  (x, y, out) => boolean. Write out.d (px inside the outline, negative outside),
 *                out.h (height px), out.a (albedo 0..1), out.t (warm/cool shift, about -0.1..0.1),
 *                out.g (gloss 0..1), out.al (extra opacity 0..1). Return false when the point is
 *                well outside.
 * @param o       ss supersampling, pad margin px, aoR/aoK occlusion radius and strength,
 *                shadow length px, shadowK darkness of cast shadows, relief normal strength,
 *                softEdge px over which the outline fades in (0 = crisp), gain brightness,
 *                ambient / key light scales, dust (pale sediment on faces that look up)
 */
export function reliefRender(w, h, sample, o = {}) {
  const ss = o.ss ?? 2;
  const pad = o.pad ?? 40;
  const aoR = (o.aoR ?? 9) * ss;
  const aoK = o.aoK ?? 0.055;
  const shLen = (o.shadow ?? 44) * ss;
  const shK = o.shadowK ?? 0.78;
  const nk = o.relief ?? 1;
  const ambK = o.ambient ?? 0.92;
  const keyK = o.key ?? 1;
  const dust = o.dust ?? 0;
  const W = (w + pad * 2) * ss;
  const H = (h + pad * 2) * ss;
  const hb = new Float32Array(W * H);
  const db = new Float32Array(W * H).fill(-9);
  const ab = new Float32Array(W * H);
  const tb = new Float32Array(W * H);
  const gb = new Float32Array(W * H);
  const lb = new Float32Array(W * H);
  const soft = o.softEdge ?? 0;
  const out = { d: 0, h: 0, a: 0.8, t: 0, g: 0, al: 1 };
  for (let j = 0; j < H; j++) {
    const y = (j + 0.5) / ss - pad;
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) / ss - pad;
      out.t = 0;
      out.g = 0;
      out.al = 1;
      if (sample(x, y, out) === false) continue;
      const k = j * W + i;
      db[k] = out.d;
      hb[k] = out.d > 0 ? out.h : 0;
      ab[k] = out.a;
      tb[k] = out.t;
      gb[k] = out.g;
      lb[k] = out.al;
    }
  }
  // occlusion: compare each point with the average height around it (two box passes ~ gaussian)
  const blurH = boxBlur(boxBlur(hb, W, H, aoR), W, H, aoR);
  const img = new Img(w, h);
  const inv = 1 / (ss * ss);
  const stepPx = 1.5;
  const steps = Math.ceil(shLen / stepPx);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const i = (px + pad) * ss + si;
          const j = (py + pad) * ss + sj;
          const k = j * W + i;
          const d = db[k];
          if (d <= -1) continue;
          const al = (soft > 0 ? smoothstep(0, soft, d) : smoothstep(-1, 1, d)) * lb[k];
          if (al <= 0) continue;
          const h0 = hb[k];
          // normal (image y is down, the normal's y is up)
          const gx = (hb[k + 1] - hb[k - 1]) * 0.5 * ss;
          const gy = (hb[k + W] - hb[k - W]) * 0.5 * ss;
          let nx = -gx * nk;
          let ny = gy * nk;
          const nl = Math.hypot(nx, ny, 1);
          nx /= nl;
          ny /= nl;
          const nz = 1 / nl;
          const ao = clamp(1 - Math.max(0, blurH[k] - h0) * aoK, 0.25, 1);
          // soft cast shadow
          let lit = 1;
          for (let s = 1; s <= steps; s++) {
            const t = s * stepPx;
            const xi = Math.round(i + LX * t);
            const yi = Math.round(j + LY * t);
            if (xi < 0 || yi < 0 || xi >= W || yi >= H) break;
            const tp = t / ss; // px
            const clear = h0 + tp * SLOPE - hb[yi * W + xi];
            const pen = clear / (tp * 0.34) + 0.35;
            if (pen < lit) {
              lit = pen;
              if (lit <= 0) {
                lit = 0;
                break;
              }
            }
          }
          lit = 1 - shK * (1 - smoothstep(0, 1, lit));
          const ndl = clamp((nx * KEY[0] + ny * KEY[1] + nz * KEY[2] + 0.18) / 1.18);
          const hemi = ny * 0.5 + 0.5;
          const kd = ndl * lit * (0.6 + 0.4 * ao) * keyK;
          const alb = ab[k] * (1 + dust * Math.max(0, ny));
          const tw = tb[k];
          const ar = alb * (1 + tw);
          const ag = alb;
          const abl = alb * (1 - tw);
          let cr = ar * (KEY_COL[0] * kd + (GROUND[0] + (SKY[0] - GROUND[0]) * hemi) * ao * ambK);
          let cg = ag * (KEY_COL[1] * kd + (GROUND[1] + (SKY[1] - GROUND[1]) * hemi) * ao * ambK);
          let cb = abl * (KEY_COL[2] * kd + (GROUND[2] + (SKY[2] - GROUND[2]) * hemi) * ao * ambK);
          // wet glint on faces turned to the light, cool rim on faces turned away from the viewer
          const gl = gb[k];
          if (gl > 0) {
            const hx = KEY[0];
            const hy = KEY[1];
            const hz = KEY[2] + 1;
            const hl = Math.hypot(hx, hy, hz);
            const ndh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl);
            const sp = Math.pow(ndh, 40) * gl * lit;
            cr += sp;
            cg += sp;
            cb += sp * 0.95;
          }
          const fres = Math.pow(1 - nz, 2.6) * (0.06 + 0.2 * clamp(hemi)) * ao;
          cr += RIM[0] * fres;
          cg += RIM[1] * fres;
          cb += RIM[2] * fres;
          r += cr * al;
          g += cg * al;
          b += cb * al;
          a += al;
        }
      }
      const k4 = (py * w + px) * 4;
      if (a > 0) {
        const c = tone([(r / a) * (o.gain ?? 1), (g / a) * (o.gain ?? 1), (b / a) * (o.gain ?? 1)]);
        const al = a * inv;
        img.d[k4] = c[0] * al;
        img.d[k4 + 1] = c[1] * al;
        img.d[k4 + 2] = c[2] * al;
        img.d[k4 + 3] = al;
      }
    }
  }
  return img;
}

function boxBlur(src, W, H, r) {
  r = Math.max(1, Math.round(r));
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);
  const n = r * 2 + 1;
  for (let y = 0; y < H; y++) {
    let s = 0;
    const row = y * W;
    for (let i = -r; i <= r; i++) s += src[row + clamp(i, 0, W - 1)];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[clamp(i, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      dst[y * W + x] = s / n;
      s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return dst;
}

/** Polynomial smooth maximum (k = blend width in the same units as a and b). */
export function smax(a, b, k) {
  const hh = clamp(0.5 + (0.5 * (a - b)) / k);
  return b + (a - b) * hh + k * hh * (1 - hh);
}
