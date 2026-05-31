import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultSchedulerJobs, runSchedulerTick } from "../../packages/butler-agent/src/operations/scheduler/native-scheduler.ts";
import { AutomationStore } from "../../packages/butler-agent/src/operations/service/automation-store.ts";

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-native-scheduler-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("native scheduler claims due automations into the inbound queue", () => {
  const butlerData = tempRoot();
  try {
    new AutomationStore(butlerData).create({
      id: "morning-check",
      prompt: "Run the morning check.",
      sessionId: "butler/main",
      schedule: { type: "once", run_at: "2026-04-27T08:00:00.000Z" },
      now: new Date("2026-04-27T07:00:00.000Z"),
    });
    const result = runSchedulerTick({
      butlerHome: "/opt/butler",
      butlerData,
      now: new Date("2026-04-27T08:00:00.000Z"),
      jobs: [],
    });
    expect(result.automationRuns).toBe(1);
    expect(result.enqueuedAutomationRuns).toBe(1);
    const pendingDir = join(butlerData, "runtime", "inbound-events", "pending");
    expect(readdirSync(pendingDir)).toHaveLength(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native scheduler runs daily jobs once per local day", () => {
  const butlerData = tempRoot();
  const commands: string[][] = [];
  try {
    const job = {
      id: "context-maintenance" as const,
      hour: 3,
      minute: 30,
      command: () => ["bun", "run", "context"],
    };
    const first = runSchedulerTick({
      butlerHome: "/opt/butler",
      butlerData,
      now: new Date("2026-04-27T03:31:00"),
      jobs: [job],
      runCommand: (command) => {
        commands.push(command);
        return { status: 0 };
      },
    });
    const second = runSchedulerTick({
      butlerHome: "/opt/butler",
      butlerData,
      now: new Date("2026-04-27T04:00:00"),
      jobs: [job],
      runCommand: (command) => {
        commands.push(command);
        return { status: 0 };
      },
    });
    expect(first.jobsRun).toEqual(["context-maintenance"]);
    expect(second.jobsSkipped).toEqual(["context-maintenance"]);
    expect(commands).toHaveLength(1);
    expect(existsSync(join(butlerData, "state", "scheduler", "context-maintenance.json"))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native scheduler executes scheduled cognition consolidation through the real command path", () => {
  const butlerData = tempRoot();
  try {
    const job = defaultSchedulerJobs().find((item) => item.id === "consolidation-cycle");
    expect(job).toBeDefined();
    const result = runSchedulerTick({
      butlerHome: process.cwd(),
      butlerData,
      now: new Date("2026-05-15T04:01:00"),
      jobs: [job!],
    });

    expect(result).toMatchObject({
      jobsRun: ["consolidation-cycle"],
      failures: [],
    });
    expect(existsSync(join(butlerData, "state", "scheduler", "consolidation-cycle.json"))).toBe(true);
    expect(existsSync(join(butlerData, "cognition", "consolidation", "run-summary.jsonl"))).toBe(true);
    expect(existsSync(join(butlerData, "cognition", "memory", "db", "graph.sqlite"))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
