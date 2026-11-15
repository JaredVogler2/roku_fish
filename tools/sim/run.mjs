/**
 * Runs the packaged channel in brs-engine (a BrightScript simulator) under headless Chromium,
 * drives it with remote-control key presses and saves screenshots - the closest thing to a Roku
 * device available on a build machine.
 *
 *   node tools/sim/run.mjs [--zip=dist/reefbound.zip] [--script=tools/sim/scripts/smoke.mjs] [--out=tools/sim/out]
 *
 * A script is an ES module exporting `default async function (sim)`. The `sim` object offers:
 *   sim.wait(ms)              let the channel run
 *   sim.press(key, holdMs)    press and release a remote key ("up","down","left","right","select",
 *                             "back","rev","fwd","info","play","replay")
 *   sim.down(key) / sim.up(key)
 *   sim.shot(name)            save the current frame as <out>/<name>.png
 *   sim.logs()                console output of the channel so far (array of lines)
 *   sim.running()             false once the channel has exited or crashed
 * The process exits non-zero if the channel crashed (so it can gate a build).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const zipPath = path.resolve(ROOT, flag('zip', 'dist/reefbound.zip'));
const scriptPath = path.resolve(ROOT, flag('script', 'tools/sim/scripts/smoke.mjs'));
const outDir = path.resolve(ROOT, flag('out', 'tools/sim/out'));
fs.mkdirSync(outDir, { recursive: true });

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('@playwright/test'));
}
const engineDir = path.dirname(require.resolve('brs-engine/package.json'));
const libDir = path.join(engineDir, 'lib');
const assetsDir = path.join(engineDir, 'assets');

const page_html = `<!doctype html><html><head><meta charset="utf-8"><title>brs</title></head>
<body style="margin:0;background:#000">
<canvas id="display" width="1280" height="720"></canvas>
<video id="player" style="display:none" crossorigin="anonymous"></video>
<div id="stats"></div>
<script src="/lib/brs.api.js"></script>
</body></html>`;
const mime = { '.js': 'text/javascript', '.zip': 'application/zip', '.html': 'text/html' };

/**
 * A Roku tints a sprite per draw call on the GPU, for free. The simulator instead re-colours the
 * WHOLE source bitmap in a JavaScript loop every time the tint differs from the previous draw
 * (one cached copy per bitmap), which turns a scene of a few hundred tinted pieces of a 2048 px
 * atlas into seconds per frame. This swaps that one code path for an equivalent per-sprite tint
 * (multiply, then restore the sprite's alpha), so the pictures are the same and the timing is
 * usable. It only changes how the simulator runs; `--stock-engine` turns it off.
 */
