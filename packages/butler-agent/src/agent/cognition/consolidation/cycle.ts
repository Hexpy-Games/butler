import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { cognitionConsolidationRoot } from "../paths.ts";
import { activeFeedbackEntries, resolveFeedbackEntry } from "../feedback/buffer.ts";
import { boxItemRoot, listBoxManifests, rebuildBoxIndex, writeBoxManifest, type BoxManifest } from "../box/store.ts";
import { aggregateSourceQuality, listKnowHowEntries, rebuildKnowHowIndex, writeKnowHowEntry, type KnowHowEntry } from "../know-how/store.ts";
import { checkMemoryMetadataIntegrity } from "../memory/metadata.ts";
import { readMemoryHealth } from "../memory/quality.ts";
import {
  acquireConsolidationLock,
  consolidationLockPath,
  inspectConsolidationLock,
  releaseConsolidationLock,
} from "../memory/scripts/lib/lock.ts";
import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import { readPromptCacheMetrics } from "../../../integrations/providers/prompt-cache-metrics.ts";
import {
  captureProfileCandidatesFromFeedback,
  captureProfileCandidatesFromTranscriptsWithModel,
  consolidateProfileCandidates,
  isProfilingEnabled,
  type ProfileExtractorModelRunner,
} from "../../../personalization/profiling.ts";
import {
  generateNewChatBriefings,
  type NewChatBriefingModelRunner,
} from "./new-chat-briefing.ts";
import {
  emptyModelUsageSummary,
  mergeModelUsage,
  modelUsageFromUnknown,
  usageFromPromptCacheMetricEvents,
  type ConsolidationPhaseUsageSummary,
  type ConsolidationUsageReport,
} from "./usage.ts";

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

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function consolidationCheckpointPath(butlerData: string, runId: string): string {
  return join(cognitionConsolidationRoot(butlerData), "checkpoints", `${runId}.json`);
}

export function consolidationRunSummaryPath(butlerData: string, runId: string): string {
  return join(cognitionConsolidationRoot(butlerData), "runs", `${runId}.json`);
}

