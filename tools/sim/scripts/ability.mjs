// Use the ability (Rewind) and take pictures before, during and after.
export default async function (sim) {
  const name = process.env.SHOT ?? 'ability';
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(9000);
  await sim.down('right');
  await sim.wait(1200);
  await sim.up('right');
  await sim.shot(`${name}-1-before`);
  await sim.press('rev');
  await sim.wait(900);
  await sim.shot(`${name}-2-during`);
  await sim.wait(1800);
  await sim.shot(`${name}-3-later`);
  await sim.wait(6000);
  await sim.shot(`${name}-4-after`);
}
