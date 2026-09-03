import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { resolveBunPath } from "../../interfaces/cli/runtime.ts";
import { NativeInboundQueue } from "../../gateways/core/inbound-queue.ts";
import { AutomationStore } from "../service/automation-store.ts";
import { butlerAgentScriptPath, butlerAgentSourcePath } from "../../runtime/paths.ts";

export interface SchedulerJobSpec {
  id: "session-sync" | "consolidation-cycle" | "context-maintenance";
  hour: number;
  minute: number;
  command: (input: { butlerHome: string; butlerData: string; bun: string }) => string[];
}

export interface SchedulerTickResult {
  automationRuns: number;
  enqueuedAutomationRuns: number;
  jobsRun: string[];
  jobsSkipped: string[];
  failures: Array<{ id: string; message: string }>;
}

export interface RunSchedulerTickOptions {
  butlerHome?: string;
  butlerData?: string;
  now?: Date;
  jobs?: SchedulerJobSpec[];
  runCommand?: (command: string[], env: Record<string, string>) => { status: number | null; stderr?: string };
}

function butlerHome(input?: string): string {
  return input || process.env.BUTLER_HOME || join(homedir(), "butler");
}

function butlerData(input?: string): string {
  return input || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

export function defaultSchedulerJobs(): SchedulerJobSpec[] {
  return [
    {
      id: "context-maintenance",
      hour: 3,
      minute: 30,
      command: ({ butlerHome: home, bun }) => [
        bun,
        "run",
        butlerAgentScriptPath(home, "prune-context-maintenance.ts"),
        "--json",
      ],
    },
    {
      id: "session-sync",
      hour: 4,
      minute: 0,
      command: ({ butlerHome: home, bun }) => [
        bun,
        "run",
        butlerAgentSourcePath(home, "agent", "cognition", "memory", "scripts", "session-sync.ts"),
      ],
    },
    {
      id: "consolidation-cycle",
      hour: 4,
      minute: 0,
      command: ({ butlerHome: home, bun }) => [
        bun,
        "run",
        butlerAgentSourcePath(home, "agent", "cognition", "consolidation", "scheduled-cycle.ts"),
      ],
    },
  ];
}

function schedulerStatePath(data: string, id: string): string {
  return join(data, "state", "scheduler", `${id}.json`);
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function shouldRunDailyJob(data: string, job: SchedulerJobSpec, now: Date): boolean {
  if (minutesSinceMidnight(now) < job.hour * 60 + job.minute) return false;
  const path = schedulerStatePath(data, job.id);
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { lastRunDate?: string };
    return state.lastRunDate !== dateKey(now);
  } catch {
    return true;
  }
}

function writeJobState(data: string, id: string, state: Record<string, unknown>): void {
  const path = schedulerStatePath(data, id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function defaultRunCommand(command: string[], env: Record<string, string>) {
  const [program, ...args] = command;
  if (!program) return { status: 1, stderr: "missing command" };
  const result = spawnSync(program, args, {
    cwd: env.BUTLER_DATA,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stderr: result.stderr,
  };
}

export function runSchedulerTick(options: RunSchedulerTickOptions = {}): SchedulerTickResult {
  const home = butlerHome(options.butlerHome);
  const data = butlerData(options.butlerData);
  const now = options.now ?? new Date();
  const bun = resolveBunPath({ butlerData: data });
  const env = {
    ...process.env,
    BUTLER_HOME: home,
    BUTLER_DATA: data,
    BUTLER_BUN: bun,
  } as Record<string, string>;
  const result: SchedulerTickResult = {
    automationRuns: 0,
    enqueuedAutomationRuns: 0,
    jobsRun: [],
    jobsSkipped: [],
    failures: [],
  };

  try {
    const queue = new NativeInboundQueue(data);
    const runs = new AutomationStore(data).claimDue(now);
    result.automationRuns = runs.length;
    for (const run of runs) {
      queue.enqueue(run.envelope, {
        source: "packages/butler-agent/scripts/native-scheduler.ts",
        automationId: run.automation.id,
      }, now);
      result.enqueuedAutomationRuns += 1;
    }
  } catch (error) {
    result.failures.push({
      id: "automation",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  for (const job of options.jobs ?? defaultSchedulerJobs()) {
    if (!shouldRunDailyJob(data, job, now)) {
      result.jobsSkipped.push(job.id);
      continue;
    }
    const command = job.command({ butlerHome: home, butlerData: data, bun });
    const run = (options.runCommand ?? defaultRunCommand)(command, env);
    if (run.status === 0) {
      result.jobsRun.push(job.id);
      writeJobState(data, job.id, {
        lastRunDate: dateKey(now),
        lastRunAt: now.toISOString(),
        status: "ok",
      });
    } else {
      const message = run.stderr?.trim().slice(0, 500) || `exit status ${run.status ?? "unknown"}`;
      result.failures.push({ id: job.id, message });
      writeJobState(data, job.id, {
        lastRunDate: dateKey(now),
        lastRunAt: now.toISOString(),
        status: "error",
        message,
      });
    }
  }

  return result;
}

export async function runSchedulerLoop(input: {
  butlerHome?: string;
  butlerData?: string;
  intervalMs?: number;
  shouldStop?: () => boolean;
  log?: (line: string) => void;
} = {}): Promise<void> {
  const intervalMs = input.intervalMs ?? 60_000;
  while (!input.shouldStop?.()) {
    const result = runSchedulerTick(input);
    if (result.automationRuns || result.jobsRun.length || result.failures.length) {
      input.log?.(`tick automation=${result.enqueuedAutomationRuns}/${result.automationRuns} jobs=${result.jobsRun.join(",") || "none"} failures=${result.failures.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function schedulerIsAvailable(butlerDataPath: string): boolean {
  return existsSync(join(butlerDataPath, "state", "services", "butler-scheduler.json"));
}
