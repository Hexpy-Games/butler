import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProfileExtractorModelRunner } from "../../../personalization/profiling.ts";
import {
  acquireConsolidationLock,
  consolidationLockPath,
  inspectConsolidationLock,
  releaseConsolidationLock,
} from "../memory/scripts/lib/lock.ts";
import { cognitionConsolidationRoot } from "../paths.ts";
import {
  buildConsolidationUsageReport,
  finishResult,
  metricsWithPhaseUsage,
  updateCheckpoint,
} from "./cycle-results.ts";
import type { NewChatBriefingModelRunner } from "./new-chat-briefing.ts";
import { runConsolidationPhase } from "./run-consolidation-phase.ts";
import type { ConsolidationUsageReport } from "./usage.ts";

export type ConsolidationPhase =
  | "preflight"
  | "feedback_triage"
  | "profile_consolidation"
  | "new_chat_briefing"
  | "box_index"
  | "memory_metadata_integrity"
  | "source_quality_aggregation"
  | "knowhow_revision"
  | "memory_health"
  | "box_retention"
  | "metrics_summary";

export type CognitionRateLimitBudget = {
  remainingRatio: number;
  resetAt?: string | null;
};

export type ConsolidationCycleStatus =
  | "completed"
  | "deferred_rate_limited"
  | "paused_rate_limited"
  | "lock_held"
  | "completed_with_errors";

export type ConsolidationCheckpoint = {
  schema: "butler.cognition.consolidation.checkpoint.v1";
  run_id: string;
  status: "running" | "paused_rate_limited" | "completed" | "completed_with_errors";
  created_at: string;
  updated_at: string;
  next_phase_index: number;
  completed_phases: ConsolidationPhase[];
  errors: Array<{ phase: ConsolidationPhase; message: string }>;
  rate_limit_reset_at: string | null;
};

export type ConsolidationPhaseResult = {
  phase: ConsolidationPhase;
  status: "ok" | "error" | "paused_rate_limited" | "deferred_rate_limited";
  metrics: Record<string, unknown>;
  error?: string;
};

export type ConsolidationCycleResult = {
  run_id: string;
  status: ConsolidationCycleStatus;
  started_at: string;
  completed_at: string | null;
  phases: ConsolidationPhaseResult[];
  checkpoint_path: string;
  summary_path: string;
  usage: ConsolidationUsageReport;
  raw_text_included: false;
};

export type RunCognitionConsolidationInput = {
  butlerData: string;
  manual?: boolean;
  runId?: string;
  resume?: boolean;
  now?: Date;
  rateLimitBudget?: () => CognitionRateLimitBudget | null;
  phaseHook?: (phase: ConsolidationPhase) => void | Promise<void>;
  profileExtractorModelRunner?: ProfileExtractorModelRunner;
  profileTranscriptSince?: string | Date | null;
  newChatBriefingModelRunner?: NewChatBriefingModelRunner;
};

const PHASES: ConsolidationPhase[] = [
  "preflight",
  "feedback_triage",
  "profile_consolidation",
  "new_chat_briefing",
  "box_index",
  "memory_metadata_integrity",
  "source_quality_aggregation",
  "knowhow_revision",
  "memory_health",
  "box_retention",
  "metrics_summary",
];

export function consolidationCheckpointPath(butlerData: string, runId: string): string {
  return join(cognitionConsolidationRoot(butlerData), "checkpoints", `${runId}.json`);
}

export function consolidationRunSummaryPath(butlerData: string, runId: string): string {
  return join(cognitionConsolidationRoot(butlerData), "runs", `${runId}.json`);
}

export function readConsolidationCheckpoint(
  butlerData: string,
  runId: string,
): ConsolidationCheckpoint | null {
  const path = consolidationCheckpointPath(butlerData, runId);
  return existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as ConsolidationCheckpoint
    : null;
}