function latestProfileConsolidationCompletedAt(
  butlerData: string,
  currentRunId: string | undefined,
): string | null {
  const root = join(cognitionConsolidationRoot(butlerData), "runs");
  if (!existsSync(root)) return null;
  let latest: { completedAt: string; ms: number } | null = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const summary = readJsonObject(join(root, entry.name));
    if (!summary) continue;
    if (typeof summary.run_id === "string" && summary.run_id === currentRunId) continue;
    if (summary.status !== "completed" && summary.status !== "completed_with_errors") continue;
    const completedAt = typeof summary.completed_at === "string" ? summary.completed_at : null;
    if (!completedAt) continue;
    const phases: unknown[] = Array.isArray(summary.phases) ? summary.phases : [];
    const profilePhase = phases.find((phase: unknown) =>
      Boolean(
        phase &&
          typeof phase === "object" &&
          !Array.isArray(phase) &&
          (phase as { phase?: unknown }).phase === "profile_consolidation" &&
          (phase as { status?: unknown }).status === "ok",
      ),
    );
    if (!profilePhase) continue;
    const ms = Date.parse(completedAt);
    if (!Number.isFinite(ms)) continue;
    if (!latest || ms > latest.ms) latest = { completedAt, ms };
  }
  return latest?.completedAt ?? null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function readConsolidationCheckpoint(butlerData: string, runId: string): ConsolidationCheckpoint | null {
  const path = consolidationCheckpointPath(butlerData, runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ConsolidationCheckpoint;
}

export async function runCognitionConsolidationCycle(input: RunCognitionConsolidationInput): Promise<ConsolidationCycleResult> {
  const startedAt = iso(input.now);
  const runId = input.runId ?? `cr_${randomUUID()}`;
  const checkpointPath = consolidationCheckpointPath(input.butlerData, runId);
  const summaryPath = consolidationRunSummaryPath(input.butlerData, runId);
  const lockPath = consolidationLockPath(input.butlerData);
  const phases: ConsolidationPhaseResult[] = [];

  const preflightBudget = input.rateLimitBudget?.() ?? null;
  if (preflightBudget && preflightBudget.remainingRatio < 0.1) {
    const result: ConsolidationCycleResult = {
      run_id: runId,
      status: "deferred_rate_limited",
      started_at: startedAt,
      completed_at: null,
      phases: [{
        phase: "preflight",
        status: "deferred_rate_limited",
        metrics: { remaining_ratio: preflightBudget.remainingRatio, reset_at: preflightBudget.resetAt ?? null },
      }],
      checkpoint_path: checkpointPath,
      summary_path: summaryPath,
      usage: buildConsolidationUsageReport([{
        phase: "preflight",
        status: "deferred_rate_limited",
        metrics: { remaining_ratio: preflightBudget.remainingRatio, reset_at: preflightBudget.resetAt ?? null },
      }]),
      raw_text_included: false,
    };
    writeJsonAtomic(summaryPath, result);
    return result;
  }

  if (!acquireConsolidationLock(lockPath)) {
    const info = inspectConsolidationLock(lockPath);
    return {
      run_id: runId,
      status: "lock_held",
      started_at: startedAt,
      completed_at: null,
      phases: [{
        phase: "preflight",
        status: "error",
        metrics: { lock_held: true, other_pid: info?.pid ?? null },
        error: "consolidation lock is held",
      }],
      checkpoint_path: checkpointPath,
      summary_path: summaryPath,
      usage: buildConsolidationUsageReport([{
        phase: "preflight",
        status: "error",
        metrics: { lock_held: true, other_pid: info?.pid ?? null },
        error: "consolidation lock is held",
      }]),
      raw_text_included: false,
    };
  }

  let checkpoint = input.resume ? readConsolidationCheckpoint(input.butlerData, runId) : null;
  checkpoint ??= {
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
        phases.push({
          phase,
          status: "paused_rate_limited",
          metrics: { remaining_ratio: budget.remainingRatio, reset_at: budget.resetAt ?? null },
        });
        const result = finishResult(input.butlerData, runId, startedAt, "paused_rate_limited", phases, checkpointPath, summaryPath, null, checkpoint);
        writeJsonAtomic(summaryPath, result);
        return result;
      }

      try {
        await input.phaseHook?.(phase);
        const phaseUsageStartedAt = Date.now();
        const metrics = await runPhase(input.butlerData, phase, { ...input, runId });
        phases.push({
          phase,
          status: "ok",
          metrics: metricsWithPhaseUsage(input.butlerData, runId, phase, phaseUsageStartedAt, metrics),
        });
        checkpoint = updateCheckpoint(checkpoint, {
          status: "running",
          next_phase_index: index + 1,
          completed_phases: [...checkpoint.completed_phases, phase],
        });
        writeJsonAtomic(checkpointPath, checkpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        phases.push({ phase, status: "error", metrics: {}, error: message });
        checkpoint = updateCheckpoint(checkpoint, {
          status: "running",
          next_phase_index: index + 1,
          errors: [...checkpoint.errors, { phase, message }],
        });
        writeJsonAtomic(checkpointPath, checkpoint);
      }
    }

    checkpoint = updateCheckpoint(checkpoint, {
      status: checkpoint.errors.length > 0 ? "completed_with_errors" : "completed",
      next_phase_index: PHASES.length,
    });
    writeJsonAtomic(checkpointPath, checkpoint);
    const status = checkpoint.errors.length > 0 ? "completed_with_errors" : "completed";
    const result = finishResult(input.butlerData, runId, startedAt, status, phases, checkpointPath, summaryPath, iso(), checkpoint);
    writeJsonAtomic(summaryPath, result);
    return result;
  } finally {
    releaseConsolidationLock(lockPath);
  }
}

