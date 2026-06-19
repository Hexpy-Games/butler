#!/usr/bin/env bun

import { NativeToolLoopRuntime } from "../src/agent/turn/native-tool-loop.ts";
import { WorkStreamStore } from "../src/agent/work/work-stream.ts";
import type { ModelProviderAdapter, ModelRef } from "../src/test-support/harness/contracts.ts";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runWorkerDependencyPreflight } from "./worker-dependency-preflight.ts";

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
  evidence_summary?: {
    inspecting: number;
    executing: number;
    verifying: number;
    committing: number;
    blocked: number;
  };
  completion_contract?: {
    has_execution_evidence: boolean;
    has_verification_evidence: boolean;
    has_commit_evidence: boolean;
    has_blocker_evidence: boolean;
  };
  completion_review?: "satisfied" | "unsatisfied" | "blocked";
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


function _readActivityEvents(): WorkerActivityTimelineEvent[] {
  const path = join(taskDir, "worker_activity_events.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerActivityTimelineEvent);
  } catch {
    return [];
  }
}

function _summarizeCompletionEvidence(events: WorkerActivityTimelineEvent[]): NonNullable<WorkerActivityTimelineEvent["evidence_summary"]> {
  const summary = { inspecting: 0, executing: 0, verifying: 0, committing: 0, blocked: 0 };
  for (const event of events) {
    switch (event.semantic_phase) {
      case "inspecting": summary.inspecting += 1; break;
      case "executing": summary.executing += 1; break;
      case "verifying": summary.verifying += 1; break;
      case "committing": summary.committing += 1; break;
      case "blocked": summary.blocked += 1; break;
    }
  }
  return summary;
}

function _completionContractForEvidence(summary: NonNullable<WorkerActivityTimelineEvent["evidence_summary"]>): NonNullable<WorkerActivityTimelineEvent["completion_contract"]> {
  return {
    has_execution_evidence: summary.executing > 0,
    has_verification_evidence: summary.verifying > 0,
    has_commit_evidence: summary.committing > 0,
    has_blocker_evidence: summary.blocked > 0,
  };
}

function _completionReviewForEvidence(contract: NonNullable<WorkerActivityTimelineEvent["completion_contract"]>): NonNullable<WorkerActivityTimelineEvent["completion_review"]> {
  if (contract.has_blocker_evidence) return "blocked";
  return contract.has_execution_evidence || contract.has_verification_evidence || contract.has_commit_evidence
    ? "satisfied"
    : "unsatisfied";
}

