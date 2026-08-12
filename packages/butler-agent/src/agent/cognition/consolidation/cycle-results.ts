import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import { visitPromptCacheMetrics } from "../../../integrations/providers/prompt-cache-metrics.ts";
import type {
  ConsolidationCheckpoint,
  ConsolidationCycleResult,
  ConsolidationCycleStatus,
  ConsolidationPhase,
  ConsolidationPhaseResult,
} from "./cycle.ts";
import {
  emptyModelUsageSummary,
  mergeModelUsage,
  modelUsageFromUnknown,
  usageFromPromptCacheMetricEvents,
  type ConsolidationPhaseUsageSummary,
  type ConsolidationUsageReport,
} from "./usage.ts";

export function updateCheckpoint(
  checkpoint: ConsolidationCheckpoint,
  update: Partial<Omit<ConsolidationCheckpoint, "schema" | "run_id" | "created_at">>,
): ConsolidationCheckpoint {
  return { ...checkpoint, ...update, updated_at: new Date().toISOString() };
}

export function finishResult(
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

export function metricsWithPhaseUsage(
  butlerData: string,
  runId: string,
  phase: ConsolidationPhase,
  sinceTs: number,
  metrics: Record<string, unknown>,
): Record<string, unknown> {
  const directUsage = modelUsageFromUnknown(metrics.model_usage);
  let measuredUsage = emptyModelUsageSummary();
  visitPromptCacheMetrics({
    butlerData,
    sinceTs,
    onEvent: (event) => {
      if (!event.scope.startsWith(`cognition:${runId}:${phase}:`)) return;
      // Reduce each row immediately so the production path never retains the
      // historical JSONL array merely to produce a bounded phase summary.
      measuredUsage = mergeModelUsage(
        measuredUsage,
        usageFromPromptCacheMetricEvents([event]),
      );
    },
  });
  const usage = hasTokenTotals(directUsage)
    ? directUsage
    : measuredUsage.request_count > 0
      ? measuredUsage
      : directUsage;
  return !usage || usage.request_count === 0 ? metrics : { ...metrics, model_usage: usage };
}

export function buildConsolidationUsageReport(
  phases: ConsolidationPhaseResult[],
): ConsolidationUsageReport {
  const phaseUsages: ConsolidationPhaseUsageSummary[] = phases.map((phase) => ({
    phase: phase.phase,
    ...(modelUsageFromUnknown(phase.metrics.model_usage) ?? emptyModelUsageSummary()),
  }));
  return {
    ...phaseUsages.reduce(
      (summary, phase) => mergeModelUsage(summary, phase),
      emptyModelUsageSummary(),
    ),
    phases: phaseUsages,
  };
}

function hasTokenTotals(usage: ReturnType<typeof modelUsageFromUnknown>): boolean {
  return Boolean(usage && (
    usage.prompt_tokens > 0 || usage.cached_input_tokens > 0 ||
    usage.uncached_input_tokens > 0 || usage.output_tokens > 0 || usage.total_tokens > 0
  ));
}
