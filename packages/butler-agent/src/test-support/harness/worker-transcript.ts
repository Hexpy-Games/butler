import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { appendTranscriptEvent, createTranscriptEvent, type TranscriptEvent } from "./transcripts.ts";

export type WorkerTranscriptRuntime = "codex-api" | string;
export type WorkerOutcomeStatus = "running" | "done" | "failed" | "timed_out";

interface WorkerTranscriptCommonInput {
  sessionId: string;
  taskDir: string;
  projectPath: string;
  runtime: WorkerTranscriptRuntime;
  model?: string;
}

export interface WorkerTranscriptStartInput extends WorkerTranscriptCommonInput {}

export interface WorkerTranscriptFinishInput extends WorkerTranscriptCommonInput {
  status: string;
  exitCode?: number | null;
  durationSec?: number;
}

interface TaskRequest {
  text: string;
  source: "request.md" | "plan.md" | null;
}

function readTextIfExists(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function readTaskRequest(taskDir: string): TaskRequest {
  const request = readTextIfExists(join(taskDir, "request.md"));
  if (request) {
    return { text: request, source: "request.md" };
  }

  const plan = readTextIfExists(join(taskDir, "plan.md"));
  if (plan) {
    return { text: plan, source: "plan.md" };
  }

  return { text: "", source: null };
}

function readTaskResult(taskDir: string): string {
  return readTextIfExists(join(taskDir, "result.md"));
}

function normalizeModel(model?: string): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}

function classifyWorkerOutcome(status: string, exitCode?: number | null, resultText?: string): WorkerOutcomeStatus {
  const normalizedStatus = status.trim().toUpperCase();
  if (exitCode === 124 || exitCode === 125 || exitCode === 126) {
    return "timed_out";
  }
  if (resultText?.includes("TIMEOUT:")) {
    return "timed_out";
  }
  if (normalizedStatus === "DONE" || normalizedStatus === "REVIEWED") {
    return "done";
  }
  if (normalizedStatus === "RUNNING") {
    return "running";
  }
  return "failed";
}

function buildMetadata(taskId: string, phase: string): Record<string, unknown> {
  return {
    role: "worker",
    taskId,
    phase,
  };
}

export function recordWorkerStart(input: WorkerTranscriptStartInput): TranscriptEvent[] {
  const taskId = basename(input.taskDir);
  const request = readTaskRequest(input.taskDir);
  const shared = {
    taskId,
    taskDir: input.taskDir,
    projectPath: input.projectPath,
    runtime: input.runtime,
    model: normalizeModel(input.model),
  };

  const events = [
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "worker_status",
      payload: {
        ...shared,
        status: "running",
      },
      metadata: buildMetadata(taskId, "start"),
    }),
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "turn",
      payload: {
        ...shared,
        phase: "request",
        text: request.text,
        requestSource: request.source,
      },
      metadata: buildMetadata(taskId, "request"),
    }),
  ];

  for (const event of events) {
    appendTranscriptEvent(event);
  }
  return events;
}

export function recordWorkerFinish(input: WorkerTranscriptFinishInput): TranscriptEvent[] {
  const taskId = basename(input.taskDir);
  const resultText = readTaskResult(input.taskDir);
  const outcome = classifyWorkerOutcome(input.status, input.exitCode, resultText);
  const shared = {
    taskId,
    taskDir: input.taskDir,
    projectPath: input.projectPath,
    runtime: input.runtime,
    model: normalizeModel(input.model),
  };

  const events = [
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "turn",
      payload: {
        ...shared,
        phase: "result",
        text: resultText,
        status: outcome,
        statusFileValue: input.status,
        exitCode: input.exitCode ?? null,
        durationSec: input.durationSec ?? null,
      },
      metadata: buildMetadata(taskId, "result"),
    }),
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "worker_status",
      payload: {
        ...shared,
        status: outcome,
        statusFileValue: input.status,
        exitCode: input.exitCode ?? null,
        durationSec: input.durationSec ?? null,
        resultBytes: Buffer.byteLength(resultText, "utf8"),
      },
      metadata: buildMetadata(taskId, "finish"),
    }),
  ];

  for (const event of events) {
    appendTranscriptEvent(event);
  }
  return events;
}