async function runPhase(
  butlerData: string,
  phase: ConsolidationPhase,
  input: RunCognitionConsolidationInput,
): Promise<Record<string, unknown>> {
  if (phase === "preflight") return { ok: true };
  if (phase === "feedback_triage") {
    const active = activeFeedbackEntries(butlerData);
    return { active_feedback_count: active.length };
  }
  if (phase === "profile_consolidation") return await consolidateProfileFeedback(butlerData, input);
  if (phase === "new_chat_briefing") {
    return await generateNewChatBriefings({
      butlerData,
      runId: input.runId ?? "cr_unknown",
      now: input.now,
      modelRunner: input.newChatBriefingModelRunner,
    });
  }
  if (phase === "box_index") {
    const report = rebuildBoxIndex(butlerData);
    return { indexed_count: report.indexed_count, skipped_count: report.skipped_count };
  }
  if (phase === "memory_metadata_integrity") {
    const report = checkMemoryMetadataIntegrity(butlerData);
    return {
      chunk_count: report.chunk_count,
      missing_box_refs_count: report.missing_box_refs.length,
      missing_feedback_refs_count: report.missing_feedback_refs.length,
    };
  }
  if (phase === "source_quality_aggregation") {
    const summaries = aggregateSourceQuality(butlerData);
    const index = rebuildKnowHowIndex(butlerData);
    return { source_quality_summary_count: summaries.length, knowhow_indexed_count: index.indexed_count };
  }
  if (phase === "knowhow_revision") return reviseKnowHowFromFeedbackAndQuality(butlerData);
  if (phase === "memory_health") {
    const health = readMemoryHealth({ butlerData });
    return {
      memory_chunks_count: health.memoryChunkCount,
      vector_rows_count: health.vectorRowCount,
      maintenance_status: health.maintenanceStatus,
      diagnostics_count: health.diagnostics.length,
    };
  }
  if (phase === "box_retention") return pruneExpiredBoxOwnedContent(butlerData);
  if (phase === "metrics_summary") {
    recordOperationalMetric({
      category: "memory",
      name: "consolidation_cycle",
      status: "ok",
      dimensions: { raw_text_included: false },
    }, { butlerData });
    return { raw_text_included: false };
  }
  return {};
}

async function consolidateProfileFeedback(
  butlerData: string,
  input: RunCognitionConsolidationInput,
): Promise<Record<string, unknown>> {
  const feedback = activeFeedbackEntries(butlerData)
    .filter((entry) => entry.promotion_target === "profile_candidate");
  if (!isProfilingEnabled(butlerData)) {
    return {
      profiling_enabled: false,
      profile_feedback_count: feedback.length,
      captured_candidate_count: 0,
      applied_feedback_count: 0,
      raw_text_included: false,
    };
  }

  const transcriptSince = input.profileTranscriptSince ?? latestProfileConsolidationCompletedAt(butlerData, input.runId);
  const transcriptCapture = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
    modelRunner: input.profileExtractorModelRunner,
    since: transcriptSince,
    cacheScope: `cognition:${input.runId ?? "cr_unknown"}:profile_consolidation:profile-extractor`,
  });
  let capturedCandidates = 0;
  let appliedFeedback = 0;
  for (const entry of feedback) {
    const records = captureProfileCandidatesFromFeedback(butlerData, {
      feedback_id: entry.feedback_id,
      category: entry.category,
      promotion_target: entry.promotion_target,
      target_ref: entry.target_ref,
      text: entry.text,
      created_at: entry.created_at,
      privacy_class: entry.privacy_class,
    });
    if (records.length === 0) continue;
    capturedCandidates += records.length;
    resolveFeedbackEntry(butlerData, entry.feedback_id, "applied");
    appliedFeedback += 1;
  }
  const consolidation = consolidateProfileCandidates(butlerData);
  return {
    ...consolidation,
    profile_feedback_count: feedback.length,
    transcript_since: normalizeTranscriptSince(transcriptSince),
    semantic_scanned_session_count: transcriptCapture.semantic_scanned_session_count,
    semantic_scanned_message_count: transcriptCapture.semantic_scanned_message_count,
    semantic_captured_candidate_count: transcriptCapture.captured_candidate_count,
    audit_transcript_scanned_file_count: transcriptCapture.audit_transcript_scanned_file_count,
    audit_transcript_scanned_event_count: transcriptCapture.audit_transcript_scanned_event_count,
    transcript_scanned_file_count: transcriptCapture.audit_transcript_scanned_file_count,
    transcript_scanned_event_count: transcriptCapture.audit_transcript_scanned_event_count,
    transcript_captured_candidate_count: transcriptCapture.captured_candidate_count,
    transcript_extractor_model: transcriptCapture.extractor_model.effective_model,
    transcript_extractor_uses_butler_model: transcriptCapture.extractor_model.uses_butler_model,
    transcript_extractor_model_called: transcriptCapture.model_called,
    transcript_extractor_fallback_used: transcriptCapture.fallback_used,
    transcript_extractor_error: transcriptCapture.model_error ? "profile extractor model failed" : undefined,
    model_usage: transcriptCapture.model_usage,
    captured_candidate_count: capturedCandidates,
    applied_feedback_count: appliedFeedback,
    raw_text_included: false,
  };
}

