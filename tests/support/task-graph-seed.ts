// Shared service-backed fixture; the dev-only Rust companion owns all mutations.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
export type SeedState = "running" | "failed" | "waiting" | "done" | "cancelled";

async function build(data: string, command: string, args: string[] = []): Promise<void> {
  const executable = process.env.BUTLER_TASK_GRAPH_BUILDER_EXECUTABLE ?? resolve(process.env.CARGO_TARGET_DIR ?? "packages/butler-agent/rust/target", "debug/e2e-task-graph");
  if (!existsSync(executable)) throw new Error(`Build the task graph fixture companion: ${executable}`);
  const child = spawn(executable, [data, command, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let error = "";
  child.stderr.on("data", chunk => { error += String(chunk); });
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
    if (code !== 0) throw new Error(`Task graph fixture failed (${code}): ${error}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

export function seedTaskGraphs(data: string, states: SeedState[], count = 5, parent = "butler/app-general"): Promise<void> {
  return build(data, "seed", [parent, JSON.stringify(states), String(count)]);
}
export function finishGraphWorkers(data: string): Promise<void> { return build(data, "finish"); }
export function reviseTaskGraph(data: string, id: string): Promise<void> { return build(data, "revise", [id]); }

export function advanceGraphPhase(data: string, id: string, phase: string): Promise<void> { return build(data, "phase", [id, phase]); }
