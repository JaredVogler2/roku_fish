// Just let the channel run for a while (used for benchmarks and soak tests).
export default async function (sim) {
  const ms = Number(process.env.SIM_MS ?? 20000);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sim.wait(500);
    const logs = await sim.logs();
    if (logs.some((l) => l.includes('BENCH DONE'))) break;
    if (!(await sim.running()) && Date.now() - t0 > 4000) break;
  }
}