function reviseKnowHowFromFeedbackAndQuality(butlerData: string): Record<string, unknown> {
  const feedback = activeFeedbackEntries(butlerData);
  const quality = aggregateSourceQuality(butlerData);
  const qualityBySource = new Map(quality.map((item) => [item.source_id, item]));
  let revised = 0;
  let demoted = 0;
  let appliedFeedback = 0;

  for (const entry of listKnowHowEntries(butlerData)) {
    let next: KnowHowEntry = entry;
    const targetedFeedback = feedback.filter((item) =>
      item.target_ref === `knowhow:${entry.knowhow_id}` ||
      entry.strategy.preferred_sources.some((source) => item.target_ref === `source:${source}`),
    );
    if (targetedFeedback.length > 0) {
      const disable = targetedFeedback.some((item) => item.category === "source_policy");
      next = {
        ...next,
        status: disable ? "disabled" : "needs_review",
        updated_at: iso(),
        quality: {
          ...next.quality,
          score: Math.max(0, Number((next.quality.score - 0.25).toFixed(3))),
          negative_feedback_count: next.quality.negative_feedback_count + targetedFeedback.length,
        },
        refs: {
          ...next.refs,
          feedback_ids: [...new Set([...next.refs.feedback_ids, ...targetedFeedback.map((item) => item.feedback_id)])],
        },
        revision_history: [
          ...next.revision_history,
          { at: iso(), kind: "feedback_revision", feedback_ids: targetedFeedback.map((item) => item.feedback_id), previous_status: entry.status },
        ],
      };
      for (const item of targetedFeedback) {
        resolveFeedbackEntry(butlerData, item.feedback_id, "applied");
        appliedFeedback += 1;
      }
    }
    const sourceScores = next.strategy.preferred_sources.map((source) => qualityBySource.get(source)?.score).filter((score): score is number => typeof score === "number");
    if (sourceScores.some((score) => score < 0.35)) {
      next = { ...next, status: "disabled", updated_at: iso() };
      demoted += 1;
    } else if (sourceScores.some((score) => score < 0.55) && next.status === "active") {
      next = { ...next, status: "needs_review", updated_at: iso() };
      demoted += 1;
    }
    if (next !== entry) {
      writeKnowHowEntry(butlerData, next);
      revised += 1;
    }
  }
  return { revised_knowhow_count: revised, demoted_knowhow_count: demoted, applied_feedback_count: appliedFeedback };
}

