/**
 * Interface art: the wordmark, panel corners and the icon set (drawn as vector shapes).
 * Everything except the logo is white so the device can tint it with any colour.
 * These sprites are drawn 1:1 on a 1280x720 screen, so sizes here are final pixel sizes.
 */
import fs from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fromRGBA8 } from './lib/core.mjs';

const FONT_FILE = '/usr/share/fonts/opentype/inter/InterDisplay-Black.otf';
export const LOGO_FONT = fs.existsSync(FONT_FILE) && GlobalFonts.registerFromPath(FONT_FILE, 'ReefLogo') ? 'ReefLogo' : 'sans-serif';

function canvasSprite(w, h, draw, opts = {}) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  draw(g, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  return {
    lenPx: 64,
    anchor: 'center',
    tintable: opts.tintable ?? true,
    parts: [{ img: fromRGBA8(data, w, h), pivot: opts.pivot ?? [Math.round(w / 2), Math.round(h / 2)], at: [0, 0], anim: null }],
  };
}

/** The REEFBOUND wordmark. s = scale (1 = the in-game size, 760 px wide). Also used for the splash. */
export function drawLogo(g, s = 1, withTagline = true) {
  const W = 760 * s;
  g.save();
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  const size = 118 * s;
  g.font = `900 ${size}px ${LOGO_FONT}`;
  const parts = [
    { t: 'REEF', stops: ['#f4ffff', '#a8f3ff', '#3fc4f0'] },
    { t: 'BOUND', stops: ['#fff3c4', '#ffb86a', '#ff6f8f'] },
  ];
  const gap = 4 * s;
  const widths = parts.map((p) => g.measureText(p.t).width);
  const total = widths[0] + widths[1] + gap;
  let x = (W - total) / 2;
  const y = 112 * s;
  // soft glow, then a dark keyline, then the gradient faces
  for (const pass of ['glow', 'line', 'face', 'shine']) {
    let px = x;
    parts.forEach((p, i) => {
      if (pass === 'glow') {
        g.save();
        g.shadowColor = 'rgba(40,190,240,0.55)';
        g.shadowBlur = 26 * s;
        g.fillStyle = 'rgba(8,40,70,0.9)';
        g.fillText(p.t, px, y);
        g.restore();
      } else if (pass === 'line') {
        g.strokeStyle = '#06233d';
        g.lineWidth = 12 * s;
        g.strokeText(p.t, px, y + 3 * s);
        g.strokeText(p.t, px, y);
      } else if (pass === 'face') {
        const gr = g.createLinearGradient(0, y - size * 0.74, 0, y + 4 * s);
        gr.addColorStop(0, p.stops[0]);
        gr.addColorStop(0.5, p.stops[1]);
        gr.addColorStop(1, p.stops[2]);
        g.fillStyle = gr;
        g.fillText(p.t, px, y);
      } else {
        // a band of light across the upper third, like sun through the surface
        g.save();
        g.beginPath();
        g.rect(px - 4, y - size * 0.76, widths[i] + 8, size * 0.3);
        g.clip();
        g.fillStyle = 'rgba(255,255,255,0.33)';
        g.fillText(p.t, px, y);
        g.restore();
      }
      px += widths[i] + gap;
    });
  }
  // bubbles rising off the last letter
  const bx = x + total;
  for (const [dx, dy, r] of [[10, -78, 9], [26, -104, 6], [4, -112, 4], [34, -62, 4.5]]) {
    g.beginPath();
    g.arc(bx + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
    g.fillStyle = 'rgba(200,245,255,0.28)';
    g.fill();
    g.lineWidth = 2 * s;
    g.strokeStyle = 'rgba(230,252,255,0.9)';
    g.stroke();
    g.beginPath();
    g.arc(bx + (dx - r * 0.3) * s, y + (dy - r * 0.3) * s, r * 0.28 * s, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.fill();
  }
  if (withTagline) {
    g.font = `900 ${25 * s}px ${LOGO_FONT}`;
    const tag = 'THE LIVING REEF';
    const sp = 9 * s;
    let tw = 0;
    for (const ch of tag) tw += g.measureText(ch).width + sp;
    let tx = (W - tw + sp) / 2;
    const ty = 158 * s;
    for (const ch of tag) {
      g.lineWidth = 6 * s;
      g.strokeStyle = 'rgba(6,35,61,0.9)';
      g.strokeText(ch, tx, ty);
      g.fillStyle = '#d8f7ff';
      g.fillText(ch, tx, ty);
      tx += g.measureText(ch).width + sp;
    }
  }
  g.restore();
}

const W = '#ffffff';
/** 64x64 icon helper: draw with a white fill/stroke on a transparent background. */
const icon = (draw, size = 64) =>
  canvasSprite(size, size, (g) => {
    g.fillStyle = W;
    g.strokeStyle = W;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 5;
    draw(g, size);
  });
const poly = (g, pts, fill = true) => {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (fill) g.fill();
  else g.stroke();
};
const fishShape = (g, cx, cy, len, flip = 1) => {
  g.beginPath();
  g.ellipse(cx + flip * len * 0.08, cy, len * 0.36, len * 0.2, 0, 0, Math.PI * 2);
  g.fill();
  poly(g, [[cx - flip * len * 0.22, cy], [cx - flip * len * 0.5, cy - len * 0.2], [cx - flip * len * 0.5, cy + len * 0.2]]);
};

const ICONS = {
  ic_heart: (g) => {
    g.beginPath();
    g.moveTo(32, 54);
    g.bezierCurveTo(4, 34, 8, 10, 22, 10);
    g.bezierCurveTo(28, 10, 31, 14, 32, 18);
    g.bezierCurveTo(33, 14, 36, 10, 42, 10);
    g.bezierCurveTo(56, 10, 60, 34, 32, 54);
    g.fill();
  },
  ic_bolt: (g) => poly(g, [[36, 4], [14, 36], [29, 36], [24, 60], [50, 26], [34, 26]]),
  ic_grow: (g) => {
    poly(g, [[32, 6], [52, 28], [40, 28], [40, 46], [24, 46], [24, 28], [12, 28]]);
    g.fillRect(18, 52, 28, 6);
  },
  ic_clean: (g) => {
    g.beginPath();
    g.roundRect(25, 8, 14, 48, 4);
    g.roundRect(8, 25, 48, 14, 4);
    g.fill();
  },
  ic_pass: (g) => {
    g.lineWidth = 6;
    g.beginPath();
    g.arc(32, 32, 22, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(32, 32, 8, 0, Math.PI * 2);
    g.fill();
  },
  ic_alert: (g) => {
    g.lineWidth = 6;
    poly(g, [[32, 8], [58, 54], [6, 54]], false);
    g.fillRect(29, 24, 6, 16);
    g.beginPath();
    g.arc(32, 46, 3.6, 0, Math.PI * 2);
    g.fill();
  },
  ic_sun: (g) => {
    g.beginPath();
    g.arc(32, 32, 12, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 5;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.moveTo(32 + Math.cos(a) * 19, 32 + Math.sin(a) * 19);
      g.lineTo(32 + Math.cos(a) * 27, 32 + Math.sin(a) * 27);
      g.stroke();
    }
  },
  ic_moon: (g) => {
    g.beginPath();
    g.arc(30, 32, 22, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(42, 24, 20, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  },
  ic_dusk: (g) => {
    g.beginPath();
    g.arc(32, 40, 15, Math.PI, 0);
    g.fill();
    g.fillRect(6, 44, 52, 5);
    g.lineWidth = 5;
    for (const a of [-2.6, -2.1, -1.57, -1.04, -0.54]) {
      g.beginPath();
      g.moveTo(32 + Math.cos(a) * 21, 40 + Math.sin(a) * 21);
      g.lineTo(32 + Math.cos(a) * 28, 40 + Math.sin(a) * 28);
      g.stroke();
    }
  },
  ic_fish: (g) => fishShape(g, 32, 32, 54),
  ic_lock: (g) => {
    g.lineWidth = 6;
    g.beginPath();
    g.arc(32, 24, 11, Math.PI, 0);
    g.lineTo(43, 32);
    g.moveTo(21, 24);
    g.lineTo(21, 32);
    g.stroke();
    g.beginPath();
    g.roundRect(14, 30, 36, 26, 5);
    g.fill();
  },
  ic_check: (g) => {
    g.lineWidth = 9;
    g.beginPath();
    g.moveTo(12, 34);
    g.lineTo(26, 48);
    g.lineTo(52, 16);
    g.stroke();
  },
  ic_poison: (g) => {
    g.beginPath();
    g.moveTo(32, 6);
    g.bezierCurveTo(50, 28, 52, 36, 52, 42);
    g.bezierCurveTo(52, 52, 43, 58, 32, 58);
    g.bezierCurveTo(21, 58, 12, 52, 12, 42);
    g.bezierCurveTo(12, 36, 14, 28, 32, 6);
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(25, 40, 4.5, 0, Math.PI * 2);
    g.arc(39, 40, 4.5, 0, Math.PI * 2);
    g.fill();
    g.fillRect(27, 48, 10, 3.5);
    g.globalCompositeOperation = 'source-over';
  },
  ic_hidden: (g) => {
    // seagrass blades: you are in cover
    g.lineWidth = 6;
    for (const [x, bend, top] of [[18, -8, 16], [30, 6, 6], [43, -5, 20]]) {
      g.beginPath();
      g.moveTo(x, 58);
      g.quadraticCurveTo(x + bend, 36, x + bend * 1.6, top);
      g.stroke();
    }
  },
  ic_star: (g) => {
    const p = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const r = i % 2 ? 11 : 26;
      p.push([32 + Math.cos(a) * r, 33 + Math.sin(a) * r]);
    }
    poly(g, p);
  },
  ic_caret: (g) => poly(g, [[20, 10], [48, 32], [20, 54]]),
  // ------------------------------------------------------------------ abilities
  ic_burstsprint: (g) => {
    g.lineWidth = 7;
    for (const x of [14, 28, 42]) {
      g.beginPath();
      g.moveTo(x, 14);
      g.lineTo(x + 14, 32);
      g.lineTo(x, 50);
      g.stroke();
    }
  },
  ic_inkcloud: (g) => {
    for (const [x, y, r] of [[22, 34, 14], [38, 26, 15], [42, 42, 12], [28, 46, 10], [50, 32, 8], [14, 26, 7]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  },
  ic_electricpulse: (g) => {
    g.lineWidth = 4;
    g.beginPath();
    g.arc(32, 32, 26, 0.5, Math.PI - 0.5);
    g.stroke();
    g.beginPath();
    g.arc(32, 32, 26, Math.PI + 0.5, -0.5);
    g.stroke();
    poly(g, [[35, 8], [18, 35], [30, 35], [27, 56], [46, 28], [34, 28]]);
  },
  ic_sonicburst: (g) => {
    g.beginPath();
    g.arc(14, 32, 6, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 6;
    for (const r of [16, 28, 40]) {
      g.beginPath();
      g.arc(14, 32, r, -0.8, 0.8);
      g.stroke();
    }
  },
  ic_sting: (g) => {
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(8, 50);
    g.bezierCurveTo(24, 54, 44, 44, 46, 22);
    g.stroke();
    poly(g, [[46, 4], [56, 26], [36, 26]]);
  },
  ic_inflate: (g) => {
    g.beginPath();
    g.arc(32, 32, 16, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const b = a + 0.16;
      const c = a - 0.16;
      poly(g, [[32 + Math.cos(a) * 29, 32 + Math.sin(a) * 29], [32 + Math.cos(b) * 15, 32 + Math.sin(b) * 15], [32 + Math.cos(c) * 15, 32 + Math.sin(c) * 15]]);
    }
  },
  ic_defensivespines: (g) => {
    for (const a of [-2.5, -2.05, -1.57, -1.09, -0.64]) {
      const bx = 32 + Math.cos(a) * 6;
      const by = 54;
      poly(g, [[32 + Math.cos(a) * 46, 54 + Math.sin(a) * 46], [bx - 5, by], [bx + 5, by]]);
    }
    g.beginPath();
    g.ellipse(32, 54, 26, 6, 0, 0, Math.PI * 2);
    g.fill();
  },
  ic_lure: (g) => {
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(14, 56);
    g.bezierCurveTo(10, 18, 38, 4, 46, 22);
    g.stroke();
    g.beginPath();
    g.arc(46, 30, 8, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 3;
    for (const a of [0.3, 1.1, 1.9, 2.7]) {
      g.beginPath();
      g.moveTo(46 + Math.cos(a) * 12, 30 + Math.sin(a) * 12);
      g.lineTo(46 + Math.cos(a) * 18, 30 + Math.sin(a) * 18);
      g.stroke();
    }
  },
  ic_cleanermimic: (g) => {
    fishShape(g, 30, 36, 52);
    g.globalCompositeOperation = 'destination-out';
    g.fillRect(8, 33.5, 44, 5);
    g.globalCompositeOperation = 'source-over';
    // sparkle
    poly(g, [[52, 4], [55, 13], [63, 16], [55, 19], [52, 28], [49, 19], [41, 16], [49, 13]]);
  },
  ic_camouflage: (g) => {
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(6, 32);
    g.quadraticCurveTo(32, 6, 58, 32);
    g.quadraticCurveTo(32, 58, 6, 32);
    g.stroke();
    g.beginPath();
    g.arc(32, 32, 8, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(12, 54);
    g.lineTo(52, 10);
    g.stroke();
  },
  ic_illuminate: (g) => {
    g.beginPath();
    g.arc(32, 26, 15, 0, Math.PI * 2);
    g.fill();
    g.fillRect(25, 40, 14, 6);
    g.fillRect(27, 49, 10, 5);
    g.lineWidth = 4;
    for (const a of [Math.PI, Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75, 0]) {
      g.beginPath();
      g.moveTo(32 + Math.cos(a) * 20, 26 + Math.sin(a) * 20);
      g.lineTo(32 + Math.cos(a) * 27, 26 + Math.sin(a) * 27);
      g.stroke();
    }
  },
  ic_none: (g) => {
    g.lineWidth = 6;
    g.beginPath();
    g.arc(32, 32, 20, 0, Math.PI * 2);
    g.stroke();
  },
};

const corner = (qx, qy) =>
  canvasSprite(14, 14, (g) => {
    g.fillStyle = W;
    g.beginPath();
    g.arc(qx ? 0 : 14, qy ? 0 : 14, 14, 0, Math.PI * 2);
    g.fill();
  }, { pivot: [0, 0] });

const BUILD = {
  ui_logo: () => canvasSprite(820, 184, (g) => {
    g.translate(30, 0);
    drawLogo(g, 1, true);
  }, { tintable: false }),
  ui_logo_small: () => canvasSprite(400, 70, (g) => {
    g.translate(10, 6);
    drawLogo(g, 0.5, false);
  }, { tintable: false }),
  ui_c_tl: () => corner(false, false),
  ui_c_tr: () => corner(true, false),
  ui_c_bl: () => corner(false, true),
  ui_c_br: () => corner(true, true),
  ui_dot: () => canvasSprite(24, 24, (g) => {
    g.fillStyle = W;
    g.beginPath();
    g.arc(12, 12, 11, 0, Math.PI * 2);
    g.fill();
  }),
  ui_disc: () => canvasSprite(72, 72, (g) => {
    g.fillStyle = W;
    g.beginPath();
    g.arc(36, 36, 35, 0, Math.PI * 2);
    g.fill();
  }),
  ui_ring: () => canvasSprite(72, 72, (g) => {
    g.strokeStyle = W;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(36, 36, 32, 0, Math.PI * 2);
    g.stroke();
  }),
};
for (const [id, fn] of Object.entries(ICONS)) BUILD[id] = () => icon(fn);

export const IDS = Object.keys(BUILD);
export function build(id) {
  const f = BUILD[id];
  if (!f) throw new Error(`Unknown UI sprite ${id}`);
  return f();
}
