import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { Database } from "bun:sqlite";
import { cognitionMemoryRoot } from "../paths.ts";
import {
  acquireConsolidationLock,
  acquireConsolidationLockAsync,
  assertConsolidationLease,
  consolidationLockPath,
  releaseConsolidationLock,
  type ConsolidationLease,
} from "./scripts/lib/lock.ts";

export function sanitizeProjectMemoryId(projectId: string): string {
  return projectId.replace(/[/\\\0]/g, "_");
}

export function projectMemoryPath(input: {
  butlerData: string;
  projectId?: string | null;
}): string | null {
  const projectId = input.projectId?.trim();
  if (!projectId) return null;
  return join(cognitionMemoryRoot(input.butlerData), "projects", `${sanitizeProjectMemoryId(projectId)}.md`);
}

export function readProjectCapsuleForPrompt(input: {
  butlerData: string;
  projectId?: string | null;
}): string | null {
  const path = projectMemoryPath(input);
  if (!path) return null;
  const body = readText(path);
  if (!body) return null;
  const filtered = body.split(/\r?\n/u).filter((line) =>
    !line.includes("generation-hot-cache:") && !line.includes("project-hot-cache:"),
  ).join("\n").trim();
  return filtered || null;
}

export interface ProjectCapsuleRefreshResult {
  ok: true;
  projectId: string;
  path: string;
  bytes: number;
  sourceCounts: {
    registry: number;
    tasks: number;
    explicitFeedback: number;
    projectHotCache: number;
    memoryEvidence: number;
    graphEvidence: number;
    promoted: number;
  };
}

export interface ProjectCapsuleInspectResult {
  ok: true;
  projectId: string;
  path: string;
  exists: boolean;
  bytes: number;
  updatedAt: string | null;
  sectionHeadings: string[];
  sourceCounts: ProjectCapsuleRefreshResult["sourceCounts"] | null;
  refreshFailures: {
    count: number;
    latest: ProjectRefreshFailureRecord | null;
  };
  diagnostics: string[];
  privacy: {
    rawTextIncluded: false;
  };
}

export interface ProjectRefreshFailureRecord {
  ts: string;
  projectId: string;
  phase: "lock" | "refresh";
  message: string;
}

export interface ProjectCapsuleMaintenanceResult {
  ok: true;
  considered: number;
  refreshed: number;
  failed: Array<{ projectId: string; message: string }>;
}

interface ProjectConfigEntry {
  name?: string;
  path?: string;
  description?: string;
  aliases?: string[];
}

interface TaskSummary {
  id: string;
  project: string;
  status: string;
  request: string;
  result: string;
  sourcePath: string;
}

type PromotionCategory = "conventions" | "decisions" | "feedback" | "risks";

interface PromotionCandidate {
  category: PromotionCategory;
  text: string;
  normalized: string;
  provenance: string;
}

interface PromotionItem {
  category: PromotionCategory;
  text: string;
  sources: number;
  provenance: string[];
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsProject(text: string, projectId: string): boolean {
  const id = projectId.trim();
  if (!id) return false;
  return new RegExp(`(^|[^a-z0-9가-힣._-])${escapeRegExp(id)}([^a-z0-9가-힣._-]|$)`, "iu").test(text);
}

function readProjectRegistry(input: {
  butlerData: string;
  projectId: string;
}): ProjectConfigEntry | null {
  return readProjectRegistryEntries(input.butlerData)
    .find((project) => project?.name === input.projectId) ?? null;
}

function readProjectRegistryEntries(butlerData: string): ProjectConfigEntry[] {
  const raw = readText(join(butlerData, "butler.config.json"));
  if (!raw) return [];
  try {
    const config = JSON.parse(raw) as { projects?: unknown };
    const projects = Array.isArray(config.projects)
      ? config.projects
      : Object.values(config.projects ?? {});
    return (projects as ProjectConfigEntry[])
      .filter((project) => typeof project?.name === "string" && project.name.trim().length > 0);
  } catch {
    return [];
  }
}

function listRecentProjectTasks(input: {
  butlerData: string;
  projectId: string;
  workspacePath?: string;
  limit: number;
}): TaskSummary[] {
  const tasksDir = join(input.butlerData, "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(tasksDir, entry.name);
      return {
        id: entry.name,
        project: readText(join(dir, "project")),
        status: readText(join(dir, "status")),
        request: readText(join(dir, "request.md")),
        result: readText(join(dir, "result.md")) || readText(join(dir, "observed_result.md")),
      };
    })
    .filter((task) =>
      task.project === input.projectId ||
      (input.workspacePath ? task.project === input.workspacePath : false),
    )
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, input.limit)
    .map((task) => ({
      id: task.id,
      project: task.project,
      status: task.status || "UNKNOWN",
      request: task.request,
      result: task.result,
      sourcePath: join(tasksDir, task.id),
    }));
}

