import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { TaskStore } from "../../work/task-store.ts";
import {
  missingReviewCriteria,
  plannedInternalGoal,
  taskIdFromPlannedTaskMemoryRecordId,
} from "../../work/planned-task.ts";
import {
  markdownMemoryBlocks,
  recallMemory,
  recallMemoryWithVector,
  type AssociativeRecallResult,
  type RecallEvidencePolicy,
} from "./recall/engine.ts";
import type { VectorEpisodeBackend } from "./recall/vector.ts";
import { readProjectRefreshFailures, sanitizeProjectMemoryId } from "./project-memory.ts";
import { cognitionConsolidationRoot, cognitionMemoryRoot } from "../paths.ts";
import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import { memoryMetadataPath } from "./metadata.ts";
import { appendToQueue } from "./scripts/queue.ts";
import type { MemorySourceNotice } from "./projection/contracts.ts";
import { readActiveDescriptor, resolveMemoryGeneration } from "./projection/generation.ts";
import { readGenerationHotCacheHealth, type GenerationHotCacheHealth } from "../continuity/hot-cache-writer.ts";
import { readProfileCoverageHealth, type ProfileCoverageHealth } from "../../../personalization/profiling.ts";
import { canonicalConversationProjectionInventory } from "./projection/source.ts";
import { createMemoryQualityExclusionReader, listFeedbackQualityOperations } from "../feedback/buffer.ts";
import { sourceRows } from "./projection/store.ts";
import { consolidationLockPath, inspectConsolidationLock, type ConsolidationLockInspection } from "./scripts/lib/lock.ts";

export type MemoryMaintenanceStatus =
  | "missing"
  | "ok"
  | "stale"
  | "failed"
  | "repaired";

export interface MemoryHealthSummary {
  serving: ServingMemoryHealth;
  writerGate: ConsolidationLockInspection;
  hotCacheFiles: number;
  ruleFiles: number;
  queueBacklog: number;
  deadLetterCount: number;
  transcriptFiles: number;
  taskMemoryEntries: number;
  projectCapsules: number;
  missingProjectCapsules: number;
  newestProjectCapsuleAt: string | null;
  projectRefreshFailureCount: number;
  latestProjectRefreshFailureAt: string | null;
  vectorRowCount: number | null;
  memoryChunkCount: number;
  graphEntityCount: number;
  graphEdgeCount: number;
  graphMentionCount: number;
  ingestionLagMs: number | null;
  newestHotCacheAt: string | null;
  maintenanceStatus: MemoryMaintenanceStatus;
  maintenanceLastRunAt: string | null;
  maintenanceFailedPhases: string[];
  stale: boolean;
  diagnostics: string[];
}

export interface ServingMemoryHealth {
  available: boolean;
  reason: "generation_unavailable" | "generation_changed" | "serving_store_unavailable" | null;
  generation_id: string | null;
  graph_revision: number | null;
  sources: {
    unit: "scalar_source";
    eligible: number | null;
    known_eligible: number;
    registered: number | null;
    registered_current: number | null;
    unknown_origin_excluded: number | null;
    inventory_complete: boolean;
    inventory_reason: "canonical_inventory_unavailable" | "canonical_inventory_partial" | "typed_inventory_unavailable" | null;
    coverage_percent: number | null;
    known_coverage_percent: number | null;
    coverage_reason: "zero_eligible_sources" | "inventory_incomplete" | null;
  };
  stages: Record<"semantic_graph" | "episode_vectors" | "node_vectors" | "hot_cache", { complete: number; pending: number; failed: number; not_configured: number }>;
  stage_units: { semantic_graph: "window_leaf"; episode_vectors: "vector_unit"; node_vectors: "vector_unit"; hot_cache: "projection_job" };
  oldest_pending_age_ms: number | null;
  source_resolution_failures: number | null;
  historical_source_resolution_failures: number | null;
  embedding_version_mismatch: number | null;
  historical_embedding_version_mismatch: number | null;
  pending_quality_operations: number | null;
  cache: GenerationHotCacheHealth;
  profile: ProfileCoverageHealth;
}

export interface MemoryIngestionResult {
  ok: boolean;
  task_id: string;
  memory_path: string;
  provenance: {
    task_id: string;
    source: "task-result";
    origin_session_id?: string;
    origin_event_id?: string;
  };
}

export interface MemoryRecallResult {
  cue: string;
  seeds: string[];
  results: Array<{
    text: string;
    score: number;
    source: "hot-cache" | "project-memory" | "task-memory" | "rules" | "graph" | "vector";
    path: string;
  }>;
  items: AssociativeRecallResult["items"];
  abstained: boolean;
  diagnostics: string[];
}

export interface ExplicitMemoryUpdate {
  kind: "rule";
  text: string;
  source: string;
}

export type TypedMemoryRecord = {
  schema: "butler.memory-source-owner.v1";
  source_kind: "task_report" | "explicit_record";
  record_kind: "task_report" | "rule" | "feedback";
  record_id: string;
  revision: string;
  operation_id: string;
  text: string;
  content_hash: string;
  project_id: string | null;
  conversation_session_id: string | null;
  conversation_message_id: string | null;
  observed_at: string;
  role: "task" | "explicit";
  basis: "reviewed_task" | "user_statement";
};

type ExplicitRuleBinding = Omit<TypedMemoryRecord, "schema" | "source_kind" | "record_kind" | "text" | "role" | "basis"> & {
  schema: "butler.explicit-rule-binding.v1";
  state: "active" | "forgotten";
  operations: Array<{ operation_id: string; revision: string; state: "written" | "forgotten" }>;
};

export type TypedMemoryOwnerReadOptions = { unavailable?: "throw" };

function missingOwnerFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function throwIfOwnerUnavailable(
  options: TypedMemoryOwnerReadOptions,
  error: unknown,
): void {
  if (options.unavailable === "throw" && !missingOwnerFile(error)) {
    throw new Error("memory_source_unavailable");
  }
}

function explicitRulePaths(butlerData: string, recordId: string) {
  const root = join(cognitionMemoryRoot(butlerData), "rules");
  return {
    root,
    text: join(root, `${recordId}.md`),
    binding: join(root, `${recordId}.source.json`),
  };
}

function readExplicitRuleBinding(
  butlerData: string,
  recordId: string,
  options: TypedMemoryOwnerReadOptions = {},
): ExplicitRuleBinding | null {
  try {
    const value = JSON.parse(readFileSync(
      explicitRulePaths(butlerData, recordId).binding,
      "utf8",
    )) as ExplicitRuleBinding;
    return value.schema === "butler.explicit-rule-binding.v1" &&
        value.record_id === recordId
      ? value
      : null;
  } catch (error) {
    throwIfOwnerUnavailable(options, error);
    return null;
  }
}

export function readExplicitMemoryLifecycle(input: {
  butlerData: string;
  recordId: string;
  operationId: string;
  revision: string;
}, options: TypedMemoryOwnerReadOptions = {}): "current" | "superseded" | "forgotten" | null {
  const binding = readExplicitRuleBinding(input.butlerData, input.recordId, options);
  const operation = binding?.operations.find((item) =>
    item.operation_id === input.operationId && item.revision === input.revision,
  );
  if (!binding || !operation) return null;
  if (operation.state === "forgotten" && binding.revision === input.revision) {
    return "forgotten";
  }
  return binding.state === "active" && binding.revision === input.revision
    ? "current"
    : "superseded";
}

export function readTaskMemoryNoticeLifecycle(input: {
  butlerData: string;
  recordId: string;
  operationId: string;
  revision: string;
}, options: TypedMemoryOwnerReadOptions = {}): "current" | "superseded" | null {
  const taskId = taskIdFromPlannedTaskMemoryRecordId(input.recordId);
  if (!taskId) return null;
  const taskStore = new TaskStore(input.butlerData);
  const task = taskStore.read(taskId);
  if (!task?.planned) return null;
  const current = taskStore.readMemoryReport(taskId, options);
  if (current) {
    const operationId = taskMemoryOperationId(current);
    if (current.source_revision === input.revision && operationId === input.operationId) {
      return "current";
    }
  }
  return "superseded";
}

function taskMemoryOperationId(report: {
  task_id: string;
  attempt: number;
  result_hash: string;
  review_hash: string;
  source_revision: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "task-report", report.task_id, report.attempt, report.result_hash,
    report.review_hash, report.source_revision,
  ])).digest("hex");
}

export function readTypedMemoryRecord(
  butlerData: string,
  kind: "task_report" | "explicit_record",
  recordId: string,
  options: TypedMemoryOwnerReadOptions = {},
): TypedMemoryRecord | null {
  if (kind === "explicit_record") {
    const binding = readExplicitRuleBinding(butlerData, recordId, options);
    if (!binding || binding.state !== "active") return null;
    try {
      const text = readFileSync(explicitRulePaths(butlerData, recordId).text, "utf8");
      if (createHash("sha256").update(text).digest("hex") !== binding.content_hash) {
        return null;
      }
      const {
        schema: _schema,
        state: _state,
        operations: _operations,
        ...metadata
      } = binding;
      return {
        schema: "butler.memory-source-owner.v1",
        source_kind: kind,
        record_kind: "rule",
        role: "explicit",
        basis: "user_statement",
        text,
        ...metadata,
      };
    } catch (error) {
      throwIfOwnerUnavailable(options, error);
      return null;
    }
  }
  const taskId = taskIdFromPlannedTaskMemoryRecordId(recordId);
  if (!taskId) return null;
  const taskStore = new TaskStore(butlerData);
  const report = taskStore.readMemoryReport(taskId, options);
  if (!report || report.record_id !== recordId) return null;
  return {
    schema: "butler.memory-source-owner.v1",
    source_kind: kind,
    record_kind: "task_report",
    record_id: report.record_id,
    revision: report.source_revision,
    operation_id: taskMemoryOperationId(report),
    text: report.text,
    content_hash: report.report_hash,
    project_id: report.project_id,
    conversation_session_id: null,
    conversation_message_id: null,
    observed_at: report.observed_at,
    role: "task",
    basis: "reviewed_task",
  };
}

export function listTypedMemoryRecordsSnapshot(
  butlerData: string,
): Array<{ record: TypedMemoryRecord; lifecycle: "current" }> {
  const output: Array<{ record: TypedMemoryRecord; lifecycle: "current" }> = [];
  const tasks = new TaskStore(butlerData);
  for (const taskId of tasks.taskIds().sort()) {
    const report = tasks.readMemoryReport(taskId, { unavailable: "throw" });
    if (!report) continue;
    const record = readTypedMemoryRecord(butlerData, "task_report", report.record_id, { unavailable: "throw" });
    if (record) output.push({ record, lifecycle: "current" });
  }
  const rulesRoot = join(cognitionMemoryRoot(butlerData), "rules");
  if (existsSync(rulesRoot)) {
    for (const name of readdirSync(rulesRoot).filter((item) => item.endsWith(".source.json")).sort()) {
      const recordId = name.slice(0, -".source.json".length);
      const record = readTypedMemoryRecord(butlerData, "explicit_record", recordId, { unavailable: "throw" });
      if (record) output.push({ record, lifecycle: "current" });
    }
  }
  return output.sort((a, b) => `${a.record.source_kind}\0${a.record.record_id}`.localeCompare(`${b.record.source_kind}\0${b.record.record_id}`));
}

