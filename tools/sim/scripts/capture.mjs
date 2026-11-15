// A series of frames a few seconds apart (with --args=test=clean: the attract reef without the menu).
export default async function (sim) {
  const name = process.env.SHOT ?? 'cap';
  const n = Number(process.env.FRAMES ?? 8);
  const gap = Number(process.env.GAP ?? 5000);
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(8000);
  for (let i = 1; i <= n; i++) {
    await sim.shot(`${name}-${i}`);
    await sim.wait(gap);
  }
}
