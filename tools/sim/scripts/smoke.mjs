// Smoke test: boot to the menu, start Reef Ascension, swim, bite, pause, resume.
// Fails (throws) if the channel stops or never reaches the menu.
export default async function (sim) {
  let loaded = false;
  for (let i = 0; i < 120 && !loaded; i++) {
    await sim.wait(500);
    loaded = (await sim.logs()).some((l) => l.includes('gfx detail'));
  }
  if (!loaded) throw new Error('the channel did not start');
  await sim.wait(9000);
  await sim.shot('smoke-1-menu');
  // a first launch focuses the tutorial row; two downs wrap to "Play - Reef Ascension"
  await sim.press('down');
  await sim.press('down');
  await sim.press('ok');
  await sim.wait(1000);
  await sim.press('down');
  await sim.press('ok');
  await sim.wait(4500);
  await sim.down('right');
  await sim.wait(2000);
  await sim.up('right');
  await sim.press('ok');
  await sim.wait(2500);
  await sim.shot('smoke-2-play');
  await sim.press('play');
  await sim.wait(600);
  await sim.shot('smoke-3-pause');
  await sim.press('ok');
  await sim.wait(800);
  if (!(await sim.running())) throw new Error('the channel stopped during the smoke test');
}
