// Reef Lab: change the design, save it, test swim, then leave and exit the channel.
export default async function (sim) {
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(1500);
  await sim.shot('40-loading-or-menu');
  await sim.wait(7000);
  // menu opens on the tutorial row (7); Reef Lab is row 4: wrap to the top, then down 4
  await sim.press('down');
  await sim.press('down');
  for (let i = 0; i < 4; i++) await sim.press('down');
  await sim.press('ok');
  await sim.wait(900);
  // name -> next, body -> ray, diet etc.
  await sim.press('down');
  await sim.press('right');
  await sim.press('down');
  await sim.press('right');
  await sim.press('right');
  await sim.wait(500);
  await sim.shot('41-lab-ray');
  // jump to the buttons at the bottom: up wraps from row 0... go up from row 2 to the end
  await sim.press('up');
  await sim.press('up');
  await sim.press('up');
  await sim.wait(300);
  await sim.shot('42-lab-save-row');
  await sim.press('ok');
  await sim.wait(700);
  await sim.shot('43-lab-saved');
  await sim.press('up');
  await sim.wait(300);
  await sim.shot('44-lab-test-row');
  await sim.press('ok');
  await sim.wait(5000);
  await sim.down('right');
  await sim.wait(2000);
  await sim.up('right');
  await sim.press('ok');
  await sim.wait(2000);
  await sim.press('rev');
  await sim.wait(1500);
  await sim.shot('45-lab-swim');
  await sim.press('back');
  await sim.wait(600);
  await sim.press('up');
  await sim.press('ok');
  await sim.wait(1500);
  await sim.press('ok');
  await sim.wait(1000);
  // practice list should now start with the saved design
  await sim.press('down');
  await sim.press('down');
  for (let i = 0; i < 3; i++) await sim.press('down');
  await sim.press('ok');
  await sim.wait(1000);
  await sim.shot('46-practice-with-custom');
  await sim.press('back');
  await sim.wait(600);
  await sim.press('back');
  await sim.wait(600);
  await sim.shot('47-exit-confirm');
  await sim.press('ok');
  await sim.wait(1500);
  console.log('running after exit:', await sim.running());
}
