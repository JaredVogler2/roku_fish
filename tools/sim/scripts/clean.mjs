// Cleaning station check: get hurt (test=hurt), swim to the day station in the Sun Garden, hold still.
// Run with --args=mode=practice,species=neonDamsel,test=hurt,trace=1 and read the trace lines.
export default async function (sim) {
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(11000);
  await sim.shot('clean-1-hurt');
  // station at (37.9, 29.9); the fish starts near (28, 33)
  const where = async () => {
    const t = (await sim.logs()).filter((l) => l.startsWith('trace')).pop() ?? '';
    const m = t.match(/p=\(\s*([\d.]+),\s*([\d.]+)\)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  for (let step = 0; step < 40; step++) {
    const p = await where();
    if (!p) break;
    const dx = 37.9 - p[0];
    const dy = 30.6 - p[1];
    if (Math.abs(dx) < 0.7 && Math.abs(dy) < 0.7) break;
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'up' : 'down';
    await sim.down(key);
    await sim.wait(350);
    await sim.up(key);
    await sim.wait(750);
  }
  await sim.shot('clean-2-arrived');
  await sim.wait(9000);
  await sim.shot('clean-3-after');
}
