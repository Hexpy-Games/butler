import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProfileExtractorModelRunner } from "../../../personalization/profiling.ts";
import { cognitionConsolidationRoot } from "../paths.ts";
import {
  acquireConsolidationLockAsync,
  consolidationLockPath,
  releaseConsolidationLock,
} from "../memory/scripts/lib/lock.ts";
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
  errors: Array<{ phase: ConsolidationPhase; message: string; resolved_at?: string }>;
  rate_limit_reset_at: string | null;
  active_phase?: { phase: ConsolidationPhase; owner_pid: number; owner_nonce: string; started_at: string } | null;
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
  signal?: AbortSignal;
  deadlineAt?: number;
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
    await withCheckpointLease(input.butlerData, input, () => writeJsonAtomic(summaryPath, result));
    return result;
  }

  let checkpoint = input.resume ? readConsolidationCheckpoint(input.butlerData, runId) : null;
  checkpoint ??= newCheckpoint(runId, startedAt);
  const firstUnfinished = input.resume
      ? PHASES.findIndex((phase) => !checkpoint!.completed_phases.includes(phase))
      : checkpoint.next_phase_index;
    const startIndex = firstUnfinished < 0 ? PHASES.length : firstUnfinished;
    const resumePhases = input.resume
      ? new Set(PHASES.filter((phase) => !checkpoint!.completed_phases.includes(phase)))
      : null;
    for (let index = startIndex; index < PHASES.length; index += 1) {
      const phase = PHASES[index]!;
      if (checkpoint.completed_phases.includes(phase)) continue;
      const budget = input.rateLimitBudget?.() ?? null;
      if (budget && budget.remainingRatio < 0.1) {
        const prior = checkpoint;
        const nextCheckpoint = updateCheckpoint(checkpoint, {
          status: "paused_rate_limited",
          next_phase_index: index,
          rate_limit_reset_at: budget.resetAt ?? null,
        });
        phases.push(rateLimitPhase("paused_rate_limited", budget, phase));
        const result = finishResult(
          input.butlerData, runId, startedAt, "paused_rate_limited",
          phases, checkpointPath, summaryPath, null, nextCheckpoint,
        );
        checkpoint = await commitCycleState(input.butlerData, runId, prior, nextCheckpoint, checkpointPath, summaryPath, result, input);
        return result;
      }
      try {
        checkpoint = await runAndCheckpointPhase({
        input, runId, phase, index, phases, checkpoint, checkpointPath, resumePhases,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "memory_write_busy") throw error;
        const locked: ConsolidationPhaseResult = {
          phase,
          status: "error",
          metrics: { lock_held: true },
          error: "consolidation lock is held",
        };
        const contendedPhases = [...phases, locked];
        return {
          run_id: runId,
          status: "lock_held",
          started_at: startedAt,
          completed_at: null,
          phases: contendedPhases,
          checkpoint_path: checkpointPath,
          summary_path: summaryPath,
          usage: buildConsolidationUsageReport(contendedPhases),
          raw_text_included: false,
        };
      }
    }

    const status = checkpoint.errors.some((error) => !error.resolved_at)
      ? "completed_with_errors"
      : "completed";
    const prior = checkpoint;
    const nextCheckpoint = updateCheckpoint(checkpoint, { status, next_phase_index: PHASES.length });
    const result = finishResult(
      input.butlerData, runId, startedAt, status,
      phases, checkpointPath, summaryPath, iso(), nextCheckpoint,
    );
    checkpoint = await commitCycleState(input.butlerData, runId, prior, nextCheckpoint, checkpointPath, summaryPath, result, input);
    return result;
}

async function commitCycleState(
  butlerData: string,
  runId: string,
  expected: ConsolidationCheckpoint,
  next: ConsolidationCheckpoint,
  checkpointPath: string,
  summaryPath: string,
  result: ConsolidationCycleResult,
  timing: Pick<RunCognitionConsolidationInput, "signal" | "deadlineAt">,
): Promise<ConsolidationCheckpoint> {
  return await withCheckpointLease(butlerData, timing, () => {
    const current = readConsolidationCheckpoint(butlerData, runId);
    if ((current && (current.updated_at !== expected.updated_at || current.active_phase)) ||
      (!current && expected.next_phase_index !== 0)) throw new Error("consolidation_checkpoint_changed");
    writeJsonAtomic(checkpointPath, next);
    writeJsonAtomic(summaryPath, result);
    return next;
  });
}

