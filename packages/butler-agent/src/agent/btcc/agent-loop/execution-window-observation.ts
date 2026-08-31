import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type {
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import type { GuidedToolJournalRecord } from "../ports/index.ts";
import type {
  DurableWorkContext,
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import { safeBoundWork, safeLoadWorkContext } from "./guided-work-runtime.ts";

export function createGuidedExecutionWindowObserver(input: {
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  turnId: string;
  trackingMode: "ledger" | "local" | "none";
  role: string;
  workspacePath: string;
  listToolRecords: () => GuidedToolJournalRecord[];
  signal: AbortSignal;
}) {
  let observedToolResults = 0;
  let priorWorkerState: string | null = null;
  let workerBlockedReport: string | null = null;
  const observe = async ({
    windowIndex,
    toolResults,
  }: {
    windowIndex: number;
    toolResults: readonly BtccAgentLoopToolResult[];
  }) => {
    if (input.signal.aborted) throwGuidedAbort(input.signal);
    const windowToolResults = toolResults.slice(observedToolResults);
    observedToolResults = toolResults.length;
    if (input.role === "worker") {
      const issue = executionWindowIssueSignature(windowToolResults);
      if (issue) {
        const workspace = await trackedWorkspaceFingerprint(
          input.workspacePath,
          input.listToolRecords(),
        );
        const state = `${issue}\0${workspace}`;
        if (state === priorWorkerState) {
          workerBlockedReport = [
            "Worker could not complete the assigned Plan action.",
            "Two consecutive execution windows repeated the same failed, unchanged, or redundant tool pattern without changing the tracked workspace output.",
            `Observed pattern: ${issue}.`,
            "The Steward should inspect this result and steer, revise, split, or reassign the Plan action.",
          ].join(" ");
          return undefined;
        }
        priorWorkerState = state;
      } else {
        priorWorkerState = null;
      }
    }
    const context = input.trackingMode === "none"
      ? null
      : await safeLoadWorkContext(input.durableWork, input.workScope);
    const boundWork = input.trackingMode === "none"
      ? null
      : await safeBoundWork(input.durableWork, input.turnId);
    return renderExecutionWindowObservation({
      windowIndex,
      context,
      boundWork,
      toolResults: windowToolResults,
    });
  };
  return {
    observe,
    blockedReport: () => workerBlockedReport,
  };
}

export function renderExecutionWindowObservation(input: {
  windowIndex: number;
  context: DurableWorkContext | null;
  boundWork: DurableWorkView | null;
  toolResults: readonly BtccAgentLoopToolResult[];
}): string {
  const work = input.context?.work ?? input.boundWork;
  const diagnosis = diagnoseExecutionWindow(input.toolResults);
  const lines = [
    `Execution checkpoint ${input.windowIndex + 1}: this is an internal diagnosis boundary, not a failure or completion condition.`,
    diagnosis.summary,
    ...diagnosis.details,
  ];
  if (!work) {
    lines.push(
      "No durable Work checkpoint is available. Preserve the prior messages and diagnose the next useful step from the evidence already present.",
    );
  } else {
    lines.push(`Durable Work status: ${work.status}.`);
    if (work.currentStage) lines.push(`Current stage: ${work.currentStage}.`);
    if (work.latestCheckpoint?.publicSummary) {
      lines.push(`Latest checkpoint: ${singleLine(work.latestCheckpoint.publicSummary, 600)}`);
    }
    if (work.latestCheckpoint?.nextStep) {
      lines.push(`Recorded next step: ${singleLine(work.latestCheckpoint.nextStep, 400)}`);
    }
  }
  lines.push(
    "Before another tool call, determine why the previous window did not finish. Do not repeat an unchanged or failed action. If the original task is already complete, return its normal report; otherwise take one materially different next step.",
  );
  return lines.join("\n");
}

function diagnoseExecutionWindow(toolResults: readonly BtccAgentLoopToolResult[]): {
  summary: string;
  details: string[];
} {
  if (toolResults.length === 0) {
    return {
      summary: "Window diagnosis: no tool result was produced.",
      details: ["Review the model response path before choosing another action."],
    };
  }
  const failed = toolResults.filter((result) => !result.ok);
  const unchanged = toolResults.filter(isNoChangeMutation);
  const counts = new Map<string, number>();
  for (const result of toolResults) {
    counts.set(result.name, (counts.get(result.name) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  const details: string[] = [];
  if (unchanged.length > 0) {
    details.push(`No-change mutations: ${unchanged.length}. They did not advance the task.`);
  }
  if (failed.length > 0) {
    const codes = [...new Set(failed.map((result) => result.ok ? "" : result.error.code))]
      .filter(Boolean)
      .join(", ");
    details.push(`Failed tool results: ${failed.length}${codes ? ` (${codes})` : ""}.`);
  }
  if (repeated && repeated[1] >= 3) {
    details.push(`Repeated tool pattern: ${repeated[0]} appeared ${repeated[1]} times.`);
  }
  return {
    summary: `Window diagnosis: ${toolResults.length - failed.length} successful and ${failed.length} failed tool results.`,
    details,
  };
}

function executionWindowIssueSignature(
  toolResults: readonly BtccAgentLoopToolResult[],
): string | null {
  if (toolResults.length === 0) return "no tool result";
  const failedCodes = [...new Set(toolResults.flatMap((result) =>
    result.ok ? [] : [result.error.code]))].sort();
  const counts = new Map<string, number>();
  for (const result of toolResults) {
    counts.set(result.name, (counts.get(result.name) ?? 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  const parts = [
    ...(failedCodes.length ? [`failures ${failedCodes.join(",")}`] : []),
    ...(toolResults.some(isNoChangeMutation) ? ["no-change mutation"] : []),
    ...(repeated ? [`repeated ${repeated[0]}`] : []),
  ];
  return parts.length ? parts.join("; ") : null;
}

async function trackedWorkspaceFingerprint(
  workspacePath: string,
  records: readonly GuidedToolJournalRecord[],
): Promise<string> {
  const paths = [...new Set(records.flatMap((record) =>
    record.changedFiles?.map((file) => file.path) ?? []))].sort();
  if (paths.length === 0) return "no tracked file output";
  const workspaceRoot = resolve(workspacePath);
  const hash = createHash("sha256");
  for (const path of paths) {
    const absolutePath = resolve(workspaceRoot, path);
    const inside = relative(workspaceRoot, absolutePath);
    if (inside.startsWith("..") || inside.startsWith("/")) continue;
    hash.update(path).update("\0");
    try {
      hash.update(await readFile(absolutePath));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isNoChangeMutation(result: BtccAgentLoopToolResult): boolean {
  if (!result.ok) return result.error.code === "no_change_requested";
  if (result.name !== "edit_file" && result.name !== "write_file") return false;
  const output = record(result.output);
  return typeof output?.before_sha256 === "string" &&
    output.before_sha256 === output.after_sha256;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function singleLine(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function throwGuidedAbort(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided Turn was aborted");
}