function _completionObligationsForActivity(semanticPhase: string | undefined, actionKind: string | undefined): string[] {
  const obligations = new Set<string>();
  if (semanticPhase === "executing") obligations.add("implementation_evidence");
  if (semanticPhase === "verifying") obligations.add("validation_evidence");
  if (semanticPhase === "committing") obligations.add("commit_evidence");
  if (semanticPhase === "blocked") obligations.add("blocker_evidence");
  if (actionKind === "edit_file" || actionKind === "write_file" || actionKind === "apply_patch") obligations.add("implementation_evidence");
  if (actionKind === "test" || actionKind === "typecheck" || actionKind === "git_status" || actionKind === "git_diff") obligations.add("validation_evidence");
  if (actionKind === "commit") obligations.add("commit_evidence");
  return [...obligations];
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

function loadFileIfExists(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function butlerHome(): string {
  return process.env.BUTLER_HOME || process.cwd();
}

function butlerData(): string {
  return process.env.BUTLER_DATA || join(process.env.HOME || process.cwd(), ".butler");
}

function workerSessionId(): string {
  const stored = loadFileIfExists(join(taskDir, "session_id"));
  return `worker/${stored || taskIdFromDir() || "unknown"}`;
}

function workerModelRef(value: string): ModelRef {
  const trimmed = value.trim();
  if (trimmed.includes("/")) return trimmed as ModelRef;
  return `openai/${trimmed || "auto:codex-latest"}` as ModelRef;
}

function workerSystemPrompt(): string {
  const home = butlerHome();
  const core = loadFileIfExists(join(home, "packages", "butler-agent", "resources", "prompts", "runtime-system-contract.md"));
  const worker = loadFileIfExists(join(home, "packages", "butler-agent", "resources", "prompts", "worker.md"));
  const nativeContract = [
    "You are a Butler Worker runtime actor.",
    "Use the same BTCC and WorkStream discipline as the main Butler session.",
    "Do not spawn child workers or orchestrations. Do not publish the principal-facing final report.",
    "For implementation-required work, produce implementation evidence, validation evidence, or an explicit blocker before finishing.",
  ].join("\n");
  return [core, worker, nativeContract].filter(Boolean).join("\n\n");
}

function workerPrompt(requestText: string): string {
  const preflight = loadFileIfExists(join(taskDir, "worker-preflight.md"));
  return [
    `Task ID: ${taskIdFromDir() ?? "unknown"}`,
    `Project path: ${projectPath}`,
    "",
    ...(preflight
      ? [
        "Workspace dependency preflight:",
        preflight,
        "",
      ]
      : []),
    "Task:",
    requestText,
  ].join("\n");
}

const nativeProvider: ModelProviderAdapter = {
  id: "native-worker-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "" };
  },
};

async function runNativeWorkerTask(input: {
  requestText: string;
}): Promise<string> {
  const runtime = new NativeToolLoopRuntime({
    butlerHome: butlerHome(),
    butlerData: butlerData(),
    disableAutomaticRecall: true,
  });
  const handle = await runtime.createSession({
    sessionId: workerSessionId(),
    role: "worker",
    workspacePath: projectPath,
    systemPrompt: workerSystemPrompt(),
    metadata: {
      projectPath,
      workerTaskId: taskIdFromDir(),
      parentTaskDir: taskDir,
    },
  });
  const result = await runtime.runTurn({
    handle,
    provider: nativeProvider,
    model: workerModelRef(model),
    input: {
      text: workerPrompt(input.requestText),
    },
    metadata: {
      runtimePolicy: {
        requiredNativeTools: [
          "update_todo_list",
          "run_command",
        ],
      },
    },
    emitTurnEvent: (event) => {
      writeTrace("native.turn_event", {
        kind: event.kind,
        payload: event.payload,
      });
      projectNativeTurnEvent(event.kind, event.payload);
    },
  });
  try {
    new WorkStreamStore(butlerData()).link({
      sessionId: workerSessionId(),
      workerTaskIds: [taskIdFromDir() ?? ""].filter(Boolean),
    });
  } catch {
    // WorkStream linkage is best-effort for legacy task directories.
  }
  return result.text;
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

function stringFromPayload(payload: unknown, key: string): string {
  if (!payload || typeof payload !== "object") return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function classifyNativeWorkerActivity(kind: string, payload: unknown): {
  semanticPhase: string;
  actionKind: string;
  statusLine: string;
  currentTitle: string;
} | null {
  if (kind !== "tool.completed" && kind !== "tool.failed") return null;
  const toolName = stringFromPayload(payload, "toolName");
  const activityKind = stringFromPayload(payload, "activityKind");
  const label = [
    stringFromPayload(payload, "workBlockLabel"),
    stringFromPayload(payload, "label"),
    stringFromPayload(payload, "inputLabel"),
    stringFromPayload(payload, "safeLabel"),
    stringFromPayload(payload, "decisionSummary"),
  ].join(" ").toLocaleLowerCase("en-US");
  const failed = kind === "tool.failed";
  if (failed) {
    return {
      semanticPhase: "blocked",
      actionKind: "unknown",
      statusLine: "Blocked: worker tool call failed.",
      currentTitle: "도구 실행이 실패했습니다.",
    };
  }
  if (/edit|updat|writ|patch|수정|보강|변경/u.test(label)) {
    return {
      semanticPhase: "executing",
      actionKind: "edit_file",
      statusLine: "Editing worker deliverable.",
      currentTitle: "작업 산출물을 수정하는 중입니다.",
    };
  }
  if (/verif|review|검증|확인|diff|test|lint|typecheck/u.test(label)) {
    return {
      semanticPhase: "verifying",
      actionKind: /diff/u.test(label) ? "git_diff" : "test",
      statusLine: "Verifying worker changes.",
      currentTitle: "수정 결과를 검증하는 중입니다.",
    };
  }
  if (toolName || activityKind) {
    return {
      semanticPhase: "inspecting",
      actionKind: toolName === "Bash" || activityKind === "ran_command" ? "run_command" : "read",
      statusLine: "Inspecting worker context.",
      currentTitle: "작업 맥락을 확인하는 중입니다.",
    };
  }
  return null;
}

function projectNativeTurnEvent(kind: string, payload: unknown): void {
  const activity = classifyNativeWorkerActivity(kind, payload);
  if (!activity) return;
  const workBlockId = stringFromPayload(payload, "workBlockId") || undefined;
  writeActivityEvent({
    event: "activity_updated",
    semantic_phase: activity.semanticPhase,
    action_kind: activity.actionKind,
    status_line: activity.statusLine,
    current_title: activity.currentTitle,
    decision_summary: stringFromPayload(payload, "decisionSummary") || activity.statusLine,
    decision_rationale: stringFromPayload(payload, "decisionRationale") || "Projected from the native Worker runtime tool timeline.",
    decision_next_step: stringFromPayload(payload, "decisionNextStep") || "Continue the Worker BTCC execution loop.",
    evidence_refs: [kind, workBlockId].filter((value): value is string => Boolean(value)),
    completion_obligations: _completionObligationsForActivity(activity.semanticPhase, activity.actionKind),
    work_block_id: workBlockId,
  });
  writeActivity(
    activity.semanticPhase,
    activity.statusLine,
    activity.currentTitle,
    workBlockId ? {
      id: workBlockId,
      label: stringFromPayload(payload, "workBlockLabel") || activity.currentTitle,
      state: kind === "tool.completed" ? "delivered" : "failed",
    } : undefined,
    activity.semanticPhase,
    activity.actionKind,
  );
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

function stopForDependencyPreflight(input: {
  findings: string[];
  guidance: string[];
}): never {
  const message = [
    "Blocked: dependency setup required before worker validation.",
    "",
    "Findings:",
    ...input.findings.map((finding) => `- ${finding}`),
    "",
    "Validation guidance:",
    ...input.guidance.map((item) => `- ${item}`),
  ].join("\n");
  writeFileSync(join(taskDir, "result.md"), `${message}\n`, "utf8");
  writeActivityEvent({
    event: "worker_failed",
    semantic_phase: "blocked",
    action_kind: "dependency_preflight",
    status_line: "Blocked: dependency setup required before worker validation.",
    current_title: "워커 의존성 준비가 필요합니다.",
    decision_summary: "Stop worker before model execution because dependency preflight failed.",
    decision_rationale: "Validation would be unreliable until local project dependencies are installed.",
    decision_next_step: "Run the preflight install command, then retry the worker.",
    evidence_refs: ["worker-preflight.md", "worker-preflight.json"],
    completion_obligations: ["blocker_evidence"],
    completion_review: "blocked",
  });
  writeActivity("failed", "Blocked: dependency setup required before worker validation.");
  log("Dependency preflight failed; stopping before model execution.");
  process.exit(1);
}

try {
  const dependencyPreflight = runWorkerDependencyPreflight({ taskDir, projectPath });
  const requestPath = join(taskDir, "request.md");
  const requestText = existsSync(requestPath) ? readFileSync(requestPath, "utf8") : "";
  writeTrace("worker.dependency_preflight", {
    status: dependencyPreflight.status,
    package_manager: dependencyPreflight.package_manager,
    install_command: dependencyPreflight.install_command,
    findings: dependencyPreflight.findings,
  });
  if (dependencyPreflight.status === "needs_dependency_setup") {
    stopForDependencyPreflight({
      findings: dependencyPreflight.findings,
      guidance: dependencyPreflight.validation_guidance,
    });
  }
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
  const result = await runNativeWorkerTask({ requestText });
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
