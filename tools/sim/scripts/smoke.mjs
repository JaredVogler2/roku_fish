// First-light check: boot, play a few seconds, take pictures.
export default async function (sim) {
  // wait for the loading to finish (the first frame prints a stats line after two seconds)
  for (let i = 0; i < 60; i++) {
    await sim.wait(1000);
    if ((await sim.logs()).some((l) => l.includes('fps='))) break;
  }
  await sim.wait(1500);
  await sim.shot('01-start');
  await sim.down('right');
  await sim.wait(2500);
  await sim.up('right');
  await sim.shot('02-swim');
  await sim.press('select');
  await sim.wait(3000);
  await sim.shot('03-bite');
}