/** Read-only provenance inventory used to bind a rebuild snapshot. */
export function listTypedMemoryLifecycleSnapshot(butlerData: string): unknown[] {
  const output: unknown[] = [];
  const tasks = new TaskStore(butlerData);
  for (const taskId of tasks.taskIds().sort()) {
    const report = tasks.readMemoryReport(taskId, { unavailable: "throw" });
    if (report) output.push({ source_kind: "task_report", task_id: taskId, report });
  }
  output.push({
    source_kind: "feedback_quality_operations",
    operations: listFeedbackQualityOperations(butlerData).sort((left, right) =>
      left.operation_id.localeCompare(right.operation_id)),
  });
  const rulesRoot = join(cognitionMemoryRoot(butlerData), "rules");
  if (existsSync(rulesRoot)) {
    for (const name of readdirSync(rulesRoot).filter((item) => item.endsWith(".source.json")).sort()) {
      const recordId = name.slice(0, -".source.json".length);
      const binding = readExplicitRuleBinding(butlerData, recordId, { unavailable: "throw" });
      if (binding) output.push({ source_kind: "explicit_record", record_id: recordId, binding });
    }
  }
  return output.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function writeExplicitRuleRecord(input: {
  butlerData: string;
  recordId: string;
  operationId: string;
  text: string;
  projectId?: string | null;
  conversationSessionId?: string | null;
  conversationMessageId?: string | null;
  observedAt?: string;
}): { record: TypedMemoryRecord; replayed: boolean; receiptRevision: string } {
  const paths = explicitRulePaths(input.butlerData, input.recordId);
  mkdirSync(paths.root, { recursive: true });
  const contentHash = createHash("sha256").update(input.text).digest("hex");
  const revision = createHash("sha256").update(JSON.stringify([
    "explicit_record", "rule", input.recordId, contentHash,
    input.projectId ?? null, input.conversationSessionId ?? null, input.conversationMessageId ?? null,
  ])).digest("hex");
  const priorBinding = readExplicitRuleBinding(
    input.butlerData,
    input.recordId,
    { unavailable: "throw" },
  );
  const priorOperation = priorBinding?.operations.find(
    (item) => item.operation_id === input.operationId,
  );
  if (priorOperation) {
    if (priorOperation.revision !== revision) {
      throw new Error("memory_source_operation_conflict");
    }
    const current = readTypedMemoryRecord(
      input.butlerData,
      "explicit_record",
      input.recordId,
      { unavailable: "throw" },
    );
    if (!current) throw new Error("memory_source_operation_retracted");
    return { record: current, replayed: true, receiptRevision: priorOperation.revision };
  }
  const record: TypedMemoryRecord = {
    schema: "butler.memory-source-owner.v1",
    source_kind: "explicit_record",
    record_kind: "rule",
    record_id: input.recordId,
    revision,
    operation_id: input.operationId,
    text: input.text,
    content_hash: contentHash,
    project_id: input.projectId ?? null,
    conversation_session_id: input.conversationSessionId ?? null,
    conversation_message_id: input.conversationMessageId ?? null,
    observed_at: input.observedAt ?? new Date().toISOString(),
    role: "explicit",
    basis: "user_statement",
  };
  writeFileSync(paths.text, input.text, { encoding: "utf8", mode: 0o600 });
  const binding: ExplicitRuleBinding = {
    schema: "butler.explicit-rule-binding.v1",
    state: "active",
    record_id: record.record_id,
    revision: record.revision,
    operation_id: record.operation_id,
    content_hash: record.content_hash,
    project_id: record.project_id,
    conversation_session_id: record.conversation_session_id,
    conversation_message_id: record.conversation_message_id,
    observed_at: record.observed_at,
    operations: [
      ...(priorBinding?.operations ?? []),
      { operation_id: input.operationId, revision, state: "written" },
    ],
  };
  writeFileSync(paths.binding, `${JSON.stringify(binding, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { record, replayed: false, receiptRevision: revision };
}

function enqueueTypedRecord(butlerData: string, source: MemorySourceNotice): void {
  appendToQueue({
    schema_version: "butler.memory-sync-request.v3",
    job_id: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    source,
    created_at: new Date().toISOString(),
  }, butlerData);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function countJsonl(path: string): number {
  const text = readText(path).trim();
  if (!text) return 0;
  return text.split("\n").filter(Boolean).length;
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(predicate)
    .map((name) => join(dir, name));
}

function newestMtimeIso(paths: string[]): string | null {
  let newest = 0;
  for (const path of paths) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {}
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
}

function newestMtimeMs(paths: string[]): number | null {
  let newest = 0;
  for (const path of paths) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {}
  }
  return newest > 0 ? newest : null;
}

function readVectorRowCount(memoryDir: string): { count: number | null; updatedAt: number | null } {
  const raw = readText(join(memoryDir, "db", "vector-stats.json"));
  if (!raw.trim()) return { count: null, updatedAt: null };
  try {
    const parsed = JSON.parse(raw) as { row_count?: unknown; updated_at?: unknown };
    return {
      count: typeof parsed.row_count === "number" ? parsed.row_count : null,
      updatedAt: typeof parsed.updated_at === "string" ? Date.parse(parsed.updated_at) : null,
    };
  } catch {
    return { count: null, updatedAt: null };
  }
}

function registeredProjectNames(butlerData: string): string[] {
  const raw = readText(join(butlerData, "butler.config.json"));
  if (!raw.trim()) return [];
  try {
    const config = JSON.parse(raw) as { projects?: unknown };
    const projects = Array.isArray(config.projects)
      ? config.projects
      : Object.values(config.projects ?? {});
    return (projects as Array<{ name?: unknown }>)
      .map((project) => project?.name)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  } catch {
    return [];
  }
}

interface MaintenanceSummaryLine {
  ts?: string;
  phase?: string;
  status?: "ok" | "warn" | "error" | "aborted_budget";
  metrics?: {
    failed_phases?: unknown;
  };
}

function readJsonlObjects(path: string): MaintenanceSummaryLine[] {
  const text = readText(path).trim();
  if (!text) return [];
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as MaintenanceSummaryLine];
    } catch {
      return [];
    }
  });
}

function readMaintenanceState(input: {
  memoryDir: string;
  now: number;
  staleAfterMs: number;
}): {
  status: MemoryMaintenanceStatus;
  lastRunAt: string | null;
  failedPhases: string[];
  diagnostics: string[];
} {
  const summaries = [
    ...readJsonlObjects(join(input.memoryDir, "run-summary.jsonl")),
    ...readJsonlObjects(join(input.memoryDir, "logs", "run-summary.jsonl")),
  ]
    .filter((line) => line.phase === "summary" && typeof line.ts === "string")
    .sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));

  if (summaries.length === 0) {
    return {
      status: "missing",
      lastRunAt: null,
      failedPhases: [],
      diagnostics: ["memory maintenance has not run"],
    };
  }

  const latest = summaries[summaries.length - 1]!;
  const previous = summaries.length > 1 ? summaries[summaries.length - 2] : null;
  const lastRunAt = latest.ts!;
  const lastRunMs = Date.parse(lastRunAt);
  const rawFailed = latest.metrics?.failed_phases;
  const failedPhases = Array.isArray(rawFailed)
    ? rawFailed.filter((value): value is string => typeof value === "string")
    : [];
  const diagnostics: string[] = [];

  if (latest.status === "error" || latest.status === "aborted_budget") {
    diagnostics.push("memory maintenance failed");
    return { status: "failed", lastRunAt, failedPhases, diagnostics };
  }

  if (Number.isFinite(lastRunMs) && input.now - lastRunMs > input.staleAfterMs) {
    diagnostics.push("memory maintenance is stale");
    return { status: "stale", lastRunAt, failedPhases: [], diagnostics };
  }

  if (latest.status === "ok" && previous && (previous.status === "error" || previous.status === "aborted_budget")) {
    diagnostics.push("memory maintenance recovered after a previous failure");
    return { status: "repaired", lastRunAt, failedPhases: [], diagnostics };
  }

  return { status: "ok", lastRunAt, failedPhases: [], diagnostics };
}

function countSqliteRows(dbPath: string, table: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "memory";
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function compactEvidenceText(value: string, limit: number): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function readRecallEvidenceText(path: string): string {
  const blockMatch = /#block-(\d+)$/u.exec(path);
  if (!blockMatch) return readText(path);
  const filePath = path.slice(0, blockMatch.index);
  const blockIndex = Number.parseInt(blockMatch[1] ?? "", 10) - 1;
  const blocks = markdownMemoryBlocks(readText(filePath));
  return blocks[blockIndex] ?? readText(filePath);
}

function readServingMemoryHealth(butlerData: string, now: number): ServingMemoryHealth {
  const unavailable = (reason: ServingMemoryHealth["reason"]): ServingMemoryHealth => ({
    available: false, reason, generation_id: null, graph_revision: null,
    sources: { unit: "scalar_source", eligible: null, known_eligible: 0, registered: null, registered_current: null,
      unknown_origin_excluded: null, inventory_complete: false, inventory_reason: "canonical_inventory_unavailable",
      coverage_percent: null, known_coverage_percent: null, coverage_reason: "inventory_incomplete" },
    stages: Object.fromEntries(["semantic_graph", "episode_vectors", "node_vectors", "hot_cache"].map((name) => [name, { complete: 0, pending: 0, failed: 0, not_configured: 0 }])) as ServingMemoryHealth["stages"],
    stage_units: { semantic_graph: "window_leaf", episode_vectors: "vector_unit", node_vectors: "vector_unit", hot_cache: "projection_job" },
    oldest_pending_age_ms: null, source_resolution_failures: null, historical_source_resolution_failures: null,
    embedding_version_mismatch: null, historical_embedding_version_mismatch: null, pending_quality_operations: null,
    cache: readGenerationHotCacheHealth({ butlerData, now: new Date(now).toISOString() }), profile: readProfileCoverageHealth(butlerData),
  });
  let descriptor: ReturnType<typeof readActiveDescriptor>;
  try { descriptor = readActiveDescriptor(butlerData); } catch { return unavailable("generation_unavailable"); }
  try {
    const generation = resolveMemoryGeneration({ butlerData, target: { kind: "active", expected_generation: descriptor.generation_id }, signal: new AbortController().signal });
    const db = new Database(generation.graphPath, { readonly: true });
    try {
      const graphRevision = Number(db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value);
      if (!Number.isSafeInteger(graphRevision)) return unavailable("serving_store_unavailable");
      const count = (sql: string) => Number(db.query<{ count: number }, []>(sql).get()?.count ?? 0);
      const sourceEligible = "((s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public')) OR s.source_kind IN ('task_report','explicit_record'))";
      const registered = count("SELECT COUNT(*) count FROM memory_chunk_sources");
      const registeredCurrent = count(`SELECT COUNT(*) count FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE c.status='active' AND ${sourceEligible}`);
      const inventory = canonicalConversationProjectionInventory({ butlerData, asOf: new Date(now).toISOString(), deadlineAt: Date.now() + 1_000,
        scope: "all_user_sessions", currentSessionId: "", currentProjectId: null, sessionIds: [], projectFilter: "any", projectIds: [] });
      const knownEligible = inventory.entries.reduce((sum, entry) => sum + entry.sourceUnitCount, 0);
      const knownComplete = inventory.entries.reduce((sum, entry) => sum + (db.query<{ found: number }, [string, string]>(`
        SELECT 1 found FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision
        WHERE c.memory_chunk_id=? AND c.current_revision=? AND json_extract(j.semantic_graph_state,'$.state')='complete' LIMIT 1
      `).get(entry.episodeId, entry.revision) ? entry.sourceUnitCount : 0), 0);
      const inventoryReason = !inventory.available ? "canonical_inventory_unavailable" as const
        : inventory.partial ? "canonical_inventory_partial" as const : "typed_inventory_unavailable" as const;
      const stages = {} as ServingMemoryHealth["stages"];
      const stageQueries = {
        semantic_graph: "SELECT w.state state,COUNT(*) count FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state!='replaced' GROUP BY w.state",
        episode_vectors: "SELECT u.state state,COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.record_kind='episode' AND u.state!='superseded' GROUP BY u.state",
        node_vectors: "SELECT u.state state,COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.record_kind='node' AND u.state!='superseded' GROUP BY u.state",
        hot_cache: "SELECT COALESCE(json_extract(j.hot_cache_state,'$.state'),'failed') state,COUNT(*) count FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision GROUP BY state",
      } as const;
      for (const [name, sql] of Object.entries(stageQueries) as Array<[keyof typeof stageQueries, string]>) {
        const values = { complete: 0, pending: 0, failed: 0, not_configured: 0 };
        const rows = db.query<{ state: string; count: number }, []>(sql).all();
        for (const row of rows) {
          const state = row.state === "complete" ? "complete" : row.state === "failed" ? "failed" : row.state === "not_configured" ? "not_configured" : "pending";
          values[state] += Number(row.count);
        }
        stages[name] = values;
      }
      const oldest = db.query<{ created_at: string }, []>(`SELECT MIN(created_at) created_at FROM (
        SELECT j.created_at created_at FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state IN ('pending','planned','running','failed')
        UNION ALL SELECT j.created_at FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.state IN ('pending','running','failed')
        UNION ALL SELECT j.created_at FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE COALESCE(json_extract(j.hot_cache_state,'$.state'),'pending') NOT IN ('complete','not_configured')
      )`).get()?.created_at;
      const currentSourceFailures = count("SELECT COUNT(*) count FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state='failed' AND w.error_code LIKE 'memory_source_%'");
      const historicalSourceFailures = count("SELECT COUNT(*) count FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.revision<>c.current_revision AND w.state='failed' AND w.error_code LIKE 'memory_source_%'");
      const currentEmbeddingMismatch = count("SELECT COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.error_code='memory_embedding_version_mismatch'");
      const historicalEmbeddingMismatch = count("SELECT COUNT(*) count FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.revision<>c.current_revision AND u.error_code='memory_embedding_version_mismatch'");
      const currentSourceIds = db.query<{ source_id: string }, []>("SELECT s.source_id FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE c.status='active'").all().map((row) => row.source_id);
      const qualityExcluded = createMemoryQualityExclusionReader(butlerData, { db, generationId: generation.generationId })(sourceRows(db, currentSourceIds));
      const pendingQuality = listFeedbackQualityOperations(butlerData).filter((operation) =>
        operation.status === "pending" && operation.generation_id === generation.generationId && qualityExcluded.has(operation.source_ref)).length;
      const cache = readGenerationHotCacheHealth({ butlerData, now: new Date(now).toISOString(),
        expectedGenerationId: generation.generationId, expectedGraphRevision: graphRevision });
      const profile = readProfileCoverageHealth(butlerData);
      const afterRevision = Number(db.query<{ value: string }, []>("SELECT value FROM memory_state WHERE key='graph_revision'").get()?.value);
      if (readActiveDescriptor(butlerData).generation_id !== descriptor.generation_id || afterRevision !== graphRevision) return unavailable("generation_changed");
      return { available: true, reason: null, generation_id: generation.generationId, graph_revision: graphRevision,
        sources: { unit: "scalar_source", eligible: null, known_eligible: knownEligible, registered, registered_current: registeredCurrent,
          unknown_origin_excluded: null, inventory_complete: false, inventory_reason: inventoryReason,
          coverage_percent: null, known_coverage_percent: knownEligible === 0 ? null : Math.round(knownComplete / knownEligible * 10_000) / 100,
          coverage_reason: "inventory_incomplete" }, stages,
        stage_units: { semantic_graph: "window_leaf", episode_vectors: "vector_unit", node_vectors: "vector_unit", hot_cache: "projection_job" },
        oldest_pending_age_ms: oldest ? Math.max(0, now - Date.parse(oldest)) : null,
        source_resolution_failures: currentSourceFailures, historical_source_resolution_failures: historicalSourceFailures,
        embedding_version_mismatch: currentEmbeddingMismatch, historical_embedding_version_mismatch: historicalEmbeddingMismatch,
        pending_quality_operations: pendingQuality, cache, profile };
    } finally { db.close(); }
  } catch { return unavailable("serving_store_unavailable"); }
}

export function readMemoryHealth(input: {
  butlerData: string;
  staleAfterMs?: number;
  now?: number;
}): MemoryHealthSummary {
  const memoryDir = cognitionMemoryRoot(input.butlerData);
  const hotDir = join(memoryDir, "hot");
  const rulesDir = join(memoryDir, "rules");
  const queueDir = join(memoryDir, "queue");
  const transcriptDir = join(input.butlerData, "transcripts");
  const taskMemoryDir = join(memoryDir, "tasks");
  const projectMemoryDir = join(memoryDir, "projects");
  const dbDir = join(memoryDir, "db");
  const graphDbPath = join(dbDir, "graph.sqlite");
  const metadataDbPath = memoryMetadataPath(input.butlerData);
  const hotFiles = [
    ...listFiles(hotDir, (name) => name.endsWith(".md")),
    ...listFiles(join(hotDir, "topics"), (name) => name.endsWith(".md")),
  ];
  const projectCapsuleFiles = listFiles(projectMemoryDir, (name) => name.endsWith(".md"));
  const projectRefreshFailures = readProjectRefreshFailures({
    butlerData: input.butlerData,
  });
  const registeredProjects = registeredProjectNames(input.butlerData);
  const projectCapsuleNames = new Set(projectCapsuleFiles.map((path) => basename(path, ".md")));
  const missingProjectCapsules = registeredProjects
    .filter((name) => !projectCapsuleNames.has(sanitizeProjectMemoryId(name)))
    .length;
  const transcriptFiles = listFiles(transcriptDir, (name) => name.endsWith(".jsonl"));
  const newestHotCacheAt = newestMtimeIso(hotFiles);
  const newestProjectCapsuleAt = newestMtimeIso(projectCapsuleFiles);
  const newestTranscriptAt = newestMtimeMs(transcriptFiles);
  const vectorStats = readVectorRowCount(memoryDir);
  const ingestionLagMs = newestTranscriptAt && vectorStats.updatedAt
    ? Math.max(0, newestTranscriptAt - vectorStats.updatedAt)
    : null;
  const staleAfterMs = input.staleAfterMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = input.now ?? Date.now();
  const serving = readServingMemoryHealth(input.butlerData, now);
  const writerGate = inspectConsolidationLock(consolidationLockPath(input.butlerData));
  const stale = !newestHotCacheAt || now - Date.parse(newestHotCacheAt) > staleAfterMs;
  const maintenance = readMaintenanceState({
    memoryDir: cognitionConsolidationRoot(input.butlerData),
    now,
    staleAfterMs,
  });
  const diagnostics: string[] = [];
  const queueBacklog = countJsonl(join(queueDir, "sync.jsonl"));
  const deadLetterCount = countJsonl(join(queueDir, "dead-letter.jsonl"));
  const graphEntityCount = countSqliteRows(graphDbPath, "entities");
  const graphEdgeCount = countSqliteRows(graphDbPath, "edges");
  const graphMentionCount = countSqliteRows(graphDbPath, "entity_mentions");
  const memoryChunkCount = countSqliteRows(metadataDbPath, "memory_chunks");
  if (stale) diagnostics.push("hot cache is stale or missing");
  if (queueBacklog > 0) diagnostics.push(`${queueBacklog} memory sync request(s) are queued`);
  if (deadLetterCount > 0) diagnostics.push(`${deadLetterCount} memory sync request(s) are in dead-letter`);
  if (missingProjectCapsules > 0) diagnostics.push(`${missingProjectCapsules} registered project capsule(s) are missing`);
  if (projectRefreshFailures.length > 0) diagnostics.push(`${projectRefreshFailures.length} project capsule refresh failure(s) recorded`);
  if (vectorStats.count === null) diagnostics.push("vector row count is unavailable until the first successful index");
  if (graphEntityCount === 0 && graphEdgeCount === 0 && graphMentionCount === 0) diagnostics.push("graph memory has no indexed associations yet");
  if (ingestionLagMs !== null && ingestionLagMs > 60 * 60 * 1000) diagnostics.push(`memory ingestion lag is ${Math.round(ingestionLagMs / 60000)} minute(s)`);
  diagnostics.push(...maintenance.diagnostics);

  const summary = {
    serving,
    writerGate,
    hotCacheFiles: hotFiles.length,
    ruleFiles: listFiles(rulesDir, (name) => name.endsWith(".md") && name !== "INDEX.md").length,
    queueBacklog,
    deadLetterCount,
    transcriptFiles: transcriptFiles.length,
    taskMemoryEntries: listFiles(taskMemoryDir, (name) => name.endsWith(".md")).length,
    projectCapsules: projectCapsuleFiles.length,
    missingProjectCapsules,
    newestProjectCapsuleAt,
    projectRefreshFailureCount: projectRefreshFailures.length,
    latestProjectRefreshFailureAt: projectRefreshFailures.at(-1)?.ts ?? null,
    vectorRowCount: vectorStats.count,
    memoryChunkCount,
    graphEntityCount,
    graphEdgeCount,
    graphMentionCount,
    ingestionLagMs,
    newestHotCacheAt,
    maintenanceStatus: maintenance.status,
    maintenanceLastRunAt: maintenance.lastRunAt,
    maintenanceFailedPhases: maintenance.failedPhases,
    stale,
    diagnostics,
  };
  recordOperationalMetric({
    category: "memory",
    name: "health",
    status: maintenance.status === "failed" ? "error" : "ok",
    dimensions: {
      hot_cache_files_count: summary.hotCacheFiles,
      rule_files_count: summary.ruleFiles,
      queue_backlog_count: summary.queueBacklog,
      dead_letter_count: summary.deadLetterCount,
      transcript_files_count: summary.transcriptFiles,
      task_memory_entries_count: summary.taskMemoryEntries,
      project_capsules_count: summary.projectCapsules,
      missing_project_capsules_count: summary.missingProjectCapsules,
      vector_rows_count: summary.vectorRowCount,
      memory_chunks_count: summary.memoryChunkCount,
      graph_entities_count: summary.graphEntityCount,
      graph_edges_count: summary.graphEdgeCount,
      graph_mentions_count: summary.graphMentionCount,
      ingestion_lag_ms: summary.ingestionLagMs,
      stale: summary.stale,
      maintenance_failed_phases_count: summary.maintenanceFailedPhases.length,
      serving_available: summary.serving.available,
      eligible_sources_count: summary.serving.sources.eligible,
      registered_sources_count: summary.serving.sources.registered,
      unknown_origin_excluded_count: summary.serving.sources.unknown_origin_excluded,
      source_coverage_percent: summary.serving.sources.coverage_percent,
      oldest_pending_age_ms: summary.serving.oldest_pending_age_ms,
      source_resolution_failures_count: summary.serving.source_resolution_failures,
      embedding_version_mismatch_count: summary.serving.embedding_version_mismatch,
      cache_stale_entries_count: summary.serving.cache.stale_entries,
      cache_evicted_entries_count: summary.serving.cache.evicted_entries,
      profile_processed_windows_count: summary.serving.profile.processed_windows,
      profile_pending_windows_count: summary.serving.profile.pending_windows,
    },
  }, {
    butlerData: input.butlerData,
  });
  return summary;
}

export function ingestTaskOutcomeMemory(input: {
  butlerData: string;
  taskId: string;
}): MemoryIngestionResult {
  const task = new TaskStore(input.butlerData).read(input.taskId);
  if (!task) throw new Error(`task not found: ${input.taskId}`);
  if (!task.planned?.publicReport) {
    throw new Error(`task has no reportable result: ${input.taskId}`);
  }
  const taskMemoryDir = join(cognitionMemoryRoot(input.butlerData), "tasks");
  mkdirSync(taskMemoryDir, { recursive: true });
  const memoryPath = join(taskMemoryDir, `${slug(input.taskId)}.md`);
  if (!["PUBLIC_REPORT_READY", "FAILED_PUBLIC_REPORT_READY", "REPORTED"].includes(task.planned.status) || !task.planned.review)
    throw new Error(`task has no reviewed public report: ${input.taskId}`);
  const review = task.planned.review;
  if (review.goal_review.goal.trim() !== plannedInternalGoal(task.planned.plan).trim() ||
    review.missing_evidence.length > 0 || missingReviewCriteria(task.planned, review.criteria).length > 0 ||
    review.criteria.some((criterion) => criterion.verdict === "PASS" && !criterion.evidence.trim()))
    throw new Error(`task report review binding is incomplete: ${input.taskId}`);
  if (task.planned.status === "PUBLIC_REPORT_READY" && (review.verdict !== "PASS" ||
    review.goal_review.verdict !== "PASS" || review.criteria.some((criterion) => criterion.verdict !== "PASS")))
    throw new Error(`task report success disposition conflicts with review: ${input.taskId}`);
  const report = new TaskStore(input.butlerData).readMemoryReport(input.taskId);
  if (!report || report.task_id !== input.taskId ||
    report.attempt !== review.attempt || report.project_id !== task.planned.plan.project) {
    throw new Error(`task report binding is not current: ${input.taskId}`);
  }
  if (report.disposition === "succeeded" && task.planned.status === "FAILED_PUBLIC_REPORT_READY" ||
    report.disposition !== "succeeded" && task.planned.status === "PUBLIC_REPORT_READY") {
    throw new Error(`task report disposition conflicts with status: ${input.taskId}`);
  }
  const summary = report.text;
  const body = [
    `# Task Memory: ${input.taskId}`,
    "",
    "## Provenance",
    `- task_id: ${input.taskId}`,
    "- source: task-result",
    (task.origin?.origin_session_id ?? task.planned?.plan.origin_session_id) ? `- origin_session_id: ${task.origin?.origin_session_id ?? task.planned?.plan.origin_session_id}` : "",
    (task.origin?.origin_inbound_event_id ?? task.planned?.plan.origin_event_id) ? `- origin_event_id: ${task.origin?.origin_inbound_event_id ?? task.planned?.plan.origin_event_id}` : "",
    "",
    "## Request",
    task.origin?.task_summary ?? task.request ?? "(unknown)",
    "",
    "## Outcome",
    summary,
  ].filter(Boolean).join("\n");
  writeFileSync(memoryPath, `${body.trim()}\n`, "utf8");
  const typed = readTypedMemoryRecord(input.butlerData, "task_report", report.record_id);
  if (!typed) throw new Error(`task report owner is unavailable: ${input.taskId}`);
  const operationId = typed.operation_id;
  enqueueTypedRecord(input.butlerData, {
    kind: "task_report", record_id: typed.record_id,
    revision: typed.revision, operation_id: operationId,
  });
  return {
    ok: true,
    task_id: input.taskId,
    memory_path: memoryPath,
    provenance: {
      task_id: input.taskId,
      source: "task-result",
      origin_session_id: task.origin?.origin_session_id ?? task.planned.plan.origin_session_id ?? undefined,
      origin_event_id: task.origin?.origin_inbound_event_id ?? task.planned.plan.origin_event_id ?? undefined,
    },
  };
}

export function updateExplicitMemory(input: {
  butlerData: string;
  update: ExplicitMemoryUpdate;
  operationId?: string;
  projectId?: string | null;
  conversationSessionId?: string | null;
  conversationMessageId?: string | null;
  recordId?: string;
}): { ok: true; path: string; record_id: string; revision: string; operation_id: string; replayed: boolean } {
  const text = input.update.text;
  if (!text.trim()) throw new Error("explicit memory update requires text");
  const rulesDir = join(cognitionMemoryRoot(input.butlerData), "rules");
  mkdirSync(rulesDir, { recursive: true });
  const operationId = input.operationId?.trim() || randomUUID();
  const recordId = input.recordId?.trim() ||
    createHash("sha256").update(`explicit-rule:${operationId}`).digest("hex");
  const file = `${recordId}.md`;
  const path = join(rulesDir, file);
  const typed = writeExplicitRuleRecord({
    butlerData: input.butlerData,
    recordId, operationId, text, projectId: input.projectId,
    conversationSessionId: input.conversationSessionId,
    conversationMessageId: input.conversationMessageId,
  });
  const indexPath = join(rulesDir, "INDEX.md");
  const index = readText(indexPath);
  const line = `- [${compact(text, 80)}](${file})\n`;
  if (!index.includes(`](${file})`)) {
    appendFileSync(indexPath, line, "utf8");
  }
  enqueueTypedRecord(input.butlerData, {
    kind: "explicit_record", record_kind: "rule", record_id: recordId,
    revision: typed.receiptRevision, operation_id: operationId,
  });
  return { ok: true, path, record_id: recordId, revision: typed.receiptRevision, operation_id: operationId, replayed: typed.replayed };
}

export function forgetExplicitMemory(input: {
  butlerData: string;
  recordId: string;
  operationId: string;
}): { record_id: string; revision: string; replayed: boolean } {
  const binding = readExplicitRuleBinding(
    input.butlerData,
    input.recordId,
    { unavailable: "throw" },
  );
  if (!binding) {
    if (basename(input.recordId) !== input.recordId || !input.recordId.trim()) {
      throw new Error("explicit memory record not found");
    }
    const paths = explicitRulePaths(input.butlerData, input.recordId);
    let legacyText: string;
    try {
      legacyText = readFileSync(paths.text, "utf8");
    } catch {
      throw new Error("explicit memory record not found");
    }
    const revision = createHash("sha256").update(JSON.stringify([
      "legacy-explicit-rule", input.recordId,
      createHash("sha256").update(legacyText).digest("hex"),
      "forgotten", input.operationId,
    ])).digest("hex");
    rmSync(paths.text, { force: true });
    const indexPath = join(paths.root, "INDEX.md");
    if (existsSync(indexPath)) {
      const link = `](${input.recordId}.md)`;
      const retained = readFileSync(indexPath, "utf8").split(/(?<=\n)/u)
        .filter((line) => !line.includes(link)).join("");
      writeFileSync(indexPath, retained, { encoding: "utf8", mode: 0o600 });
    }
    return { record_id: input.recordId, revision, replayed: false };
  }
  const prior = binding.operations.find((item) => item.operation_id === input.operationId);
  if (prior) return { record_id: input.recordId, revision: prior.revision, replayed: true };
  const revision = createHash("sha256").update(JSON.stringify([
    "explicit_record", input.recordId, "forgotten", binding.revision,
  ])).digest("hex");
  const updated: ExplicitRuleBinding = {
    ...binding,
    state: "forgotten",
    revision,
    operation_id: input.operationId,
    operations: [...binding.operations, {
      operation_id: input.operationId,
      revision,
      state: "forgotten",
    }],
  };
  const paths = explicitRulePaths(input.butlerData, input.recordId);
  writeFileSync(paths.binding, `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  rmSync(paths.text, { force: true });
  enqueueTypedRecord(input.butlerData, {
    kind: "explicit_record",
    record_kind: "rule",
    record_id: input.recordId,
    revision,
    operation_id: input.operationId,
  });
  return { record_id: input.recordId, revision, replayed: false };
}

export function recallMemoryEvidence(input: {
  butlerData: string;
  cue: string;
  projectId?: string;
  evidencePolicy?: RecallEvidencePolicy;
  limit?: number;
}): MemoryRecallResult {
  const cue = input.cue.trim();
  if (!cue) throw new Error("memory recall requires cue");
  const recall = recallMemory({
    butlerData: input.butlerData,
    cue,
    projectId: input.projectId,
    evidencePolicy: input.evidencePolicy,
    limit: input.limit,
  });
  return memoryRecallEvidenceFromRecall({
    butlerData: input.butlerData,
    cue,
    recall,
  });
}

export async function recallMemoryEvidenceWithVector(input: {
  butlerData: string;
  cue: string;
  projectId?: string;
  evidencePolicy?: RecallEvidencePolicy;
  limit?: number;
  vectorQueries?: string[];
  vectorBackend?: VectorEpisodeBackend;
  vectorTimeoutMs?: number;
}): Promise<MemoryRecallResult> {
  const cue = input.cue.trim();
  if (!cue) throw new Error("memory recall requires cue");
  const recall = await recallMemoryWithVector({
    butlerData: input.butlerData,
    cue,
    projectId: input.projectId,
    evidencePolicy: input.evidencePolicy,
    limit: input.limit,
    vectorQueries: input.vectorQueries,
    vectorBackend: input.vectorBackend,
    vectorTimeoutMs: input.vectorTimeoutMs,
  });
  return memoryRecallEvidenceFromRecall({
    butlerData: input.butlerData,
    cue,
    recall,
  });
}

function memoryRecallEvidenceFromRecall(input: {
  butlerData: string;
  cue: string;
  recall: AssociativeRecallResult;
}): MemoryRecallResult {
  const { butlerData, cue, recall } = input;
  return {
    cue,
    seeds: recall.seeds,
    results: recall.items.flatMap((item) => {
      const source = item.originalSource ?? (item.source === "vector" ? "vector" : undefined);
      const path = item.provenance[0] ?? "";
      if (
        source !== "hot-cache" &&
        source !== "project-memory" &&
        source !== "task-memory" &&
        source !== "rules" &&
        source !== "graph" &&
        source !== "vector"
      ) {
        return [];
      }
      return [{
        text: path.startsWith(butlerData) ? compactEvidenceText(readRecallEvidenceText(path), 700) : item.summary,
        score: item.confidence,
        source,
        path,
      }];
    }),
    items: recall.items,
    abstained: recall.abstained,
    diagnostics: recall.diagnostics,
  };
}
