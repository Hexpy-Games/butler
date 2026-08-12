import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  hasButlerRuntimeSymlinkComponent,
  isStrictlyInsideButlerRuntime,
} from "./butler-runtime-path-safety.ts";

const REQUIRED_LAUNCH_SMOKE_PATH = new Set([
  "electron_renderer",
  "electron_preload_bridge",
  "app_gateway",
  "native_btcc_runtime",
]);
const SC01_METRICS = new Set([
  "m1_v2_request_envelope",
  "m1_v2_request_segment",
  "m1_v2_response_usage",
]);

export type ButlerDurableExportState = "not_armed" | "verified" | "missing_or_failed";
export type ButlerHarnessOperationKind = "launch_smoke" | "scenario_run";

export type ButlerRuntimeExportDecision =
  | { cleanupAllowed: true; reason: "export_not_armed" | "verified_export" | "verified_non_turn_launch_smoke" }
  | { cleanupAllowed: false; reason: "durable_export_required" | "runtime_observation_ambiguous" };

/** Absence is an idempotent terminal state only when no runtime observation is
 * needed to decide whether an export was required. */
export function decideAbsentButlerRuntimeExport(
  durableExport: ButlerDurableExportState,
): ButlerRuntimeExportDecision {
  if (durableExport === "verified") {
    return { cleanupAllowed: true, reason: "verified_export" };
  }
  if (durableExport === "not_armed") {
    return { cleanupAllowed: true, reason: "export_not_armed" };
  }
  return { cleanupAllowed: false, reason: "runtime_observation_ambiguous" };
}

/**
 * Decides whether the isolated runtime may be removed. Durable export remains
 * mandatory except for a fully observed launch-only operation that dispatched
 * no Turn/model/provider work and produced no SC01 rows.
 */
export function decideButlerRuntimeExport(input: {
  evidence: Record<string, unknown>;
  durableExport: ButlerDurableExportState;
}): ButlerRuntimeExportDecision {
  if (input.durableExport === "verified") {
    return { cleanupAllowed: true, reason: "verified_export" };
  }

  const evidence = input.evidence;
  const run = recordValue(evidence.run);
  const dataRoot = typeof run?.dataRoot === "string" && run.dataRoot.trim()
    ? run.dataRoot
    : null;
  if (!dataRoot) {
    return { cleanupAllowed: false, reason: "runtime_observation_ambiguous" };
  }
  const sc01Rows = readSc01RowCount(dataRoot);
  if (sc01Rows === null) {
    return { cleanupAllowed: false, reason: "runtime_observation_ambiguous" };
  }
  if (input.durableExport === "not_armed") {
    return sc01Rows > 0
      ? { cleanupAllowed: false, reason: "durable_export_required" }
      : { cleanupAllowed: true, reason: "export_not_armed" };
  }

  const operationKind = harnessOperationKind(evidence.kind);
  if (operationKind !== "launch_smoke" || evidence.ok !== true) {
    return { cleanupAllowed: false, reason: "durable_export_required" };
  }
  if (!isVerifiedLaunchLifecycle(evidence.launches) ||
      !isVerifiedProductReadiness(evidence.actualProductPath)) {
    return { cleanupAllowed: false, reason: "runtime_observation_ambiguous" };
  }
  if (!Array.isArray(evidence.providerRequests) || !Array.isArray(evidence.observations)) {
    return { cleanupAllowed: false, reason: "runtime_observation_ambiguous" };
  }
  if (evidence.providerRequests.length > 0 || evidence.observations.length > 0) {
    return { cleanupAllowed: false, reason: "durable_export_required" };
  }

  const runtime = readRuntimeDispatchCounters(dataRoot);
  if (!runtime) {
    return { cleanupAllowed: false, reason: "runtime_observation_ambiguous" };
  }
  if (runtime.turns > 0 || runtime.modelRoutes > 0 ||
      runtime.acceptedRounds > 0 || sc01Rows > 0) {
    return { cleanupAllowed: false, reason: "durable_export_required" };
  }
  return { cleanupAllowed: true, reason: "verified_non_turn_launch_smoke" };
}

