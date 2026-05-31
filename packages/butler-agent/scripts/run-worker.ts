#!/usr/bin/env bun

import { runWorkerTask } from "../src/integrations/providers/provider.ts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const [, , taskDir, projectPath, model = ""] = process.argv;

if (!taskDir || !projectPath) {
  console.error("Usage: $BUTLER_BUN run packages/butler-agent/scripts/run-worker.ts <task_dir> <project_path> [model]");
  process.exit(1);
}

function log(line: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[worker-runner] [${ts}] ${line}`);
}

type StoredWorkerActivity = {
  phase?: string;
  status_line?: string;
  current_title?: string;
  updated_at?: string;
  work_blocks?: Array<{
    id?: string;
    label?: string;
    state?: string;
    rows?: Array<{ id?: string; state?: string } & Record<string, unknown>>;
  }>;
};

function readActivity(): StoredWorkerActivity {
  const path = join(taskDir, "worker_activity.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as StoredWorkerActivity : {};
  } catch {
    return {};
  }
}

function mergeWorkBlock(
  blocks: NonNullable<StoredWorkerActivity["work_blocks"]>,
  incoming: NonNullable<StoredWorkerActivity["work_blocks"]>[number],
): NonNullable<StoredWorkerActivity["work_blocks"]> {
  const index = blocks.findIndex((block) => block.id === incoming.id);
  if (index < 0) return [...blocks, incoming].slice(-25);
  const current = blocks[index] ?? {};
  const rowsById = new Map<string, Record<string, unknown>>();
  for (const row of current.rows ?? []) {
    if (typeof row.id === "string") rowsById.set(row.id, row);
  }
  for (const row of incoming.rows ?? []) {
    if (typeof row.id === "string") rowsById.set(row.id, { ...rowsById.get(row.id), ...row });
  }
  const merged = {
    ...current,
    ...incoming,
    rows: [...rowsById.values()],
  };
  const next = [...blocks];
  next[index] = merged;
  return next;
}

function writeActivity(
  phase: string,
  statusLine: string,
  currentTitle?: string,
  workBlock?: NonNullable<StoredWorkerActivity["work_blocks"]>[number],
): void {
  try {
    const previous = readActivity();
    const workBlocks = workBlock
      ? mergeWorkBlock(previous.work_blocks ?? [], workBlock)
      : previous.work_blocks;
    writeFileSync(
      join(taskDir, "worker_activity.json"),
      `${JSON.stringify({
        ...previous,
        phase,
        status_line: statusLine,
        current_title: currentTitle ?? previous.current_title,
        updated_at: new Date().toISOString(),
        ...(workBlocks ? { work_blocks: workBlocks } : {}),
      }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Activity projection is best-effort; worker execution remains primary.
  }
}

function workerFailureStatusLine(message: string): string {
  if (/exceeded \d+ tool rounds|tool budget/iu.test(message)) {
    return "Failed: worker reached the tool budget before producing a report.";
  }
  if (/not supported.*ChatGPT account|model is not supported/iu.test(message)) {
    return "Failed: selected worker model is not available for this account.";
  }
  if (/auth|login|api[_ -]?key|credential/iu.test(message)) {
    return "Failed: worker authentication is not available.";
  }
  return "Failed: worker stopped before completion.";
}

try {
  const result = await runWorkerTask({
    taskDir,
    projectPath,
    model: model || undefined,
    log,
    onActivity: ({ phase, statusLine, currentTitle, workBlock }) =>
      writeActivity(
        phase,
        statusLine,
        currentTitle,
        workBlock as NonNullable<StoredWorkerActivity["work_blocks"]>[number] | undefined,
      ),
  });
  process.stdout.write(result);
  if (!result.endsWith("\n")) process.stdout.write("\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeActivity("failed", workerFailureStatusLine(message));
  log(`ERROR: ${message}`);
  process.exit(1);
}