function listProjectMemoryEvidence(input: {
  butlerData: string;
  projectId: string;
  limit: number;
}): Array<{ path: string; text: string }> {
  const taskMemoryDir = join(cognitionMemoryRoot(input.butlerData), "tasks");
  if (!existsSync(taskMemoryDir)) return [];
  return readdirSync(taskMemoryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const path = join(taskMemoryDir, entry.name);
      return { path, text: readText(path), mtimeMs: statSync(path).mtimeMs };
    })
    .filter((item) => textMentionsProject(item.text, input.projectId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, input.limit)
    .map(({ path, text }) => ({ path, text }));
}

function listExplicitProjectFeedback(input: {
  butlerData: string;
  projectId: string;
  limit: number;
}): Array<{ path: string; text: string }> {
  const safeProjectId = sanitizeProjectMemoryId(input.projectId);
  const paths = [
    join(cognitionMemoryRoot(input.butlerData), "rules", "projects", `${safeProjectId}.md`),
    ...(
      existsSync(join(cognitionMemoryRoot(input.butlerData), "rules", "projects", safeProjectId))
        ? readdirSync(join(cognitionMemoryRoot(input.butlerData), "rules", "projects", safeProjectId), { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => join(cognitionMemoryRoot(input.butlerData), "rules", "projects", safeProjectId, entry.name))
        : []
    ),
  ];
  return paths
    .filter((path) => existsSync(path))
    .map((path) => ({ path, text: readText(path) }))
    .filter((item) => item.text.trim().length > 0)
    .slice(0, input.limit);
}

type ProjectGraphEvidence = {
  sourceId: number;
  mentionProject: string | null;
  entityProject: string | null;
  provenance: string;
  text: string;
};

function listProjectGraphEvidence(input: {
  butlerData: string;
  projectId: string;
  limit: number;
}): ProjectGraphEvidence[] {
  const dbPath = join(cognitionMemoryRoot(input.butlerData), "db", "graph.sqlite");
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(`
        SELECT m.id, m.session_id, m.project mention_project, m.snippet, e.project entity_project, e.name
        FROM entity_mentions m
        JOIN entities e ON e.id = m.entity_id
        WHERE m.snippet IS NOT NULL
          AND length(m.snippet) > 0
          AND (m.project = ? OR e.project = ?)
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(input.projectId, input.projectId, input.limit) as Array<{
        id: number;
        session_id: string;
        mention_project: string | null;
        snippet: string;
        entity_project: string | null;
        name: string;
      }>;
      return rows.map((row) => ({
        sourceId: row.id,
        mentionProject: row.mention_project,
        entityProject: row.entity_project,
        provenance: `graph:${row.session_id || row.id}`,
        text: row.snippet || row.name,
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function projectRefreshFailurePath(butlerData: string): string {
  return join(cognitionMemoryRoot(butlerData), "projects", ".refresh-failures.jsonl");
}

function recordProjectRefreshFailure(input: {
  butlerData: string;
  projectId: string;
  phase: ProjectRefreshFailureRecord["phase"];
  message: string;
  now?: string;
}): void {
  const path = projectRefreshFailurePath(input.butlerData);
  const record: ProjectRefreshFailureRecord = {
    ts: input.now ?? new Date().toISOString(),
    projectId: input.projectId,
    phase: input.phase,
    message: compact(input.message, 300),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Diagnostics must never make the original refresh failure harder to recover.
  }
}

export function readProjectRefreshFailures(input: {
  butlerData: string;
  projectId?: string;
  limit?: number;
}): ProjectRefreshFailureRecord[] {
  const text = readText(projectRefreshFailurePath(input.butlerData));
  if (!text) return [];
  const projectId = input.projectId?.trim();
  const records = text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as Partial<ProjectRefreshFailureRecord>;
      if (
        typeof parsed.ts !== "string" ||
        typeof parsed.projectId !== "string" ||
        (parsed.phase !== "lock" && parsed.phase !== "refresh") ||
        typeof parsed.message !== "string"
      ) {
        return [];
      }
      return [{
        ts: parsed.ts,
        projectId: parsed.projectId,
        phase: parsed.phase,
        message: parsed.message,
      }];
    } catch {
      return [];
    }
  }).filter((record) => !projectId || record.projectId === projectId);
  return input.limit === undefined ? records : records.slice(-input.limit);
}

function categoryForStatement(statement: string): PromotionCategory | null {
  const match = /^\s*(?:\[(convention|conventions|decision|decisions|feedback|risk|risks)\]|(convention|conventions|decision|decisions|feedback|risk|risks)\s*[:：-])/iu
    .exec(statement);
  const label = (match?.[1] ?? match?.[2] ?? "").toLowerCase();
  if (label === "convention" || label === "conventions") return "conventions";
  if (label === "decision" || label === "decisions") return "decisions";
  if (label === "feedback") return "feedback";
  if (label === "risk" || label === "risks") {
    return "risks";
  }
  return null;
}

function normalizedStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[`*_#[\](){}]/g, " ")
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statementFragments(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[.!?。])\s+/u)
    .map((line) => line.replace(/^\s*[-*]\s+/, "").replace(/^#+\s*/, "").trim())
    .map((line) => line.replace(/\s*\((?:provenance|source):[^)]*\)\s*$/i, "").trim())
    .filter((line) => line.length >= 18 && line.length <= 240)
    .filter((line) => !/^provenance[:\s]/i.test(line))
    .filter((line) => !/^source_counts[:\s]/i.test(line));
}

function promotionCandidatesFromSource(input: {
  text: string;
  provenance: string;
}): PromotionCandidate[] {
  return statementFragments(input.text).flatMap((statement) => {
    const category = categoryForStatement(statement);
    if (!category) return [];
    const normalized = normalizedStatement(statement);
    if (normalized.length < 12) return [];
    return [{
      category,
      text: compact(statement, 180),
      normalized,
      provenance: input.provenance,
    }];
  });
}

function collectPromotions(input: {
  sources: Array<{ text: string; provenance: string }>;
  limitPerCategory?: number;
}): Record<PromotionCategory, PromotionItem[]> {
  const groups = new Map<string, PromotionCandidate[]>();
  for (const source of input.sources) {
    for (const candidate of promotionCandidatesFromSource(source)) {
      const key = `${candidate.category}\u0000${candidate.normalized}`;
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
  }

  const result: Record<PromotionCategory, PromotionItem[]> = {
    conventions: [],
    decisions: [],
    feedback: [],
    risks: [],
  };
  for (const candidates of groups.values()) {
    const provenance = [...new Set(candidates.map((candidate) => candidate.provenance))];
    if (provenance.length < 2) continue;
    const first = candidates[0]!;
    result[first.category].push({
      category: first.category,
      text: first.text,
      sources: provenance.length,
      provenance: provenance.slice(0, 5),
    });
  }

  const limit = input.limitPerCategory ?? 6;
  for (const category of Object.keys(result) as PromotionCategory[]) {
    result[category] = result[category]
      .sort((left, right) => right.sources - left.sources || left.text.localeCompare(right.text))
      .slice(0, limit);
  }
  return result;
}

function renderPromotions(category: PromotionCategory, items: PromotionItem[]): string[] {
  return items.map((item) =>
    `- ${item.text} (provenance: promoted:${category}; sources=${item.sources}; evidence=${item.provenance.join(", ")})`,
  );
}

function boundedMarkdown(lines: string[], maxBytes: number): string {
  let text = `${lines.join("\n").trim()}\n`;
  while (Buffer.byteLength(text, "utf8") > maxBytes && lines.length > 0) {
    const index = lines.findLastIndex((line) => line.startsWith("- "));
    if (index < 0) break;
    lines.splice(index, 1);
    text = `${lines.join("\n").trim()}\n`;
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${text.slice(0, Math.max(0, maxBytes - 20)).trim()}\n\n[truncated]\n`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function staleLock(path: string, staleAfterMs: number): boolean {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return false;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  const raw = readText(path);
  let pid: number | null;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    pid = typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    const parsed = Number.parseInt(raw.trim(), 10);
    pid = Number.isFinite(parsed) ? parsed : null;
  }
  if (ageMs > staleAfterMs) return true;
  return pid !== null && !isProcessAlive(pid);
}

function acquireProjectCapsuleLock(path: string, staleAfterMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify({
      pid: process.pid,
      created_at: new Date().toISOString(),
    })}\n`, { encoding: "utf8", flag: "wx" });
    return;
  } catch {
    if (existsSync(path) && staleLock(path, staleAfterMs)) {
      const stalePath = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(path, stalePath);
      } catch {
        throw new Error("locked");
      }
      try {
        writeFileSync(path, `${JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
          recovered_stale_lock: true,
        })}\n`, { encoding: "utf8", flag: "wx" });
      } catch {
        rmSync(stalePath, { force: true });
        throw new Error("locked");
      }
      rmSync(stalePath, { force: true });
      return;
    }
    throw new Error("locked");
  }
}

type ProjectCapsuleRefreshInput = {
  butlerData: string;
  projectId: string;
  workspacePath?: string;
  now?: string;
  maxBytes?: number;
  lockStaleAfterMs?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
};

type ProjectCapsuleSourceSnapshot = {
  registry: ProjectConfigEntry | null;
  workspacePath?: string;
  tasks: TaskSummary[];
  evidence: Array<{ path: string; text: string }>;
  feedback: Array<{ path: string; text: string }>;
  graph: ProjectGraphEvidence[];
};

type PreparedProjectCapsule = ProjectCapsuleRefreshResult & {
  body: string;
  sourceRevision: string;
  sourceSnapshot: ProjectCapsuleSourceSnapshot;
};

function readProjectCapsuleSourceSnapshot(
  input: ProjectCapsuleRefreshInput,
  projectId: string,
): ProjectCapsuleSourceSnapshot {
  const registry = readProjectRegistry({ butlerData: input.butlerData, projectId });
  const workspacePath = input.workspacePath ?? registry?.path;
  return {
    registry,
    tasks: listRecentProjectTasks({ butlerData: input.butlerData, projectId, workspacePath, limit: 5 }),
    evidence: listProjectMemoryEvidence({ butlerData: input.butlerData, projectId, limit: 5 }),
    feedback: listExplicitProjectFeedback({ butlerData: input.butlerData, projectId, limit: 5 }),
    graph: listProjectGraphEvidence({ butlerData: input.butlerData, projectId, limit: 12 }),
    workspacePath,
  };
}

function capsuleSourceRevision(snapshot: ProjectCapsuleSourceSnapshot): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function selectedProjectCapsuleSourcesAreCurrent(
  input: ProjectCapsuleRefreshInput,
  projectId: string,
  snapshot: ProjectCapsuleSourceSnapshot,
): boolean {
  if (JSON.stringify(readProjectRegistry({ butlerData: input.butlerData, projectId })) !==
    JSON.stringify(snapshot.registry)) return false;
  for (const task of snapshot.tasks) {
    const current: TaskSummary = {
      id: task.id,
      project: readText(join(task.sourcePath, "project")),
      status: readText(join(task.sourcePath, "status")) || "UNKNOWN",
      request: readText(join(task.sourcePath, "request.md")),
      result: readText(join(task.sourcePath, "result.md")) || readText(join(task.sourcePath, "observed_result.md")),
      sourcePath: task.sourcePath,
    };
    if (JSON.stringify(current) !== JSON.stringify(task)) return false;
  }
  for (const item of [...snapshot.evidence, ...snapshot.feedback]) {
    if (readText(item.path) !== item.text) return false;
  }
  if (snapshot.graph.length === 0) return true;
  const dbPath = join(cognitionMemoryRoot(input.butlerData), "db", "graph.sqlite");
  if (!existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true });
  try {
    const read = db.prepare("SELECT m.id,m.session_id,m.project mention_project,m.snippet,e.project entity_project,e.name FROM entity_mentions m JOIN entities e ON e.id=m.entity_id WHERE m.id=?");
    for (const expected of snapshot.graph) {
      const row = read.get(expected.sourceId) as {
        id: number;
        session_id: string;
        mention_project: string | null;
        snippet: string;
        entity_project: string | null;
        name: string;
      } | null;
      const current: ProjectGraphEvidence | null = row ? {
        sourceId: row.id,
        mentionProject: row.mention_project,
        entityProject: row.entity_project,
        provenance: `graph:${row.session_id || row.id}`,
        text: row.snippet || row.name,
      } : null;
      if (!current || JSON.stringify(current) !== JSON.stringify(expected) ||
        (current.mentionProject !== projectId && current.entityProject !== projectId)) return false;
    }
    return true;
  } finally { db.close(); }
}