function harnessOperationKind(value: unknown): ButlerHarnessOperationKind | null {
  return value === "launch_smoke" || value === "scenario_run" ? value : null;
}

function isVerifiedLaunchLifecycle(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  return value.every((entry) => {
    const launch = recordValue(entry);
    return launch !== null &&
      typeof launch.startedAtMs === "number" && Number.isFinite(launch.startedAtMs) &&
      typeof launch.stoppedAtMs === "number" && Number.isFinite(launch.stoppedAtMs) &&
      launch.stoppedAtMs >= launch.startedAtMs;
  });
}

function isVerifiedProductReadiness(value: unknown): boolean {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    REQUIRED_LAUNCH_SMOKE_PATH.size === value.length &&
    new Set(value).size === REQUIRED_LAUNCH_SMOKE_PATH.size &&
    value.every((entry) => REQUIRED_LAUNCH_SMOKE_PATH.has(entry));
}

function readRuntimeDispatchCounters(dataRoot: string): {
  turns: number;
  modelRoutes: number;
  acceptedRounds: number;
} | null {
  if (!existsSync(dataRoot)) return null;
  const appDatabasePath = join(dataRoot, "app-server", "butler-client.sqlite");
  const conversationDatabasePath = join(dataRoot, "runtime", "conversation-store.sqlite");
  if (!isRegularContainedFile(dataRoot, appDatabasePath) ||
      !isRegularContainedFile(dataRoot, conversationDatabasePath)) {
    return null;
  }
  let turns = 0;
  let modelRoutes = 0;
  let acceptedRounds = 0;
  try {
    const app = new Database(appDatabasePath, { readonly: true });
    try {
      turns += requiredRowCount(app, "turns") + requiredRowCount(app, "btcc_turns");
      modelRoutes += requiredRowCount(app, "btcc_model_route_events");
      acceptedRounds += requiredRowCount(app, "btcc_model_round_acceptances");
    } finally {
      app.close();
    }
    const conversation = new Database(conversationDatabasePath, { readonly: true });
    try {
      turns += requiredRowCount(conversation, "conversation_turns");
    } finally {
      conversation.close();
    }
    return {
      turns,
      modelRoutes,
      acceptedRounds,
    };
  } catch {
    return null;
  }
}

function readSc01RowCount(dataRoot: string): number | null {
  const metricsRoot = join(dataRoot, "metrics");
  try {
    const stat = lstatSync(metricsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        !isStrictlyInsideButlerRuntime(dataRoot, metricsRoot) ||
        hasButlerRuntimeSymlinkComponent(metricsRoot)) return null;
  } catch (error) {
    if (!isMissingPath(error)) return null;
    return existsSync(dataRoot) && !hasButlerRuntimeSymlinkComponent(dataRoot) ? 0 : null;
  }
  const metricPath = join(metricsRoot, "operational-events.jsonl");
  try {
    lstatSync(metricPath);
  } catch (error) {
    return isMissingPath(error) ? 0 : null;
  }
  if (!isRegularContainedFile(dataRoot, metricPath)) return null;
  try {
    let rows = 0;
    for (const line of readFileSync(metricPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      const metric = recordValue(value);
      if (!metric || typeof metric.name !== "string") return null;
      if (SC01_METRICS.has(metric.name)) rows += 1;
    }
    return rows;
  } catch {
    return null;
  }
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT");
}

function requiredRowCount(db: Database, table: string): number {
  const exists = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table)?.count;
  if (exists !== 1) throw new Error("runtime_counter_table_missing");
  const safeTable = table === "turns" || table === "btcc_turns" ||
      table === "conversation_turns" || table === "btcc_model_route_events" ||
      table === "btcc_model_round_acceptances"
    ? table
    : null;
  if (!safeTable) throw new Error("runtime_counter_table_invalid");
  const count = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${safeTable}`).get()?.count;
  if (!Number.isSafeInteger(count) || count! < 0) throw new Error("runtime_counter_invalid");
  return count!;
}

function isRegularContainedFile(root: string, path: string): boolean {
  try {
    if (!isStrictlyInsideButlerRuntime(root, path) || hasButlerRuntimeSymlinkComponent(path)) return false;
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch {
    return false;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
