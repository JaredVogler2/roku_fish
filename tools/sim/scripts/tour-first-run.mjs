// Walk through the menus and a short run, taking a picture of each screen.
export default async function (sim) {
  const waitFor = async (text, max = 90) => {
    for (let i = 0; i < max; i++) {
      await sim.wait(500);
      if (!(await sim.running()) && i > 4) return false;
      if ((await sim.logs()).some((l) => l.includes(text))) return true;
    }
    return false;
  };
  await waitFor('gfx detail');
  await sim.wait(9000);
  await sim.shot('10-menu');
  // Reef Ascension setup
  await sim.press('down');
  await sim.press('down');
  await sim.wait(300);
  await sim.shot('11-menu-top');
  await sim.press('select');
  await sim.wait(1200);
  await sim.shot('12-ascension-setup');
  await sim.press('down');
  await sim.press('select');
  await sim.wait(5000);
  await sim.shot('13-game-start');
  await sim.down('right');
  await sim.wait(2200);
  await sim.up('right');
  await sim.press('select');
  await sim.wait(2500);
  await sim.shot('14-game-chase');
  await sim.press('replay');
  await sim.wait(600);
  await sim.shot('15-game-inspect');
  await sim.press('play');
  await sim.wait(700);
  await sim.shot('16-pause');
  await sim.press('down');
  await sim.press('down');
  await sim.press('select');
  await sim.wait(700);
  await sim.shot('17-map');
  await sim.press('back');
  await sim.wait(400);
  await sim.press('down');
  await sim.press('select');
  await sim.wait(900);
  await sim.shot('18-guide');
  await sim.press('back');
  await sim.wait(400);
  for (let i = 0; i < 8; i++) await sim.press('down');
  await sim.wait(300);
  await sim.shot('19-pause-bottom');
}
