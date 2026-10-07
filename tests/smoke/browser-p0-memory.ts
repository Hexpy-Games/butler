/** Interval heap/native evidence. Snapshots are diagnostics, never RSS-gate GC. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import type { P0App } from "./browser-p0-measure";

export async function memoryCheckpoint(app: P0App, evidence: string, label: string, heap = false) {
  const state = await app.main.evaluate<any>("({...browserP0.sample(),memory:process.memoryUsage(),heap:process.getBuiltinModule('v8').getHeapStatistics()})");
  const row = { label, at: new Date().toISOString(), load1: loadavg()[0], memory: state.memory, heap: state.heap, resources: state.resources, sessionsCreated: state.sessionsCreated };
  writeFileSync(join(evidence, `${label}-memory.json`), JSON.stringify(row, null, 2));
  // OS tools are evidence-only subprocesses in the smoke, never a product path.
  if (process.platform === "darwin") for (const [tool, args] of [["vmmap", ["-summary", String(state.mainPID)]], ["footprint", ["-p", String(state.mainPID), "-s"]]] as const) {
    const result = await promisify(execFile)(tool, [...args], { maxBuffer: 16 * 1024 * 1024 }).then(r => r.stdout, e => `UNAVAILABLE: ${e.message}`);
    writeFileSync(join(evidence, `${label}-${tool}.txt`), result);
  }
  if (heap) await app.main.snapshot(join(evidence, `${label}.heapsnapshot`));
  return row;
}