export async function runCognitionConsolidationCycle(
  input: RunCognitionConsolidationInput,
): Promise<ConsolidationCycleResult> {
  const startedAt = iso(input.now);
  const runId = input.runId ?? `cr_${randomUUID()}`;
  const checkpointPath = consolidationCheckpointPath(input.butlerData, runId);
  const summaryPath = consolidationRunSummaryPath(input.butlerData, runId);
  const lockPath = consolidationLockPath(input.butlerData);
  const phases: ConsolidationPhaseResult[] = [];

  const preflightBudget = input.rateLimitBudget?.() ?? null;
  if (preflightBudget && preflightBudget.remainingRatio < 0.1) {
    const preflight = rateLimitPhase("deferred_rate_limited", preflightBudget);
    const result: ConsolidationCycleResult = {
      run_id: runId,
      status: "deferred_rate_limited",
      started_at: startedAt,
      completed_at: null,
      phases: [preflight],
      checkpoint_path: checkpointPath,
      summary_path: summaryPath,
      usage: buildConsolidationUsageReport([preflight]),
      raw_text_included: false,
    };
    writeJsonAtomic(summaryPath, result);
    return result;
  }

  if (!acquireConsolidationLock(lockPath)) {
    const info = inspectConsolidationLock(lockPath);
    const locked: ConsolidationPhaseResult = {
      phase: "preflight",
      status: "error",
      metrics: { lock_held: true, other_pid: info?.pid ?? null },
      error: "consolidation lock is held",
    };
    return {
      run_id: runId,
      status: "lock_held",
      started_at: startedAt,
      completed_at: null,
      phases: [locked],
      checkpoint_path: checkpointPath,
      summary_path: summaryPath,
      usage: buildConsolidationUsageReport([locked]),
      raw_text_included: false,
    };
  }

  let checkpoint = input.resume ? readConsolidationCheckpoint(input.butlerData, runId) : null;
  checkpoint ??= newCheckpoint(runId, startedAt);
  try {
    for (let index = checkpoint.next_phase_index; index < PHASES.length; index += 1) {
      const phase = PHASES[index]!;
      const budget = input.rateLimitBudget?.() ?? null;
      if (budget && budget.remainingRatio < 0.1) {
        checkpoint = updateCheckpoint(checkpoint, {
          status: "paused_rate_limited",
          next_phase_index: index,
          rate_limit_reset_at: budget.resetAt ?? null,
        });
        writeJsonAtomic(checkpointPath, checkpoint);
        phases.push(rateLimitPhase("paused_rate_limited", budget, phase));
        const result = finishResult(
          input.butlerData, runId, startedAt, "paused_rate_limited",
          phases, checkpointPath, summaryPath, null, checkpoint,
        );
        writeJsonAtomic(summaryPath, result);
        return result;
      }
      checkpoint = await runAndCheckpointPhase({
        input, runId, phase, index, phases, checkpoint, checkpointPath,
      });
    }

    const status = checkpoint.errors.length > 0 ? "completed_with_errors" : "completed";
    checkpoint = updateCheckpoint(checkpoint, { status, next_phase_index: PHASES.length });
    writeJsonAtomic(checkpointPath, checkpoint);
    const result = finishResult(
      input.butlerData, runId, startedAt, status,
      phases, checkpointPath, summaryPath, iso(), checkpoint,
    );
    writeJsonAtomic(summaryPath, result);
    return result;
  } finally {
    releaseConsolidationLock(lockPath);
  }
}

async function runAndCheckpointPhase(input: {
  input: RunCognitionConsolidationInput;
  runId: string;
  phase: ConsolidationPhase;
  index: number;
  phases: ConsolidationPhaseResult[];
  checkpoint: ConsolidationCheckpoint;
  checkpointPath: string;
}): Promise<ConsolidationCheckpoint> {
  let checkpoint = input.checkpoint;
  try {
    await input.input.phaseHook?.(input.phase);
    const startedAt = Date.now();
    const metrics = await runConsolidationPhase(
      input.input.butlerData,
      input.phase,
      { ...input.input, runId: input.runId },
    );
    input.phases.push({
      phase: input.phase,
      status: "ok",
      metrics: metricsWithPhaseUsage(
        input.input.butlerData, input.runId, input.phase, startedAt, metrics,
      ),
    });
    checkpoint = updateCheckpoint(checkpoint, {
      status: "running",
      next_phase_index: input.index + 1,
      completed_phases: [...checkpoint.completed_phases, input.phase],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.phases.push({ phase: input.phase, status: "error", metrics: {}, error: message });
    checkpoint = updateCheckpoint(checkpoint, {
      status: "running",
      next_phase_index: input.index + 1,
      errors: [...checkpoint.errors, { phase: input.phase, message }],
    });
  }
  writeJsonAtomic(input.checkpointPath, checkpoint);
  return checkpoint;
}

function newCheckpoint(runId: string, startedAt: string): ConsolidationCheckpoint {
  return {
    schema: "butler.cognition.consolidation.checkpoint.v1",
    run_id: runId,
    status: "running",
    created_at: startedAt,
    updated_at: startedAt,
    next_phase_index: 0,
    completed_phases: [],
    errors: [],
    rate_limit_reset_at: null,
  };
}

function rateLimitPhase(
  status: "paused_rate_limited" | "deferred_rate_limited",
  budget: CognitionRateLimitBudget,
  phase: ConsolidationPhase = "preflight",
): ConsolidationPhaseResult {
  return {
    phase,
    status,
    metrics: { remaining_ratio: budget.remainingRatio, reset_at: budget.resetAt ?? null },
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function iso(date: Date = new Date()): string {
  return date.toISOString();
}
