#!/usr/bin/env bun
import { createRuntimeMemoryPhysicalObserver } from "./runtime-memory-physical-observer.ts";

type CliOptions = {
  pid: number;
  output: string;
  event: "idle_checkpoint" | "other";
  intervalMs: number;
  durationMs: number;
};

const options = parseArgs(process.argv.slice(2));
if (!options) {
  process.stderr.write("runtime memory observer requires --pid and --output\n");
  process.exitCode = 2;
} else {
  const observer = createRuntimeMemoryPhysicalObserver({
    pid: options.pid,
    outputPath: options.output,
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(interval);
    if (durationTimer) clearTimeout(durationTimer);
    observer.close();
  };
  const sample = () => observer.sample(options.event);
  sample();
  const interval = setInterval(sample, options.intervalMs);
  const durationTimer = options.durationMs > 0
    ? setTimeout(finish, options.durationMs)
    : null;
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
  if (options.durationMs === 0) {
    // A one-shot observer must not keep a process alive after its evidence is
    // written. The timer is cleared by finish during normal shutdown.
    finish();
  }
}

function parseArgs(args: string[]): CliOptions | null {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const pid = Number(value("--pid"));
  const output = value("--output")?.trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !output) return null;
  const intervalMs = boundedNumber(value("--interval-ms"), 1_000, 60_000);
  const durationMs = boundedNumber(value("--duration-ms"), 0, 600_000);
  const event = value("--event");
  return {
    pid,
    output,
    event: event === "idle_checkpoint" ? "idle_checkpoint" : "other",
    intervalMs,
    durationMs,
  };
}

function boundedNumber(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.trunc(parsed), maximum);
}
