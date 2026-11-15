// Soak test: play badly but busily for a while and make sure nothing crashes.
// SOAK_SECONDS (default 60) sets the length, SOAK_NAME prefixes the screenshots.
// Use with --args=mode=... to start straight in a mode.
export default async function (sim) {
  const seconds = Number(process.env.SOAK_SECONDS ?? 60);
  const name = process.env.SOAK_NAME ?? 'soak';
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(7000);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const dirs = ['left', 'right', 'up', 'down'];
  const t0 = Date.now();
  let shot = 0;
  let held = [];
  while ((Date.now() - t0) / 1000 < seconds) {
    if (!(await sim.running())) break;
    for (const k of held) await sim.up(k);
    held = [];
    const d = dirs[Math.floor(rnd() * 4)];
    held.push(d);
    if (rnd() < 0.4) held.push(dirs[Math.floor(rnd() * 4)]);
    if (rnd() < 0.3) held.push('fwd');
    for (const k of held) await sim.down(k);
    await sim.wait(500 + rnd() * 1400);
    const r = rnd();
    if (r < 0.55) await sim.press('ok');
    else if (r < 0.7) await sim.press('rev');
    else if (r < 0.8) await sim.press('replay');
    else if (r < 0.86) await sim.press('info');
    if ((Date.now() - t0) / 1000 > (shot + 1) * (seconds / 4)) {
      shot++;
      await sim.shot(`${name}-${shot}`);
    }
  }
  for (const k of held) await sim.up(k);
  await sim.shot(`${name}-end`);
}
