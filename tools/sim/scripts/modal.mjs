// Screens that need a situation: run with --args=mode=...,test=upgrade|death|stage
export default async function (sim) {
  const name = process.env.SHOT ?? 'modal';
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(13000);
  await sim.shot(`${name}-1`);
  await sim.press('right');
  await sim.wait(400);
  await sim.press('ok');
  await sim.wait(3500);
  await sim.shot(`${name}-2`);
  // leave through the pause menu to see the summary
  await sim.press('play');
  await sim.wait(600);
  await sim.press('up');
  await sim.wait(300);
  await sim.shot(`${name}-3`);
  await sim.press('ok');
  await sim.wait(1500);
  await sim.shot(`${name}-4`);
  await sim.press('ok');
  await sim.wait(1000);
  await sim.shot(`${name}-5`);
}
