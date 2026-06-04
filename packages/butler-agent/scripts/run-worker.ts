#!/usr/bin/env bun

import { runWorkerTask } from "../src/integrations/providers/provider.ts";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
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
  semantic_phase?: string;
  action_kind?: string;
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

type WorkerActivityTimelineEvent = {
  schema: "butler.worker-activity-event.v1";
  event_id: string;
  created_at: string;
  actor: "worker";
  task_id?: string;
  event: "worker_started" | "activity_updated" | "worker_finished" | "worker_failed";
  phase?: string;
  semantic_phase?: string;
  action_kind?: string;
  status_line?: string;
  current_title?: string;
  decision_summary?: string;
  decision_rationale?: string;
  decision_next_step?: string;
  evidence_refs?: string[];
  completion_obligations?: string[];
  work_block_id?: string;
};

function taskIdFromDir(): string | undefined {
  return taskDir.split("/").filter(Boolean).at(-1);
}

function makeEventId(event: string): string {
  return `${Date.now().toString(36)}-${event}-${Math.random().toString(36).slice(2, 8)}`;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function compactPreview(input: string, max = 240): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function writeTrace(event: string, data: Record<string, unknown> = {}): void {
  try {
    appendFileSync(
      join(taskDir, "worker_observability.jsonl"),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...data,
      })}\n`,
      "utf8",
    );
  } catch {
    // Observability is best-effort; worker execution remains primary.
  }
}

function writeActivityEvent(event: Omit<WorkerActivityTimelineEvent, "schema" | "event_id" | "created_at" | "actor" | "task_id">): void {
  try {
    const payload: WorkerActivityTimelineEvent = {
      schema: "butler.worker-activity-event.v1",
      event_id: makeEventId(event.event),
      created_at: new Date().toISOString(),
      actor: "worker",
      task_id: taskIdFromDir(),
      evidence_refs: [],
      completion_obligations: [],
      ...event,
    };
    appendFileSync(join(taskDir, "worker_activity_events.jsonl"), `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Timeline history is best-effort for this compatibility step; worker execution remains primary.
  }
}

function decisionSummaryForActivity(phase: string, semanticPhase: string | undefined, actionKind: string | undefined, statusLine: string): string {
  const semantic = semanticPhase ? `${semanticPhase}` : phase;
  const action = actionKind ? ` via ${actionKind}` : "";
  return `${semantic}${action}: ${statusLine}`;
}

function decisionRationaleForActivity(semanticPhase: string | undefined): string {
  switch (semanticPhase) {
    case "orienting": return "The worker is establishing task and repository context before choosing concrete actions.";
    case "planning": return "The worker is selecting the next work path before using execution tools.";
    case "inspecting": return "The worker is gathering bounded evidence needed for the current task step.";
    case "executing": return "The worker is producing or modifying task deliverables.";
    case "verifying": return "The worker is checking whether observed evidence satisfies the task.";
    case "committing": return "The worker is preserving completed changes as a source-control checkpoint.";
    case "consolidating": return "The worker is combining observed evidence into a reviewed outcome.";
    case "reporting": return "The worker is preparing the final task report.";
    case "blocked": return "The worker has encountered a blocker that prevents safe continuation.";
    default: return "The worker activity was recorded for timeline continuity.";
  }
}

