import { execFileSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";
import { basename } from "node:path";
import type { P0App } from "./browser-p0-measure.ts";

/** Read process names, never arguments (which may contain credentials). */
export async function quietHost(label: string, app?: P0App) {
  const owned = new Set<number | undefined>([process.pid]);
  if (app) {
    const state = await app.main.evaluate<{ metrics: Array<{ pid: number }> }>("browserP0.sample()");
    for (const metric of state.metrics) owned.add(metric.pid);
    owned.add(app.child.pid);
    const runtime = JSON.parse(await Bun.file(`${app.data}/app/runtime/foreground/instance.json`).text());
    owned.add(runtime.agent_host_pid);
  }
  for (;;) {
    const processes = execFileSync("ps", ["-Ao", "pid=,pcpu=,comm="], { encoding: "utf8" }).trim().split("\n").map(line => {
      const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
      if (!match) throw new Error("Host CPU inventory unavailable");
      return { pid: Number(match[1]), cpu: Number(match[2]), name: basename(match[3]!) };
    }).filter(p => !owned.has(p.pid));
    const load1 = loadavg()[0], otherCPU = processes.reduce((n, p) => n + p.cpu, 0);
    const evidence = { label, at: new Date().toISOString(), load1, otherCPU, cores: availableParallelism(), others: processes.filter(p => p.cpu >= 1).sort((a, b) => b.cpu - a.cpu) };
    // Admission only, never a relaxation of the scenario's timing budgets.
    const busy = load1 > availableParallelism() / 2 || otherCPU > 100;
    console.log(JSON.stringify({ hostLoad: evidence, busy }));
    if (!busy) return evidence;
    await Bun.sleep(30_000);
  }
}