function patchEngine(src) {
  const a = 'function xp(e,t){let r;return r=void 0===t||Number.isNaN(t)||e instanceof fp?e.getCanvas():e.getRgbaCanvas(t),r}';
  const b = 'for(const e of a)f||u.clearRect(e.dx,e.dy,e.dw,e.dh),Gp(u,h,e);';
  if (!src.includes(a) || !src.includes(b)) {
    console.warn('sim: engine layout changed, running it unpatched (tinted scenes will be slow)');
    return src;
  }
  // tinted copies are cached per (bitmap, source rectangle, colour); scenery keeps its colours from
  // frame to frame, so after the first frame a tinted draw costs the same as a plain one. (The cache
  // assumes a bitmap is not redrawn after its first tinted use, which holds for sprite atlases.)
  const helper = `function __gpT(ctx,src,r,tint){if(void 0===tint)return Gp(ctx,src,r);const rgb=tint>>>8&16777215;if(16777215===rgb)return Gp(ctx,src,r);const sw=Math.max(1,Math.ceil(r.sw)),sh=Math.max(1,Math.ceil(r.sh));const G=globalThis;G.__tc||(G.__tc=new Map,G.__tpx=0,G.__cid=0);src.__id||(src.__id=++G.__cid);const key=src.__id+":"+r.sx+","+r.sy+","+sw+","+sh+":"+rgb;let k=G.__tc.get(key);if(!k){k=new OffscreenCanvas(sw,sh);const q=k.getContext("2d");q.drawImage(src,r.sx,r.sy,sw,sh,0,0,sw,sh);q.globalCompositeOperation="multiply";q.fillStyle="rgb("+(rgb>>16&255)+","+(rgb>>8&255)+","+(rgb&255)+")";q.fillRect(0,0,sw,sh);q.globalCompositeOperation="destination-in";q.drawImage(src,r.sx,r.sy,sw,sh,0,0,sw,sh);G.__tc.set(key,k);G.__tpx+=sw*sh;if(G.__tpx>48e6){for(const [ok,ov] of G.__tc){if(G.__tpx<=32e6)break;G.__tpx-=ov.width*ov.height;G.__tc.delete(ok)}}}Gp(ctx,k,{sx:0,sy:0,sw:r.sw,sh:r.sh,dx:r.dx,dy:r.dy,dw:r.dw,dh:r.dh})}`;
  // plain bilinear filtering, like the device's GPU (the engine asks the canvas for "high", which
  // rebuilds a resampled copy of the source for every scaled draw)
  src = src.split('"imageSmoothingQuality"in e&&(e.imageSmoothingQuality="high")').join('"imageSmoothingQuality"in e&&(e.imageSmoothingQuality="low")');
  return src
    .replace(a, `function xp(e,t){globalThis.__tint=void 0===t||Number.isNaN(t)||e instanceof fp?void 0:t;return e.getCanvas()}${helper}`)
    .replace(b, 'for(const e of a)f||u.clearRect(e.dx,e.dy,e.dw,e.dh),__gpT(u,h,e,globalThis.__tint);');
}
// brs-engine needs SharedArrayBuffer, hence the cross-origin isolation headers.
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = null;
  if (u.pathname === '/') {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
    res.end(page_html);
    return;
  }
  if (u.pathname.startsWith('/lib/')) file = path.join(libDir, u.pathname.slice(5));
  else if (u.pathname.startsWith('/assets/')) file = path.join(assetsDir, u.pathname.slice(8));
  else if (u.pathname === '/app.zip') file = zipPath;
  if (file && fs.existsSync(file)) {
    let buf = fs.readFileSync(file);
    if (path.basename(file) === 'brs.worker.js' && !args.includes('--stock-engine')) buf = Buffer.from(patchEngine(buf.toString('utf8')));
    res.writeHead(200, { ...headers, 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  } else {
    res.writeHead(404, headers);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`http://localhost:${port}/`);
await page.evaluate(async () => {
  window.__log = [];
  window.__state = { running: false, exit: null };
  const b = window.brs;
  b.subscribe('harness', (event, data) => {
    if (event === 'debug') {
      const s = String(data?.content ?? data);
      if (s.trim()) window.__log.push(s.replace(/\s+$/, ''));
    } else if (event === 'started') window.__state.running = true;
    else if (event === 'closed') {
      window.__state.running = false;
      window.__state.exit = String(data);
    } else if (event === 'error') window.__log.push('[engine error] ' + String(data));
  });
  await b.initialize({}, { debugToConsole: false });
  // the engine fetches its shared assets (fonts, system sounds) asynchronously
  await new Promise((r) => setTimeout(r, 1500));
  const buf = await (await fetch('/app.zip')).arrayBuffer();
  b.execute('app.zip', buf, { clearDisplayOnExit: false });
});

const sim = {
  wait: (ms) => page.waitForTimeout(ms),
  down: (key) => page.evaluate((k) => window.brs.sendKeyDown(k), key),
  up: (key) => page.evaluate((k) => window.brs.sendKeyUp(k), key),
  async press(key, hold = 80) {
    await sim.down(key);
    await page.waitForTimeout(hold);
    await sim.up(key);
    await page.waitForTimeout(60);
  },
  async shot(name) {
    const data = await page.evaluate(() => {
      const img = window.brs.getScreenshot();
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    });
    if (!data) return null;
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    return file;
  },
  logs: () => page.evaluate(() => window.__log.slice()),
  running: async () => (await page.evaluate(() => window.__state)).running,
  state: () => page.evaluate(() => window.__state),
  outDir,
};

let failed = false;
try {
  const mod = await import(pathToFileURL(scriptPath).href);
  await mod.default(sim);
} catch (e) {
  console.error('script error:', e.message);
  failed = true;
}
const state = await sim.state();
const logs = await sim.logs();
fs.writeFileSync(path.join(outDir, 'console.log'), logs.join('\n'));
const crashed = state.exit && /CRASH/i.test(state.exit);
if (!args.includes('--quiet')) console.log(logs.slice(-Number(flag('tail', 40))).join('\n'));
console.log(`\nchannel state: ${state.running ? 'running' : 'stopped'}${state.exit ? ` (${state.exit})` : ''}${pageErrors.length ? `, page errors: ${pageErrors.join('; ')}` : ''}`);
await browser.close();
server.close();
process.exit(failed || crashed ? 1 : 0);