function decisionNextStepForActivity(semanticPhase: string | undefined): string {
  switch (semanticPhase) {
    case "orienting":
    case "planning": return "Use the selected path to inspect, execute, or verify the next concrete step.";
    case "inspecting": return "Use the gathered evidence to decide whether to execute, verify, or report a blocker.";
    case "executing": return "Verify the produced or modified deliverable before claiming completion.";
    case "verifying": return "Use the validation result to consolidate, repair, or continue execution.";
    case "committing": return "Confirm the commit and proceed to the next task or final report.";
    case "consolidating": return "Prepare a concise report backed by the observed evidence.";
    case "reporting": return "Finish the task attempt with the reviewed public result.";
    case "blocked": return "Surface the blocker with the evidence needed for a safe decision.";
    default: return "Continue from the recorded worker activity.";
  }
}

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
  semanticPhase?: string,
  actionKind?: string,
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
        semantic_phase: semanticPhase ?? previous.semantic_phase,
        action_kind: actionKind ?? previous.action_kind,
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
  const requestPath = join(taskDir, "request.md");
  const requestText = existsSync(requestPath) ? readFileSync(requestPath, "utf8") : "";
  writeTrace("worker.start", {
    task_id: taskIdFromDir(),
    project_path: projectPath,
    model: model || null,
    request_chars: requestText.length,
    request_hash: stableHash(requestText),
    request_preview: compactPreview(requestText),
  });
  writeActivityEvent({
    event: "worker_started",
    semantic_phase: "orienting",
    action_kind: "run_command",
    status_line: "Worker task started.",
    current_title: "워커 작업을 시작합니다.",
    decision_summary: "Start worker task and build an activity timeline.",
    decision_rationale: "A durable append-only timeline is needed before projection updates can be trusted as current-state views.",
    decision_next_step: "Build the worker prompt and record each activity update as timeline history.",
    evidence_refs: [`request:${stableHash(requestText)}`],
  });
  const startedAt = Date.now();
  const result = await runWorkerTask({
    taskDir,
    projectPath,
    model: model || undefined,
    log,
    onActivity: ({ phase, semanticPhase, actionKind, statusLine, currentTitle, workBlock }) => {
      const workBlockId = workBlock && typeof workBlock === "object" ? (workBlock as { id?: unknown }).id : undefined;
      writeTrace("worker.activity", {
        phase,
        semantic_phase: semanticPhase,
        action_kind: actionKind,
        status_line: statusLine,
        current_title: currentTitle,
        work_block_id: workBlockId,
      });
      writeActivityEvent({
        event: "activity_updated",
        phase,
        semantic_phase: semanticPhase,
        action_kind: actionKind,
        status_line: statusLine,
        current_title: currentTitle,
        work_block_id: typeof workBlockId === "string" ? workBlockId : undefined,
        decision_summary: decisionSummaryForActivity(phase, semanticPhase, actionKind, statusLine),
        decision_rationale: decisionRationaleForActivity(semanticPhase),
        decision_next_step: decisionNextStepForActivity(semanticPhase),
      });
      writeActivity(
        phase,
        statusLine,
        currentTitle,
        workBlock as NonNullable<StoredWorkerActivity["work_blocks"]>[number] | undefined,
        semanticPhase,
        actionKind,
      );
    },
  });
  writeTrace("worker.finish", {
    duration_ms: Date.now() - startedAt,
    result_chars: result.length,
    result_hash: stableHash(result),
    result_preview: compactPreview(result),
  });
  writeActivityEvent({
    event: "worker_finished",
    semantic_phase: "reporting",
    action_kind: "report",
    status_line: "Worker task finished.",
    current_title: "워커 작업을 마쳤습니다.",
    decision_summary: "Finish worker task and preserve the result reference.",
    decision_rationale: "The final report should be tied back to the append-only activity timeline.",
    decision_next_step: "Use result evidence and timeline events for review or public reporting.",
    evidence_refs: [`result:${stableHash(result)}`],
  });
  process.stdout.write(result);
  if (!result.endsWith("\n")) process.stdout.write("\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeTrace("worker.error", { message: compactPreview(message, 500) });
  writeActivityEvent({
    event: "worker_failed",
    semantic_phase: "blocked",
    action_kind: "unknown",
    status_line: workerFailureStatusLine(message),
    current_title: "워커 작업이 중단되었습니다.",
    decision_summary: "Record worker failure as a timeline event.",
    decision_rationale: "Failures must remain visible in history instead of only overwriting the projection.",
    decision_next_step: "Review the error evidence and decide whether retry, repair, or user decision is appropriate.",
    evidence_refs: [`error:${stableHash(message)}`],
  });
  writeActivity("failed", workerFailureStatusLine(message));
  log(`ERROR: ${message}`);
  process.exit(1);
}
