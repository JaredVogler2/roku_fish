/**
 * Channel artwork that lives outside the sprite atlases: splash screens and home-screen icons.
 *
 *   node tools/art/make-brand.mjs
 *
 * Background: tools/art/brand/reef-1280.png, a frame of the channel's own attract scene
 * (captured with `node tools/sim/run.mjs --script=tools/sim/scripts/capture.mjs --args=test=clean`).
 * Output (sizes required by the Roku manifest):
 *   channel/images/splash_fhd.jpg  1920x1080      channel/images/splash_hd.jpg  1280x720
 *   channel/images/icon_focus_fhd.png  540x405    channel/images/icon_focus_hd.png  290x218
 * The loading screen draws splash_hd.jpg again as its background, so the hand-over from the
 * system splash to the channel is seamless.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import sharp from 'sharp';
import { drawLogo } from './ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../channel/images');
fs.mkdirSync(OUT, { recursive: true });
const reef = await loadImage(path.join(HERE, 'brand', 'reef-1280.png'));

function cover(g, img, w, h, zoom = 1, fx = 0.5, fy = 0.5) {
  const k = Math.max(w / img.width, h / img.height) * zoom;
  const dw = img.width * k;
  const dh = img.height * k;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (w - dw) * fx, (h - dh) * fy, dw, dh);
}

function splash(w, h) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  cover(g, reef, w, h);
  // quieten the upper half so the wordmark carries, keep the reef bright along the bottom
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, 'rgba(4,22,43,0.55)');
  gr.addColorStop(0.5, 'rgba(4,22,43,0.38)');
  gr.addColorStop(1, 'rgba(4,22,43,0.12)');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  const vg = g.createRadialGradient(w / 2, h * 0.42, h * 0.2, w / 2, h * 0.5, h * 0.95);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(2,10,24,0.55)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  // wordmark: 760 units wide at scale 1; centred, upper-middle (the loading bar sits under it)
  const s = (w / 1280) * 1.18;
  g.save();
  g.translate(w / 2 - (760 * s) / 2, h * 0.5 - 160 * s);
  drawLogo(g, s, true);
  g.restore();
  return c;
}

function icon(w, h) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  // zoom into the coral garden on the left of the frame
  cover(g, reef, w, h, 1.9, 0.12, 0.62);
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, 'rgba(4,22,43,0.5)');
  gr.addColorStop(0.55, 'rgba(4,22,43,0.2)');
  gr.addColorStop(1, 'rgba(4,22,43,0.05)');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  const s = (w * 0.93) / 760;
  g.save();
  g.translate(w / 2 - (760 * s) / 2, h * 0.36 - 100 * s);
  drawLogo(g, s, true);
  g.restore();
  return c;
}

const jobs = [
  ['splash_fhd.jpg', splash(1920, 1080)],
  ['splash_hd.jpg', splash(1280, 720)],
  ['icon_focus_fhd.png', icon(540, 405)],
  ['icon_focus_hd.png', icon(290, 218)],
];
for (const [name, cv] of jobs) {
  const file = path.join(OUT, name);
  const png = cv.toBuffer('image/png');
  if (name.endsWith('.jpg')) await sharp(png).jpeg({ quality: 86, mozjpeg: true }).toFile(file);
  else await sharp(png).png({ compressionLevel: 9, palette: false }).toFile(file);
  console.log(`${name}  ${cv.width}x${cv.height}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