function prepareProjectCapsule(input: ProjectCapsuleRefreshInput): PreparedProjectCapsule {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("project capsule refresh requires projectId");

  const path = projectMemoryPath({
    butlerData: input.butlerData,
    projectId,
  });
  if (!path) throw new Error("project capsule path could not be resolved");

  const lockPath = join(
    cognitionMemoryRoot(input.butlerData),
    "locks",
    "project-capsules",
    `${sanitizeProjectMemoryId(projectId)}.lock`,
  );
  try {
    acquireProjectCapsuleLock(lockPath, input.lockStaleAfterMs ?? 10 * 60 * 1000);
  } catch {
    const message = `project capsule refresh already running for ${projectId}`;
    recordProjectRefreshFailure({
      butlerData: input.butlerData,
      projectId,
      phase: "lock",
      message,
      now: input.now,
    });
    throw new Error(message);
  }

  try {
    const sourceSnapshot = readProjectCapsuleSourceSnapshot(input, projectId);
    const sourceRevision = capsuleSourceRevision(sourceSnapshot);
    const now = input.now ?? new Date().toISOString();
    const { registry, workspacePath, tasks, evidence, feedback: explicitFeedback, graph: graphEvidence } = sourceSnapshot;
    const projectHotCache = "";
    const promotionSources = [
      ...tasks.flatMap((task) => [
        task.request ? { text: task.request, provenance: `task:${task.id}` } : null,
        task.result ? { text: task.result, provenance: `task:${task.id}` } : null,
      ]),
      ...evidence.map((item) => ({ text: item.text, provenance: `memory-evidence:${item.path}` })),
      ...graphEvidence,
    ].filter((item): item is { text: string; provenance: string } => Boolean(item?.text.trim()));
    const promotions = collectPromotions({
      sources: promotionSources,
    });
    const promotedCount = Object.values(promotions).reduce((total, items) => total + items.length, 0);
    const sourceCounts = {
      registry: registry ? 1 : 0,
      tasks: tasks.length,
      explicitFeedback: explicitFeedback.length,
      projectHotCache: projectHotCache ? 1 : 0,
      memoryEvidence: evidence.length,
      graphEvidence: graphEvidence.length,
      promoted: promotedCount,
    };
    const lines = [
      `# Project Memory: ${projectId}`,
      "",
      "## Identity",
      `- project_id: ${projectId}`,
      workspacePath ? `- canonical_path: ${workspacePath}` : "- canonical_path: unknown",
      registry?.description ? `- purpose: ${compact(registry.description, 220)}` : "- purpose: unknown",
      registry?.aliases?.length ? `- aliases: ${registry.aliases.join(", ")}` : "",
      "",
      "## Structure",
      workspacePath ? `- Workspace path: ${workspacePath}` : "- Workspace path: unknown",
      "- Structure refresh is pending deeper repository inspection.",
      "",
      "## Conventions",
      ...(
        promotions.conventions.length > 0
          ? renderPromotions("conventions", promotions.conventions)
          : ["- No explicit project conventions have been promoted yet."]
      ),
      "",
      "## Active Work",
      ...(
        tasks.length > 0
          ? tasks.map((task) =>
              `- [${task.status}] ${compact(task.request || task.id, 180)}${task.result ? ` -> ${compact(task.result, 180)}` : ""} (provenance: task:${task.id})`,
            )
          : ["- No recent project tasks found."]
      ),
      "",
      "## Decisions",
      ...(
        promotions.decisions.length > 0
          ? renderPromotions("decisions", promotions.decisions)
          : evidence.length > 0
          ? evidence.map((item) => `- Review memory evidence ${item.path} before promoting durable decisions. (provenance: memory-evidence:${item.path})`)
          : ["- No durable project decisions have been promoted yet."]
      ),
      "",
      "## Feedback",
      ...(
        explicitFeedback.length > 0
          ? explicitFeedback.map((item) =>
              `- Explicit project feedback: ${compact(item.text, 320)} (provenance: explicit-project-rule:${item.path})`,
            )
          : []
      ),
      explicitFeedback.length > 0 ? "" : "- No project-local hot cache was found.",
      ...renderPromotions("feedback", promotions.feedback),
      "",
      "## Risks",
      ...(
        promotions.risks.length > 0
          ? renderPromotions("risks", promotions.risks)
          : ["- No explicit project risks have been promoted yet."]
      ),
      "",
      "## Freshness",
      `- refreshed_at: ${now}`,
      `- source_counts: registry=${sourceCounts.registry}, tasks=${sourceCounts.tasks}, explicit_feedback=${sourceCounts.explicitFeedback}, project_hot_cache=${sourceCounts.projectHotCache}, memory_evidence=${sourceCounts.memoryEvidence}, graph_evidence=${sourceCounts.graphEvidence}, promoted=${sourceCounts.promoted}`,
      "- confidence: partial; refresh uses bounded registry, task, hot-cache, memory-evidence, and graph inputs.",
    ].filter(Boolean);
    const body = boundedMarkdown(lines, input.maxBytes ?? 12_000);
    return {
      ok: true,
      projectId,
      path,
      bytes: Buffer.byteLength(body, "utf8"),
      sourceCounts,
      body,
      sourceRevision,
      sourceSnapshot,
    };
  } catch (error) {
    recordProjectRefreshFailure({
      butlerData: input.butlerData,
      projectId,
      phase: "refresh",
      message: error instanceof Error ? error.message : String(error),
      now: input.now,
    });
    throw error;
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function commitPreparedProjectCapsule(
  input: ProjectCapsuleRefreshInput,
  prepared: PreparedProjectCapsule,
  lease: ConsolidationLease,
): ProjectCapsuleRefreshResult {
  const gatePath = consolidationLockPath(input.butlerData);
  assertConsolidationLease(gatePath, lease);
  if (!selectedProjectCapsuleSourcesAreCurrent(input, prepared.projectId, prepared.sourceSnapshot) ||
    capsuleSourceRevision(prepared.sourceSnapshot) !== prepared.sourceRevision) {
    throw new Error("memory_source_changed");
  }
  mkdirSync(dirname(prepared.path), { recursive: true });
  const tmp = `${prepared.path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, prepared.body, { encoding: "utf8", mode: 0o600 });
  const descriptor = openSync(tmp, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(tmp, prepared.path);
  const directory = openSync(dirname(prepared.path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  const { body: _body, sourceRevision: _sourceRevision, sourceSnapshot: _sourceSnapshot, ...result } = prepared;
  return result;
}

export function refreshProjectCapsule(input: ProjectCapsuleRefreshInput): ProjectCapsuleRefreshResult {
  const prepared = prepareProjectCapsule(input);
  const path = consolidationLockPath(input.butlerData);
  const lease = acquireConsolidationLock(path, { purpose: "consolidation" });
  if (!lease) throw new Error("memory_write_busy");
  let commit = false;
  try { const result = commitPreparedProjectCapsule(input, prepared, lease); commit = true; return result; }
  finally { releaseConsolidationLock(path, lease, commit); }
}

export async function refreshProjectCapsuleAsync(input: ProjectCapsuleRefreshInput): Promise<ProjectCapsuleRefreshResult> {
  const prepared = prepareProjectCapsule(input);
  const path = consolidationLockPath(input.butlerData);
  const lease = await acquireConsolidationLockAsync(path, {
    purpose: "consolidation",
    waitClass: "background",
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  if (!lease) throw new Error("memory_write_busy");
  let commit = false;
  try { const result = commitPreparedProjectCapsule(input, prepared, lease); commit = true; return result; }
  finally { releaseConsolidationLock(path, lease, commit); }
}

function parseSourceCounts(body: string): ProjectCapsuleRefreshResult["sourceCounts"] | null {
  const line = body.split(/\r?\n/).find((item) => item.includes("source_counts:"));
  if (!line) return null;
  const pairs = [...line.matchAll(/([a-z_]+)=([0-9]+)/g)];
  const values = new Map(pairs.map((match) => [match[1], Number.parseInt(match[2], 10)]));
  return {
    registry: values.get("registry") ?? 0,
    tasks: values.get("tasks") ?? 0,
    explicitFeedback: values.get("explicit_feedback") ?? 0,
    projectHotCache: values.get("project_hot_cache") ?? 0,
    memoryEvidence: values.get("memory_evidence") ?? 0,
    graphEvidence: values.get("graph_evidence") ?? 0,
    promoted: values.get("promoted") ?? 0,
  };
}

export function inspectProjectCapsule(input: {
  butlerData: string;
  projectId: string;
}): ProjectCapsuleInspectResult {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("project capsule inspect requires projectId");
  const path = projectMemoryPath({
    butlerData: input.butlerData,
    projectId,
  });
  if (!path) throw new Error("project capsule path could not be resolved");

  const exists = existsSync(path);
  const body = exists ? readText(path) : "";
  const failures = readProjectRefreshFailures({
    butlerData: input.butlerData,
    projectId,
    limit: 20,
  });
  const diagnostics: string[] = [];
  let bytes = 0;
  let updatedAt: string | null = null;
  if (exists) {
    try {
      const stat = statSync(path);
      bytes = stat.size;
      updatedAt = new Date(stat.mtimeMs).toISOString();
    } catch {
      diagnostics.push("project capsule stat failed");
    }
  } else {
    diagnostics.push("project capsule is missing");
  }
  if (failures.length > 0) diagnostics.push("project capsule has refresh failure history");
  if (exists && !body.includes("source_counts:")) diagnostics.push("project capsule source counts are missing");

  return {
    ok: true,
    projectId,
    path,
    exists,
    bytes,
    updatedAt,
    sectionHeadings: body.split(/\r?\n/)
      .filter((line) => /^##\s+/.test(line))
      .map((line) => line.replace(/^##\s+/, "").trim()),
    sourceCounts: exists ? parseSourceCounts(body) : null,
    refreshFailures: {
      count: failures.length,
      latest: failures.at(-1) ?? null,
    },
    diagnostics,
    privacy: {
      rawTextIncluded: false,
    },
  };
}

export async function refreshRegisteredProjectCapsules(input: {
  butlerData: string;
  now?: string;
  maxProjects?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<ProjectCapsuleMaintenanceResult> {
  const projects = readProjectRegistryEntries(input.butlerData)
    .slice(0, Math.max(0, input.maxProjects ?? 20));
  const failed: Array<{ projectId: string; message: string }> = [];
  let refreshed = 0;

  for (const project of projects) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("memory_operation_aborted");
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw new Error("memory_write_timeout");
    }
    const projectId = project.name?.trim();
    if (!projectId) continue;
    try {
      await refreshProjectCapsuleAsync({
        butlerData: input.butlerData,
        projectId,
        workspacePath: project.path,
        now: input.now,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      });
      refreshed += 1;
    } catch (error) {
      failed.push({
        projectId,
        message: compact(error instanceof Error ? error.message : String(error), 300),
      });
    }
  }

  return {
    ok: true,
    considered: projects.length,
    refreshed,
    failed,
  };
}
