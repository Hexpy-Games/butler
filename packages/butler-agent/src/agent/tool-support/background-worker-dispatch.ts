import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ReasoningEffort } from "../../integrations/providers/model-catalog.ts";
import type { CommandExecutor, CommandResult } from "../../runtime/command/contracts.ts";
import {
  backgroundCommandControlPaths,
  startRegisteredBackgroundCommand,
} from "../../runtime/command/background-command-registry.ts";
import { createPlatformCommandExecutor } from "../../runtime/command/platform-command-executor.ts";
import { recordWorkerFinish, recordWorkerStart } from "../../test-support/harness/worker-transcript.ts";
import { butlerToolProcessEnvironment } from "./executor-support.ts";

export interface BackgroundWorkerDispatchInput {
  taskId: string;
  butlerHome: string;
  butlerData: string;
  task: string;
  projectPath: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  commandExecutor?: CommandExecutor;
}

export function dispatchBackgroundWorker(input: BackgroundWorkerDispatchInput): void {
  if (process.env.BUTLER_WORKER === "1") {
    throw new Error("workers cannot dispatch recursive background workers");
  }
  const workerEntrypoint = join(
    input.butlerHome,
    "packages",
    "butler-agent",
    "scripts",
    "run-worker.ts",
  );
  if (!existsSync(workerEntrypoint)) {
    throw new Error(`worker runtime entrypoint not found: ${workerEntrypoint}`);
  }
  if (!existsSync(input.projectPath)) {
    throw new Error(`worker project path not found: ${input.projectPath}`);
  }

  const taskDir = join(input.butlerData, "tasks", input.taskId);
  const sessionId = randomUUID();
  const startedAt = Date.now();
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "request.md"), `${input.task}\n`, "utf8");
  writeFileSync(join(taskDir, "project"), `${workerProjectName(input.projectPath)}\n`, "utf8");
  writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(join(taskDir, "session_id"), `${sessionId}\n`, "utf8");
  writeWorkerActivity(taskDir, "orienting", "Orienting: checking the request and workspace.");
  writeFileSync(join(taskDir, "execution.json"), `${JSON.stringify({
    schema: "butler.background-execution.v1",
    execution_id: input.taskId,
    owner: "app_foreground_agent",
    started_at: new Date(startedAt).toISOString(),
    rawTextIncluded: false,
  }, null, 2)}\n`, "utf8");

  const runtime = effectiveWorkerRuntime(input.butlerData);
  recordWorkerStart({
    sessionId,
    taskDir,
    projectPath: input.projectPath,
    runtime,
    model: input.model,
  });

  startRegisteredBackgroundCommand({
    id: input.taskId,
    executor: input.commandExecutor ?? createPlatformCommandExecutor(),
    control: backgroundCommandControlPaths(input.butlerData, input.taskId),
    request: {
      plan: {
        steps: [{
          executable: process.execPath,
          arguments: [
            "run",
            workerEntrypoint,
            taskDir,
            input.projectPath,
            input.model?.trim() ?? "",
          ],
        }],
      },
      cwd: input.projectPath,
      environment: {
        ...butlerToolProcessEnvironment({ butlerData: input.butlerData }),
        BUTLER_HOME: input.butlerHome,
        BUTLER_DATA: input.butlerData,
        BUTLER_ROLE: "worker",
        BUTLER_WORKER: "1",
        TASK_ID_OVERRIDE: input.taskId,
        ...(input.reasoningEffort
          ? { BUTLER_OPENAI_REASONING_EFFORT: input.reasoningEffort }
          : {}),
      },
      inheritEnvironment: false,
      timeoutMs: workerTimeoutMs(input.butlerData),
    },
    onSettled: (result) => settleBackgroundWorker({
      taskDir,
      sessionId,
      projectPath: input.projectPath,
      runtime,
      model: input.model,
      startedAt,
      result,
    }),
  });
}

function settleBackgroundWorker(input: {
  taskDir: string;
  sessionId: string;
  projectPath: string;
  runtime: string;
  model?: string;
  startedAt: number;
  result: CommandResult;
}): void {
  const currentStatus = readText(join(input.taskDir, "status"));
  const durationSec = Math.max(0, Math.round((Date.now() - input.startedAt) / 1000));
  const exitCode = input.result.exitCode ?? (input.result.cancelled ? 130 : 1);
  writeFileSync(join(input.taskDir, "result.md"), input.result.stdout, "utf8");
  writeFileSync(join(input.taskDir, "log.txt"), input.result.stderr, "utf8");
  if (currentStatus !== "KILLED" && currentStatus !== "CANCELLED") {
    if (input.result.exitCode === 0 && !input.result.timedOut && !input.result.cancelled) {
      writeFileSync(join(input.taskDir, "status"), "DONE\n", "utf8");
      writeWorkerActivity(input.taskDir, "complete", "Complete: worker finished successfully.");
    } else {
      const reason = input.result.timedOut
        ? "TIMEOUT: worker reached the hard deadline"
        : input.result.error?.message ?? `EXIT_CODE: ${exitCode}`;
      appendResult(input.taskDir, reason);
      writeFileSync(join(input.taskDir, "status"), "FAILED\n", "utf8");
      writeWorkerActivity(input.taskDir, "failed", "Failed: worker exited before completion.");
    }
  }
  const finalStatus = readText(join(input.taskDir, "status")) || "FAILED";
  recordWorkerFinish({
    sessionId: input.sessionId,
    taskDir: input.taskDir,
    projectPath: input.projectPath,
    runtime: input.runtime,
    status: finalStatus,
    exitCode,
    durationSec,
    model: input.model,
  });
}

function appendResult(taskDir: string, line: string): void {
  const current = readText(join(taskDir, "result.md"));
  writeFileSync(
    join(taskDir, "result.md"),
    `${current}${current ? "\n" : ""}${line}\n`,
    "utf8",
  );
}

function writeWorkerActivity(taskDir: string, phase: string, statusLine: string): void {
  const previous = readJson(join(taskDir, "worker_activity.json"));
  writeFileSync(join(taskDir, "worker_activity.json"), `${JSON.stringify({
    ...previous,
    phase,
    status_line: statusLine,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function workerProjectName(projectPath: string): string {
  const name = basename(projectPath);
  return name === "dev" || name === process.env.USER ? "general" : name;
}

function effectiveWorkerRuntime(butlerData: string): string {
  try {
    const config = JSON.parse(
      readFileSync(join(butlerData, "butler.config.json"), "utf8"),
    ) as { system?: { runtime?: unknown } };
    const runtime = config.system?.runtime;
    return typeof runtime === "string" && runtime.trim() ? runtime.trim() : "codex-api";
  } catch {
    return "codex-api";
  }
}

function workerTimeoutMs(butlerData: string): number {
  try {
    const config = JSON.parse(
      readFileSync(join(butlerData, "butler.config.json"), "utf8"),
    ) as { timeouts?: { workerDefaultSec?: unknown } };
    const seconds = config.timeouts?.workerDefaultSec;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return Math.max(1_000, Math.min(3_600_000, Math.trunc(seconds * 1_000)));
    }
  } catch {
    // The stable default applies when configuration is absent or invalid.
  }
  return 1_200_000;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
