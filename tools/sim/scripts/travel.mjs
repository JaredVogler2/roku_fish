// Reef pass check: swim to a pass and confirm the region changes.
// Run with --args=mode=practice,species=rainbowRunner,trace=1 (Practice has every pass open).
// TARGET=x,y sets the pass position (default: the Lagoon Reef's pass to the Outer Wall).
export default async function (sim) {
  const [tx, ty] = (process.env.TARGET ?? '71,33.5').split(',').map(Number);
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(9000);
  const state = async () => {
    const t = (await sim.logs()).filter((l) => l.startsWith('trace')).pop() ?? '';
    const m = t.match(/reg=\s*(\w+)\s+p=\(\s*([\d.]+),\s*([\d.]+)\)/);
    return m ? { reg: m[1], x: Number(m[2]), y: Number(m[3]) } : null;
  };
  const start = await state();
  console.log('start', JSON.stringify(start));
  let held = null;
  let last = start;
  for (let step = 0; step < 150; step++) {
    const s = await state();
    if (!s) break;
    last = s;
    if (s.reg !== start.reg) break;
    let dx = tx - s.x;
    if (dx > 36) dx -= 72;
    if (dx < -36) dx += 72;
    const dy = ty - s.y;
    const key = Math.abs(dx) > Math.abs(dy) * 1.2 ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'up' : 'down';
    if (key !== held) {
      if (held) await sim.up(held);
      await sim.down(key);
      held = key;
    }
    await sim.wait(500);
  }
  if (held) await sim.up(held);
  await sim.wait(2500);
  const end = await state();
  console.log('end', JSON.stringify(end));
  await sim.shot('travel-arrived');
  if (!end || end.reg === start.reg) throw new Error(`did not travel (last position ${JSON.stringify(last)})`);
}
