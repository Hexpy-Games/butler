// Report measured intervals against current source locations, never estimate I/O.
import { readFileSync, globSync } from "node:fs";
import { resolve } from "node:path";

function phaseSources() {
  const sources = new Map<string, string[]>();
  const root = resolve("packages/butler-agent/rust");
  for (const file of globSync("crates/{butler-agent,butler-gateway}/src/**/*.rs", { cwd: root })) {
    const content = readFileSync(resolve(root, file), "utf8");
    for (const match of content.matchAll(/(?:measure|measure_sync|measure_shutdown|event)\s*\(\s*"([a-z_]+)(?::(?:begin|end))?"/gu)) {
      const line = content.slice(0, match.index).split("\n").length;
      sources.set(match[1], [...(sources.get(match[1]) ?? []), `packages/butler-agent/rust/${file}:${line}`]);
    }
  }
  return sources;
}

export function quitPhaseReport(log: string) {
  const sources = phaseSources();
  const pending = new Map<string, number[]>();
  const phases = [];
  const start = Number(log.match(/harness stop:.*unix_us=(\d+)/u)?.[1] ?? log.match(/unix_us=(\d+).*phase=stop_requested /u)?.[1]);
  const finish = Number(log.match(/unix_us=(\d+).*phase=stop_settled /u)?.[1] ?? Infinity);
  for (const match of log.matchAll(/\[native-shutdown\] unix_us=(\d+) elapsed_us=\d+ phase=([a-z_]+)(?::(begin|end))? edge=(begin|end|event)/gu)) {
    const time = Number(match[1]);
    const phase = match[2];
    const edge = match[3] ?? match[4];
    if (edge === "event") continue;
    if (edge === "begin") pending.set(phase, [...(pending.get(phase) ?? []), time]);
    else {
      const started = pending.get(phase)?.pop();
      if (started !== undefined && time >= start && time <= finish) phases.push({ phase, duration_ms: (time - started) / 1000, source: [...new Set(sources.get(phase) ?? [])].join(" | ") || "event instrumentation" });
    }
  }
  return phases;
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: bun run tests/smoke/quit-phase-report.ts <structured-log>");
  console.log(JSON.stringify(quitPhaseReport(readFileSync(process.argv[2], "utf8")), null, 2));
}