function pruneExpiredBoxOwnedContent(butlerData: string): Record<string, unknown> {
  const now = Date.now();
  let pruned = 0;
  let candidates = 0;
  for (const manifest of listBoxManifests(butlerData)) {
    if (manifest.retention.pinned || !manifest.retention.expires_at) continue;
    const expires = Date.parse(manifest.retention.expires_at);
    if (!Number.isFinite(expires) || expires > now) continue;
    candidates += 1;
    if (!manifest.files.every((file) => file.ownership === "box-owned")) continue;
    for (const file of manifest.files) {
      if (!file.box_relative_path) continue;
      rmSync(join(boxItemRoot(butlerData, manifest.box_item_id), file.box_relative_path), { force: true });
    }
    const next: BoxManifest = {
      ...manifest,
      status: "forgotten",
      updated_at: iso(),
      quality: {
        ...manifest.quality,
        signals: [...manifest.quality.signals, "retention_pruned"],
      },
    };
    writeBoxManifest(butlerData, next);
    pruned += 1;
  }
  return { expired_candidate_count: candidates, pruned_box_owned_count: pruned };
}

function updateCheckpoint(
  checkpoint: ConsolidationCheckpoint,
  update: Partial<Omit<ConsolidationCheckpoint, "schema" | "run_id" | "created_at">>,
): ConsolidationCheckpoint {
  return {
    ...checkpoint,
    ...update,
    updated_at: iso(),
  };
}

function finishResult(
  butlerData: string,
  runId: string,
  startedAt: string,
  status: ConsolidationCycleStatus,
  phases: ConsolidationPhaseResult[],
  checkpointPath: string,
  summaryPath: string,
  completedAt: string | null,
  checkpoint: ConsolidationCheckpoint | null,
): ConsolidationCycleResult {
  recordOperationalMetric({
    category: "memory",
    name: "consolidation_cycle_result",
    status: status === "completed" ? "ok" : "skipped",
    dimensions: {
      run_id: runId,
      phase_count: phases.length,
      error_count: checkpoint?.errors.length ?? 0,
      raw_text_included: false,
    },
  }, { butlerData });
  return {
    run_id: runId,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    phases,
    checkpoint_path: checkpointPath,
    summary_path: summaryPath,
    usage: buildConsolidationUsageReport(phases),
    raw_text_included: false,
  };
}

function buildConsolidationUsageReport(
  phases: ConsolidationPhaseResult[],
): ConsolidationUsageReport {
  const phaseUsages: ConsolidationPhaseUsageSummary[] = phases.map((phase) => {
    const usage = modelUsageFromUnknown(phase.metrics.model_usage) ?? emptyModelUsageSummary();
    return {
      phase: phase.phase,
      ...usage,
    };
  });
  const total = phaseUsages.reduce(
    (summary, phase) => mergeModelUsage(summary, phase),
    emptyModelUsageSummary(),
  );
  return {
    ...total,
    phases: phaseUsages,
  };
}

function metricsWithPhaseUsage(
  butlerData: string,
  runId: string,
  phase: ConsolidationPhase,
  sinceTs: number,
  metrics: Record<string, unknown>,
): Record<string, unknown> {
  const directUsage = modelUsageFromUnknown(metrics.model_usage);
  const promptMetricUsage = usageFromPromptCacheMetricEvents(
    readPromptCacheMetrics({ butlerData, sinceTs })
      .filter((event) => event.scope.startsWith(`cognition:${runId}:${phase}:`)),
  );
  const usage = usageHasTokenTotals(directUsage)
    ? directUsage
    : promptMetricUsage.request_count > 0
      ? promptMetricUsage
      : directUsage;
  if (!usage || usage.request_count === 0) return metrics;
  return {
    ...metrics,
    model_usage: usage,
  };
}

function usageHasTokenTotals(
  usage: ReturnType<typeof modelUsageFromUnknown>,
): boolean {
  return Boolean(usage && (
    usage.prompt_tokens > 0 ||
    usage.cached_input_tokens > 0 ||
    usage.uncached_input_tokens > 0 ||
    usage.output_tokens > 0 ||
    usage.total_tokens > 0
  ));
}

function normalizeTranscriptSince(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
