import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SystemEventSummary } from "./protocol.ts";

const SCHEDULER_EVENT_JOBS = [
  ["session-sync", "Session sync"],
  ["context-maintenance", "Context maintenance"],
  ["consolidation-cycle", "Consolidation cycle"],
] as const;

export function systemEventsForButlerData(
  butlerData: string,
): SystemEventSummary[] {
  return [
    ...schedulerSystemEvents(butlerData),
    ...consolidationSystemEvents(butlerData),
  ].sort((left, right) =>
    eventSortTimestamp(right).localeCompare(eventSortTimestamp(left)),
  );
}

function schedulerSystemEvents(butlerData: string): SystemEventSummary[] {
  return SCHEDULER_EVENT_JOBS.map(([id, title]) => {
    const state = readJsonFile<Record<string, unknown>>(
      join(butlerData, "state", "scheduler", `${id}.json`),
    );
    const lastRunAt = safeString(state?.lastRunAt);
    const status = safeString(state?.status) ?? "not_run";
    return {
      id: `scheduler:${id}`,
      kind: "scheduler_job",
      title,
      status,
      occurred_at: lastRunAt,
      metrics: [
        ...safeMetric("job_id", id),
        ...safeMetric("last_run_date", safeString(state?.lastRunDate)),
      ],
      raw_text_included: false,
    };
  });
}

function consolidationSystemEvents(butlerData: string): SystemEventSummary[] {
  const runsDir = join(butlerData, "cognition", "consolidation", "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(runsDir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 8)
    .flatMap(({ path }) => eventsFromConsolidationRun(path));
}

function eventsFromConsolidationRun(path: string): SystemEventSummary[] {
  const run = readJsonFile<StoredConsolidationRun>(path);
  if (!run?.run_id) return [];
  const phaseResults = Array.isArray(run.phases) ? run.phases : [];
  const failedPhaseCount = phaseResults.filter(
    (phase) => safeString(phase?.status) !== "ok",
  ).length;
  const events: SystemEventSummary[] = [
    {
      id: `consolidation:${run.run_id}`,
      kind: "consolidation_run",
      title: "Consolidation cycle",
      status: safeString(run.status) ?? "unknown",
      occurred_at: safeString(run.completed_at) ?? safeString(run.started_at),
      started_at: safeString(run.started_at),
      completed_at: safeString(run.completed_at),
      duration_ms: durationMs(run.started_at, run.completed_at),
      metrics: [
        ...safeMetric("phase_count", phaseResults.length),
        ...safeMetric("failed_phase_count", failedPhaseCount),
        ...safeMetric("raw_text_included", run.raw_text_included === true),
      ],
      raw_text_included: false,
    },
  ];
  const profilePhase = phaseResults.find(
    (phase) => phase?.phase === "profile_consolidation",
  );
  if (profilePhase) {
    const metrics = safeObject(profilePhase.metrics);
    events.push({
      id: `consolidation:${run.run_id}:profile`,
      kind: "profile_consolidation",
      title: "Profile consolidation",
      status:
        safeString(profilePhase.status) ?? safeString(run.status) ?? "unknown",
      occurred_at: safeString(run.completed_at) ?? safeString(run.started_at),
      started_at: safeString(run.started_at),
      completed_at: safeString(run.completed_at),
      model_ref: safeString(metrics.transcript_extractor_model),
      uses_butler_model:
        typeof metrics.transcript_extractor_uses_butler_model === "boolean"
          ? metrics.transcript_extractor_uses_butler_model
          : undefined,
      duration_ms: durationMs(run.started_at, run.completed_at),
      metrics: profileConsolidationMetrics(metrics),
      raw_text_included: false,
    });
  }
  return events;
}

interface StoredConsolidationRun {
  run_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  raw_text_included?: boolean;
  phases?: Array<{
    phase?: string;
    status?: string;
    metrics?: Record<string, unknown>;
  }>;
}

function profileConsolidationMetrics(
  metrics: Record<string, unknown>,
): SystemEventSummary["metrics"] {
  const keys = [
    "profiling_enabled",
    "mode",
    "candidate_count",
    "promoted_count",
    "skipped_count",
    "stable_entry_count",
    "projection_written",
    "transcript_scanned_file_count",
    "transcript_scanned_event_count",
    "transcript_captured_candidate_count",
    "transcript_extractor_model_called",
    "transcript_extractor_fallback_used",
    "raw_text_included",
  ];
  return keys.flatMap((key) => safeMetric(key, metrics[key]));
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function safeMetric(
  label: string,
  value: unknown,
): SystemEventSummary["metrics"] {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [{ label, value }];
  }
  return [];
}

function durationMs(
  startedAt: unknown,
  completedAt: unknown,
): number | undefined {
  const start = Date.parse(safeString(startedAt) ?? "");
  const completed = Date.parse(safeString(completedAt) ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(completed)) return undefined;
  return Math.max(0, completed - start);
}

function eventSortTimestamp(event: SystemEventSummary): string {
  return event.occurred_at ?? event.completed_at ?? event.started_at ?? "";
}
