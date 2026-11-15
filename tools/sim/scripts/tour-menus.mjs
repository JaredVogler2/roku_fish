// Menu screens: tournament, challenge, practice, reef lab, settings, about.
export default async function (sim) {
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(8000);
  const go = async (downs, name, extra) => {
    // the menu opens on "Learn the Reef" (row 7) on a first launch; wrap to the top first
    await sim.press('down');
    await sim.press('down');
    for (let i = 0; i < downs; i++) await sim.press('down');
    await sim.press('ok');
    await sim.wait(1100);
    await sim.shot(name);
    if (extra) await extra();
    await sim.press('back');
    await sim.wait(700);
    // back on the menu the focus is where it was at launch (the menu is rebuilt)
  };
  await go(1, '30-tournament');
  await go(2, '31-challenge');
  await go(3, '32-practice', async () => {
    await sim.press('right');
    await sim.press('down');
    await sim.press('down');
    await sim.press('ok');
    await sim.wait(600);
    await sim.shot('33-practice-options');
    await sim.press('back');
    await sim.wait(300);
  });
  await go(4, '34-reeflab', async () => {
    for (let i = 0; i < 4; i++) await sim.press('down');
    await sim.press('right');
    await sim.press('right');
    await sim.wait(500);
    await sim.shot('35-reeflab-large');
  });
  await go(6, '36-settings');
  await go(8, '37-controls', async () => {
    await sim.press('right');
    await sim.wait(500);
    await sim.shot('38-about');
  });
}
