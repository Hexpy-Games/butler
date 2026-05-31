#!/usr/bin/env bun

import { recordWorkerFinish, recordWorkerStart } from "../src/test-support/harness/worker-transcript.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  $BUTLER_BUN run packages/butler-agent/scripts/worker-transcript.ts start <session_id> <task_dir> <project_path> <runtime> [model]\n" +
      "  $BUTLER_BUN run packages/butler-agent/scripts/worker-transcript.ts finish <session_id> <task_dir> <project_path> <runtime> <status> [exit_code] [duration_sec] [model]",
  );
  process.exit(1);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const [, , mode, sessionId, taskDir, projectPath, runtime, ...rest] = process.argv;

if (!mode || !sessionId || !taskDir || !projectPath || !runtime) {
  usage();
}

if (mode === "start") {
  const [model] = rest;
  recordWorkerStart({
    sessionId,
    taskDir,
    projectPath,
    runtime,
    model,
  });
} else if (mode === "finish") {
  const [status, exitCodeRaw, durationSecRaw, model] = rest;
  if (!status) usage();
  recordWorkerFinish({
    sessionId,
    taskDir,
    projectPath,
    runtime,
    status,
    exitCode: parseOptionalNumber(exitCodeRaw),
    durationSec: parseOptionalNumber(durationSecRaw),
    model,
  });
} else {
  usage();
}