async function runAndCheckpointPhase(input: {
  input: RunCognitionConsolidationInput;
  runId: string;
  phase: ConsolidationPhase;
  index: number;
  phases: ConsolidationPhaseResult[];
  checkpoint: ConsolidationCheckpoint;
  checkpointPath: string;
  resumePhases: Set<ConsolidationPhase> | null;
}): Promise<ConsolidationCheckpoint> {
  const ownerNonce = randomUUID();
  const operationKey = JSON.stringify([input.input.butlerData, input.runId, input.phase, ownerNonce]);
  let checkpoint = await withCheckpointLease(input.input.butlerData, input.input, () => {
    const current = readConsolidationCheckpoint(input.input.butlerData, input.runId) ?? input.checkpoint;
    const active = current.active_phase;
    if (active && (active.owner_pid === process.pid
      ? activeCheckpointOperations.has(JSON.stringify([input.input.butlerData, input.runId, active.phase, active.owner_nonce]))
      : pidAlive(active.owner_pid))) throw new Error("memory_write_busy");
    const eligible = input.resumePhases
      ? input.resumePhases.has(input.phase)
      : current.next_phase_index === input.index;
    if (current.updated_at !== input.checkpoint.updated_at ||
      current.completed_phases.includes(input.phase) || !eligible) {
      throw new Error("consolidation_checkpoint_changed");
    }
    const claimed = updateCheckpoint(current, {
      active_phase: { phase: input.phase, owner_pid: process.pid, owner_nonce: ownerNonce, started_at: iso() },
    });
    writeJsonAtomic(input.checkpointPath, claimed);
    return claimed;
  });
  activeCheckpointOperations.add(operationKey);
  const startedAt = Date.now();
  try {
    await input.input.phaseHook?.(input.phase);
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
      errors: checkpoint.errors.map((error) =>
        error.phase === input.phase && !error.resolved_at ? { ...error, resolved_at: iso() } : error,
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMetrics = phaseErrorMetrics(error);
    input.phases.push({
      phase: input.phase,
      status: "error",
      metrics: metricsWithPhaseUsage(
        input.input.butlerData, input.runId, input.phase, startedAt, safeMetrics,
      ),
      error: message,
    });
    checkpoint = updateCheckpoint(checkpoint, {
      status: "running",
      next_phase_index: input.index + 1,
      errors: [...checkpoint.errors, { phase: input.phase, message }],
    });
  }
  try {
    return await withCheckpointLease(input.input.butlerData, input.input, () => {
      const current = readConsolidationCheckpoint(input.input.butlerData, input.runId);
      if (!current || current.active_phase?.owner_nonce !== ownerNonce || current.active_phase.phase !== input.phase)
        throw new Error("consolidation_checkpoint_changed");
      const committed = updateCheckpoint(checkpoint, { active_phase: null });
      writeJsonAtomic(input.checkpointPath, committed);
      return committed;
    });
  } finally { activeCheckpointOperations.delete(operationKey); }
}

const activeCheckpointOperations = new Set<string>();

async function withCheckpointLease<T>(
  butlerData: string,
  timing: Pick<RunCognitionConsolidationInput, "signal" | "deadlineAt">,
  run: () => T,
): Promise<T> {
  const path = consolidationLockPath(butlerData);
  const lease = await acquireConsolidationLockAsync(path, {
    purpose: "consolidation",
    waitClass: "background",
    signal: timing.signal,
    deadlineAt: timing.deadlineAt,
  });
  if (!lease) throw new Error("memory_write_busy");
  let commit = false;
  try { const result = run(); commit = true; return result; }
  finally { releaseConsolidationLock(path, lease, commit); }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function phaseErrorMetrics(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const metrics = (error as { metrics?: unknown }).metrics;
  return metrics && typeof metrics === "object" && !Array.isArray(metrics)
    ? metrics as Record<string, unknown>
    : {};
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
