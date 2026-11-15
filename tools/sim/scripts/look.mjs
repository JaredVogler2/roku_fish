// Swim around a little and take pictures (for checking how a region or time of day looks).
export default async function (sim) {
  const name = process.env.SHOT ?? 'look';
  for (let i = 0; i < 120; i++) {
    await sim.wait(500);
    if ((await sim.logs()).some((l) => l.includes('gfx detail'))) break;
  }
  await sim.wait(9000);
  await sim.shot(`${name}-1`);
  const moves = (process.env.MOVES ?? 'right,down,left,down').split(',');
  let n = 2;
  for (const mv of moves) {
    await sim.down(mv);
    await sim.wait(Number(process.env.HOLD ?? 3500));
    await sim.up(mv);
    await sim.wait(500);
    await sim.shot(`${name}-${n++}`);
  }
}
