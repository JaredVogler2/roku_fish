// Gameplay overlays: inspect, pause, map, guide in game, settings in game, controls.
export default async function (sim) {
  const waitFor = async (text, max = 90) => {
    for (let i = 0; i < max; i++) {
      await sim.wait(500);
      if ((await sim.logs()).some((l) => l.includes(text))) return true;
    }
    return false;
  };
  await waitFor('gfx detail');
  await sim.wait(8000);
  await sim.press('down');
  await sim.press('down');
  await sim.press('ok');
  await sim.wait(1000);
  await sim.press('down');
  await sim.press('ok');
  await sim.wait(4000);
  await sim.down('right');
  await sim.wait(1500);
  await sim.up('right');
  await sim.press('replay');
  await sim.wait(700);
  await sim.shot('20-inspect');
  await sim.press('replay');
  await sim.wait(700);
  await sim.shot('21-inspect-next');
  await sim.press('ok');
  await sim.wait(2500);
  await sim.shot('22-after-ok');
  await sim.press('play');
  await sim.wait(700);
  await sim.shot('23-pause');
  await sim.press('down');
  await sim.press('ok');
  await sim.wait(900);
  await sim.shot('24-guide-in-game');
  await sim.press('down');
  await sim.press('right');
  await sim.wait(500);
  await sim.shot('25-guide-entry');
  await sim.press('back');
  await sim.wait(500);
  await sim.press('down');
  await sim.press('down');
  await sim.press('ok');
  await sim.wait(700);
  await sim.shot('26-map');
  await sim.press('back');
  await sim.wait(400);
  await sim.press('down');
  await sim.press('down');
  await sim.press('down');
  await sim.press('ok');
  await sim.wait(700);
  await sim.shot('27-controls');
  await sim.press('back');
  await sim.wait(400);
  for (let i = 0; i < 4; i++) await sim.press('down');
  await sim.press('ok');
  await sim.wait(700);
  await sim.shot('28-settings-in-game');
  await sim.press('back');
  await sim.wait(400);
  await sim.press('back');
  await sim.wait(1000);
  await sim.shot('29-resumed');
}
