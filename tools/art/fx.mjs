/**
 * Effects, light and indicator sprites: gradients, glows, light shafts, particles, the risk
 * rings around creatures and the distant reef silhouettes. Almost all are white shapes that the
 * device tints and fades, so one sprite serves many colours.
 */
import { createCanvas } from '@napi-rs/canvas';
import { Img, shade, fromRGBA8, clamp, lerp, smoothstep, fbm, vnoise, worley, hash2, TAU } from './lib/core.mjs';

const W = [1, 1, 1];
const one = (img, pivot = null, extra = {}) => ({
  lenPx: 96,
  anchor: 'center',
  tintable: true,
  parts: [{ img, pivot: pivot ?? [img.w / 2, img.h / 2], at: [0, 0], anim: null }],
  ...extra,
});
const put = (out, a, c = W) => {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  out[3] = clamp(a);
  return a > 0.002;
};

/** Ring of radius r (0..1 of half size) and thickness th, soft edges. */
const ringA = (d, r, th, soft = 0.012) => smoothstep(th / 2 + soft, th / 2 - soft, Math.abs(d - r));

function glyph(text, size, px = 96) {
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${px}px Inter, "DejaVu Sans", sans-serif`;
  g.fillText(text, size / 2, size / 2 + px * 0.04);
  return fromRGBA8(g.getImageData(0, 0, size, size).data, size, size);
}

const BUILD = {
  // vertical alpha ramp: 0 at the top, 1 at the bottom (water gradient overlay)
  fx_grad: () => one(shade(16, 256, 1, (x, y, o) => put(o, Math.pow(y / 256, 1.15))), [0, 0]),
  fx_glow: () => one(shade(128, 128, 2, (x, y, o) => {
    const d = Math.hypot(x - 64, y - 64) / 64;
    return put(o, Math.pow(clamp(1 - d), 2.2));
  })),
  // a soft slanted beam, bright near the surface and dissolving with depth
  fx_shaft: () => one(shade(256, 512, 2, (x, y, o) => {
    const v = y / 512;
    const cx = 60 + v * 130;
    const half = 22 + v * 46;
    const d = Math.abs(x - cx) / half;
    const streak = 0.75 + 0.25 * Math.sin((x - v * 130) * 0.21) * Math.sin((x - v * 130) * 0.057 + 1.3);
    const a = Math.pow(clamp(1 - d), 1.6) * streak * smoothstep(1.0, 0.25, v) * smoothstep(0.0, 0.06, v) * 0.62;
    return put(o, a);
  }), [0, 0]),
  fx_mote: () => one(shade(16, 16, 3, (x, y, o) => put(o, Math.pow(clamp(1 - Math.hypot(x - 8, y - 8) / 7), 1.6)))),
  fx_bubble: () => one(shade(40, 40, 3, (x, y, o) => {
    const d = Math.hypot(x - 20, y - 20) / 17;
    let a = ringA(d, 0.9, 0.16, 0.05) * 0.85 + smoothstep(1.0, 0.0, d) * 0.1 * (d < 1 ? 1 : 0);
    const h = Math.hypot(x - 14, y - 13) / 5;
    a += clamp(1 - h) * 0.9;
    return put(o, a);
  })),
  // a puffy cloud (ink); the device tints it dark and layers three of them
  fx_ink: () => one(shade(128, 128, 2, (x, y, o) => {
    const dx = (x - 64) / 64;
    const dy = (y - 64) / 64;
    const d = Math.hypot(dx, dy);
    const n = fbm(x * 0.035 + 3, y * 0.035 + 7, 4, 11);
    const edge = 0.62 + (n - 0.5) * 0.7;
    return put(o, smoothstep(edge + 0.22, edge - 0.25, d) * (0.82 + 0.18 * n));
  })),
  fx_wave: () => one(shade(128, 128, 2, (x, y, o) => {
    const d = Math.hypot(x - 64, y - 64) / 64;
    return put(o, ringA(d, 0.86, 0.1, 0.04) + ringA(d, 0.66, 0.035, 0.03) * 0.45);
  })),
  fx_zap: () => one(shade(128, 128, 2, (x, y, o) => {
    const dx = x - 64;
    const dy = y - 64;
    const d = Math.hypot(dx, dy) / 64;
    const ang = Math.atan2(dy, dx);
    let a = 0;
    for (let k = 0; k < 7; k++) {
      const a0 = (k / 7) * TAU + 0.3;
      const jag = Math.sin(d * 21 + k * 2.1) * 0.13 * d;
      let da = Math.abs(((ang - a0 - jag + Math.PI * 3) % TAU) - Math.PI);
      a = Math.max(a, smoothstep(0.085, 0.015, da * d) * smoothstep(1.0, 0.75, d) * smoothstep(0.12, 0.22, d));
    }
    a = Math.max(a, Math.pow(clamp(1 - d / 0.3), 2));
    return put(o, a);
  })),
  fx_sparkle: () => one(shade(48, 48, 3, (x, y, o) => {
    const dx = Math.abs(x - 24) / 24;
    const dy = Math.abs(y - 24) / 24;
    const star = Math.max(clamp(1 - dx * 1.05) * clamp(1 - dy * 9), clamp(1 - dy * 1.05) * clamp(1 - dx * 9));
    return put(o, Math.pow(star, 0.8) + Math.pow(clamp(1 - Math.hypot(dx, dy) * 2.6), 2));
  })),
  fx_chomp: () => one(shade(128, 128, 2, (x, y, o) => {
    const dx = x - 64;
    const dy = y - 64;
    const d = Math.hypot(dx, dy) / 64;
    const ang = Math.atan2(dy, dx);
    const rays = Math.pow(Math.abs(Math.sin(ang * 6 + 0.4)), 5);
    return put(o, rays * smoothstep(0.3, 0.5, d) * smoothstep(1.0, 0.7, d) * 0.95);
  })),
  // reef pass: a swirl of current
  fx_pass: () => one(shade(256, 256, 2, (x, y, o) => {
    const dx = x - 128;
    const dy = y - 128;
    const d = Math.hypot(dx, dy) / 128;
    const ang = Math.atan2(dy, dx);
    const sw = 0.5 + 0.5 * Math.sin(ang * 3 + d * 9);
    const a = ringA(d, 0.86, 0.07, 0.03) * 0.9 + smoothstep(0.92, 0.3, d) * smoothstep(0.1, 0.5, d) * sw * 0.42 + Math.pow(clamp(1 - d), 2) * 0.25;
    return put(o, a);
  })),
  // dark corners; drawn stretched over the whole screen
  fx_vignette: () => one(shade(320, 180, 1, (x, y, o) => {
    const dx = (x - 160) / 160;
    const dy = (y - 90) / 90;
    const d = Math.sqrt(dx * dx * 0.85 + dy * dy);
    return put(o, Math.pow(smoothstep(0.55, 1.25, d), 1.5) * 0.62);
  }), [0, 0]),
  fx_arrow: () => one(shade(64, 64, 3, (x, y, o) => {
    // chevron pointing right
    const px = (x - 32) / 26;
    const py = Math.abs(y - 32) / 26;
    const a = smoothstep(0.02, -0.02, px + py - 0.72) * smoothstep(-0.02, 0.02, px + py - 0.28) * smoothstep(1.0, 0.92, py);
    return put(o, a);
  })),
  fx_shadow: () => one(shade(128, 48, 2, (x, y, o) => put(o, Math.pow(clamp(1 - Math.hypot((x - 64) / 64, (y - 24) / 24)), 1.4) * 0.8))),
  // dark, soft-edged cave interior (stretched to the cave's inner box)
  fx_cave: () => one(shade(128, 128, 2, (x, y, o) => {
    const dx = Math.abs(x - 64) / 64;
    const dy = Math.abs(y - 64) / 64;
    const d = Math.max(dx, dy);
    return put(o, smoothstep(1.0, 0.82, d) * (0.9 + 0.1 * fbm(x * 0.06, y * 0.06, 3, 5)));
  }), [0, 0]),
  // gradient that darkens toward the closed end of a cave (drawn over creatures inside)
  fx_cavefade: () => one(shade(128, 64, 1, (x, y, o) => put(o, Math.pow(1 - x / 128, 1.3) * 0.85 * smoothstep(0, 10, y) * smoothstep(64, 54, y))), [0, 0]),

  // ---- risk rings (shape as well as colour, for colour-blind players)
  ring_edible: () => one(shade(128, 128, 3, (x, y, o) => put(o, ringA(Math.hypot(x - 64, y - 64) / 64, 0.86, 0.075)))),
  ring_player: () => one(shade(128, 128, 2, (x, y, o) => {
    const d = Math.hypot(x - 64, y - 64) / 64;
    return put(o, ringA(d, 0.82, 0.05, 0.05) * 0.9 + smoothstep(0.82, 0.5, d) * smoothstep(0.3, 0.8, d) * 0.12);
  })),
  ring_risky: () => one(shade(128, 128, 3, (x, y, o) => {
    const dx = x - 64;
    const dy = y - 64;
    const d = Math.hypot(dx, dy) / 64;
    let a = ringA(d, 0.8, 0.07);
    // three small triangles pointing outward
    for (let k = 0; k < 3; k++) {
      const a0 = (k / 3) * TAU - Math.PI / 2;
      const rx = (dx * Math.cos(a0) + dy * Math.sin(a0)) / 64;
      const ry = Math.abs(-dx * Math.sin(a0) + dy * Math.cos(a0)) / 64;
      a = Math.max(a, smoothstep(0.01, -0.01, ry - (0.99 - rx) * 0.75) * smoothstep(0.78, 0.8, rx) * smoothstep(1.0, 0.98, rx));
    }
    return put(o, a);
  })),
  ring_danger: () => one(shade(128, 128, 3, (x, y, o) => {
    const dx = x - 64;
    const dy = y - 64;
    const d = Math.hypot(dx, dy) / 64;
    const ang = Math.atan2(dy, dx);
    const spike = Math.pow(Math.abs(Math.cos(ang * 6)), 6) * 0.19;
    return put(o, Math.max(ringA(d, 0.72, 0.075), smoothstep(0.012, -0.012, d - 0.76 - spike) * smoothstep(0.74, 0.76, d)));
  })),
  ring_neutral: () => one(shade(128, 128, 3, (x, y, o) => {
    const dx = x - 64;
    const dy = y - 64;
    const dash = smoothstep(0.35, 0.45, Math.abs(Math.sin(Math.atan2(dy, dx) * 8)));
    return put(o, ringA(Math.hypot(dx, dy) / 64, 0.84, 0.06) * dash);
  })),
  ring_unknown: () => {
    const g = glyph('?', 128, 50);
    const img = shade(128, 128, 3, (x, y, o) => {
      const dx = x - 64;
      const dy = y - 64;
      const dash = smoothstep(0.2, 0.35, Math.abs(Math.sin(Math.atan2(dy, dx) * 5)));
      const a = ringA(Math.hypot(dx, dy) / 64, 0.84, 0.06) * dash;
      // the "?" sits on the ring at the top right so it does not hide the creature
      const gx = Math.round(x - 40);
      const gy = Math.round(y + 40);
      return put(o, Math.max(a, g.alpha(gx, gy)));
    });
    return one(img);
  },
  ring_target: () => one(shade(128, 128, 3, (x, y, o) => {
    const dx = x - 64;
    const dy = y - 64;
    const d = Math.hypot(dx, dy) / 64;
    const ang = Math.atan2(dy, dx);
    // four brackets
    const gap = smoothstep(0.5, 0.62, Math.abs(Math.sin(ang * 2)));
    const tick = smoothstep(0.03, 0.012, Math.abs(Math.sin(ang * 2 + Math.PI / 2)) * d) * smoothstep(0.78, 0.82, d) * smoothstep(1.0, 0.97, d);
    return put(o, Math.max(ringA(d, 0.9, 0.085) * (1 - gap), tick * 0));
  })),
  ring_threat: () => one(shade(128, 128, 3, (x, y, o) => {
    const d = Math.hypot(x - 64, y - 64) / 64;
    return put(o, Math.max(ringA(d, 0.9, 0.07), ringA(d, 0.72, 0.045) * 0.75));
  })),
  fx_marker: () => one(shade(128, 128, 3, (x, y, o) => {
    const d = Math.hypot(x - 64, y - 64) / 64;
    return put(o, ringA(d, 0.84, 0.09, 0.03) + Math.pow(clamp(1 - d / 0.8), 1.5) * 0.3);
  })),

  // ---- distant reef silhouettes (tile horizontally; solid below the skyline)
  bg_ridge_far: () => ridge(1024, 256, 3, 0.55),
  bg_ridge_near: () => ridge(1024, 300, 9, 0.8),
};

function ridge(w, h, seed, rough) {
  const sky = (x) => {
    const u = x / w;
    let y = 0;
    y += Math.sin(u * TAU * 1 + seed) * 0.16;
    y += Math.sin(u * TAU * 2 + seed * 2.3) * 0.11;
    y += Math.sin(u * TAU * 5 + seed * 0.7) * 0.05 * rough;
    y += (fbm(u * 12, seed, 4, seed, 12) - 0.5) * 0.3 * rough;
    return h * (0.42 - y * 0.75);
  };
  // coral-like bumps along the skyline
  const bump = (x) => {
    let b = 0;
    for (let k = 0; k < 26; k++) {
      const cx = hash2(k, 1, seed) * w;
      const r = 10 + hash2(k, 2, seed) * 26 * rough;
      let dx = Math.abs(x - cx);
      dx = Math.min(dx, w - dx);
      if (dx < r) b = Math.max(b, Math.sqrt(r * r - dx * dx) * (0.5 + hash2(k, 3, seed) * 0.6));
    }
    return b;
  };
  const img = shade(w, h, 2, (x, y, o) => {
    const top = sky(x) - bump(x);
    const d = y - top;
    if (d < -1) return false;
    // brighter rim along the skyline, darker toward the base: reads as lit from above
    const v = clamp(0.62 + 0.38 * Math.exp(-Math.max(0, d) / 26) - 0.22 * clamp(d / h));
    return put(o, smoothstep(-1, 1, d), [v, v, v]);
  });
  return { lenPx: 96, anchor: 'center', tintable: true, parts: [{ img, pivot: [0, Math.round(h * 0.5)], at: [0, 0], anim: null }] };
}

export const IDS = Object.keys(BUILD);
export function build(id) {
  const f = BUILD[id];
  if (!f) throw new Error(`Unknown fx sprite ${id}`);
  return f();
}
