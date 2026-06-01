import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { Database } from "bun:sqlite";
import { TaskStore } from "../../work/task-store.ts";
import {
  recallMemory,
  recallMemoryWithVector,
  type AssociativeRecallResult,
  type RecallEvidencePolicy,
} from "./recall/engine.ts";
import { readProjectRefreshFailures, sanitizeProjectMemoryId } from "./project-memory.ts";
import { cognitionConsolidationRoot, cognitionMemoryRoot } from "../paths.ts";
import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import { memoryMetadataPath } from "./metadata.ts";

export type MemoryMaintenanceStatus =
  | "missing"
  | "ok"
  | "stale"
  | "failed"
  | "repaired";

export interface MemoryHealthSummary {
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
  if (!task.observedResult && !task.result && !task.planned?.publicReport) {
    throw new Error(`task has no reportable result: ${input.taskId}`);
  }
  const taskMemoryDir = join(cognitionMemoryRoot(input.butlerData), "tasks");
  mkdirSync(taskMemoryDir, { recursive: true });
  const memoryPath = join(taskMemoryDir, `${slug(input.taskId)}.md`);
  const summary = task.planned?.publicReport ?? task.observedResult ?? task.result ?? "";
  const body = [
    `# Task Memory: ${input.taskId}`,
    "",
    "## Provenance",
    `- task_id: ${input.taskId}`,
    "- source: task-result",
    task.origin?.origin_session_id ? `- origin_session_id: ${task.origin.origin_session_id}` : "",
    task.origin?.origin_inbound_event_id ? `- origin_event_id: ${task.origin.origin_inbound_event_id}` : "",
    "",
    "## Request",
    task.origin?.task_summary ?? task.request ?? "(unknown)",
    "",
    "## Outcome",
    summary,
  ].filter(Boolean).join("\n");
  writeFileSync(memoryPath, `${body.trim()}\n`, "utf8");
  return {
    ok: true,
    task_id: input.taskId,
    memory_path: memoryPath,
    provenance: {
      task_id: input.taskId,
      source: "task-result",
      origin_session_id: task.origin?.origin_session_id ?? undefined,
      origin_event_id: task.origin?.origin_inbound_event_id ?? undefined,
    },
  };
}

export function updateExplicitMemory(input: {
  butlerData: string;
  update: ExplicitMemoryUpdate;
}): { ok: true; path: string } {
  const text = input.update.text.trim();
  if (!text) throw new Error("explicit memory update requires text");
  const source = input.update.source.trim() || "manual";
  const rulesDir = join(cognitionMemoryRoot(input.butlerData), "rules");
  mkdirSync(rulesDir, { recursive: true });
  const file = `${new Date().toISOString().slice(0, 10)}-${slug(text)}.md`;
  const path = join(rulesDir, file);
  writeFileSync(path, `# Rule\n\n${text}\n\nProvenance: ${source}\n`, "utf8");
  const indexPath = join(rulesDir, "INDEX.md");
  const index = readText(indexPath);
  const line = `- [${compact(text, 80)}](${file})\n`;
  if (!index.includes(`](${file})`)) {
    appendFileSync(indexPath, line, "utf8");
  }
  return { ok: true, path };
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
        text: path.startsWith(butlerData) ? compactEvidenceText(readText(path), 700) : item.summary,
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
