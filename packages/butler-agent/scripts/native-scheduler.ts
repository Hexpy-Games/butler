#!/usr/bin/env bun
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { runSchedulerLoop, runSchedulerTick } from "../src/operations/scheduler/native-scheduler.ts";

function hasFlag(name: string): boolean {
  return Bun.argv.includes(name);
}

const butlerData = process.env.BUTLER_DATA || join(homedir(), ".butler");
const shutdownFlag = join(butlerData, "locks", "butler-shutdown");

if (hasFlag("--once")) {
  const nowArg = Bun.argv.find((arg) => arg.startsWith("--now="));
  const result = runSchedulerTick({
    now: nowArg ? new Date(nowArg.slice("--now=".length)) : new Date(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  await runSchedulerLoop({
    shouldStop: () => existsSync(shutdownFlag),
    log: (line) => process.stdout.write(`[scheduler] ${line}\n`),
  });
}

