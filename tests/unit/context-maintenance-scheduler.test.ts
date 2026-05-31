import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultSchedulerJobs } from "../../packages/butler-agent/src/operations/scheduler/native-scheduler.ts";

let root = "";
let originalHome: string | undefined;
let originalData: string | undefined;
let originalBun: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-context-maintenance-scheduler-"));
  originalHome = process.env.BUTLER_HOME;
  originalData = process.env.BUTLER_DATA;
  originalBun = process.env.BUTLER_BUN;
  process.env.BUTLER_HOME = join(root, "home");
  process.env.BUTLER_DATA = join(root, "data");
  process.env.BUTLER_BUN = join(root, "managed-bun");
  mkdirSync(process.env.BUTLER_HOME, { recursive: true });
  mkdirSync(process.env.BUTLER_DATA, { recursive: true });
  writeFileSync(process.env.BUTLER_BUN, "#!/bin/sh\n", "utf8");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = originalHome;
  if (originalData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalData;
  if (originalBun === undefined) delete process.env.BUTLER_BUN;
  else process.env.BUTLER_BUN = originalBun;
  rmSync(root, { recursive: true, force: true });
});

test("native scheduler schedules context maintenance through the managed runtime", () => {
  const job = defaultSchedulerJobs().find((item) => item.id === "context-maintenance");
  const command = job?.command({
    butlerHome: process.env.BUTLER_HOME!,
    butlerData: process.env.BUTLER_DATA!,
    bun: process.env.BUTLER_BUN!,
  });

  expect(job).toMatchObject({
    id: "context-maintenance",
    hour: 3,
    minute: 30,
  });
  expect(command).toEqual([
    process.env.BUTLER_BUN!,
    "run",
    join(process.env.BUTLER_HOME!, "packages", "butler-agent", "scripts", "prune-context-maintenance.ts"),
    "--json",
  ]);
});

test("native scheduler routes consolidation-cycle through scheduled cognition wrapper", () => {
  const job = defaultSchedulerJobs().find((item) => item.id === "consolidation-cycle");
  const command = job?.command({
    butlerHome: process.env.BUTLER_HOME!,
    butlerData: process.env.BUTLER_DATA!,
    bun: process.env.BUTLER_BUN!,
  });

  expect(job).toMatchObject({
    id: "consolidation-cycle",
    hour: 4,
    minute: 0,
  });
  expect(command).toEqual([
    process.env.BUTLER_BUN!,
    "run",
    join(process.env.BUTLER_HOME!, "packages", "butler-agent", "src", "agent", "cognition", "consolidation", "scheduled-cycle.ts"),
  ]);
});
