import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

import { readMemoryHealth } from "../../packages/butler-agent/src/agent/cognition/memory/quality.ts";
import { compactHotCacheFile } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/hot-cache-compaction.ts";
import { runConsolidate } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/consolidate.ts";
import { runOptimize, type OptimizeTable } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/optimize.ts";
import { runConsolidationCycle, type ConsolidationCycleConfig } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-memory-maintenance-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createGraphDb(): Database {
  const dbPath = join(tempDir, "graph.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      project TEXT,
      properties TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      activation REAL
    );

    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      properties TEXT DEFAULT '{}',
      session_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(source_id, target_id, rel_type)
    );

    CREATE TABLE entity_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      snippet TEXT,
      source TEXT,
      project TEXT
    );
  `);
  return db;
}

function insertEntity(db: Database, input: {
  id: string;
  type?: string;
  name: string;
  properties?: Record<string, unknown>;
  activation?: number | null;
}): void {
  db.prepare(`
    INSERT INTO entities (id, type, name, project, properties, created_at, updated_at, activation)
    VALUES (?, ?, ?, NULL, ?, 100, 100, ?)
  `).run(
    input.id,
    input.type ?? "topic",
    input.name,
    JSON.stringify(input.properties ?? {}),
    input.activation ?? null,
  );
}

function insertMention(db: Database, input: {
  entityId: string;
  sessionId: string;
  timestamp: number;
  snippet?: string;
}): void {
  db.prepare(`
    INSERT INTO entity_mentions (entity_id, session_id, timestamp, snippet, source, project)
    VALUES (?, ?, ?, ?, 'test', 'butler')
  `).run(input.entityId, input.sessionId, input.timestamp, input.snippet ?? input.entityId);
}

test("consolidation merges duplicate entities transactionally and preserves provenance", () => {
  const db = createGraphDb();
  const nowMs = Date.UTC(2026, 3, 26, 12, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);
  const oneHourAgoSec = nowSec - 3600;
  const oldSec = nowSec - 20 * 86400;

  insertEntity(db, {
    id: "openai-api",
    name: "OpenAI API",
    properties: { provider: "openai", status: "old-name" },
    activation: 0.1,
  });
  insertEntity(db, {
    id: "openai-api-canonical",
    name: "openai-api",
    properties: { provider: "api", model: "gpt" },
    activation: 0.9,
  });
  insertEntity(db, {
    id: "retrieval",
    name: "Retrieval",
    properties: { kind: "memory" },
    activation: 0.2,
  });

  db.prepare("INSERT INTO edges (source_id, target_id, rel_type, weight, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("openai-api", "retrieval", "supports", 1, nowSec);
  db.prepare("INSERT INTO edges (source_id, target_id, rel_type, weight, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("openai-api-canonical", "retrieval", "supports", 1, nowSec);

  insertMention(db, { entityId: "openai-api", sessionId: "s-recent-1", timestamp: oneHourAgoSec });
  insertMention(db, { entityId: "retrieval", sessionId: "s-recent-1", timestamp: oneHourAgoSec });
  insertMention(db, { entityId: "openai-api", sessionId: "s-recent-2", timestamp: oneHourAgoSec });
  insertMention(db, { entityId: "retrieval", sessionId: "s-recent-2", timestamp: oneHourAgoSec });
  insertMention(db, { entityId: "openai-api-canonical", sessionId: "s-recent-3", timestamp: oneHourAgoSec });
  insertMention(db, { entityId: "retrieval", sessionId: "s-old", timestamp: oldSec });

  const metrics = runConsolidate({
    db,
    nowMs,
    decayD: 0.5,
    edgeBoostWindowMs: 7 * 86400_000,
  });

  expect(metrics.merges_applied).toBe(1);
  expect(metrics.conflicts_archived).toBe(1);
  expect(metrics.activations_written).toBe(2);

  const entities = db.prepare("SELECT id, name, activation FROM entities ORDER BY id").all() as Array<{
    id: string;
    name: string;
    activation: number | null;
  }>;
  expect(entities.map((row) => row.id)).toEqual(["openai-api-canonical", "retrieval"]);

  const mentionRows = db.prepare("SELECT entity_id, session_id FROM entity_mentions ORDER BY session_id, entity_id").all() as Array<{
    entity_id: string;
    session_id: string;
  }>;
  expect(mentionRows.filter((row) => row.entity_id === "openai-api-canonical")).toHaveLength(3);
  expect(mentionRows.some((row) => row.entity_id === "openai-api")).toBe(false);

  const edge = db.prepare("SELECT source_id, target_id, rel_type, weight FROM edges").get() as {
    source_id: string;
    target_id: string;
    rel_type: string;
    weight: number;
  };
  expect(edge).toMatchObject({
    source_id: "openai-api-canonical",
    target_id: "retrieval",
    rel_type: "supports",
  });
  expect(edge.weight).toBeCloseTo(1 + Math.log(3), 5);

  const canonical = entities.find((row) => row.id === "openai-api-canonical")!;
  const retrieval = entities.find((row) => row.id === "retrieval")!;
  expect(canonical.activation ?? -Infinity).toBeGreaterThan(retrieval.activation ?? Infinity);

  const conflict = db.prepare("SELECT entity_id, attribute_key, losing_value FROM entity_conflicts").get() as {
    entity_id: string;
    attribute_key: string;
    losing_value: string;
  };
  expect(conflict).toMatchObject({
    entity_id: "openai-api-canonical",
    attribute_key: "provider",
  });
  expect(conflict.losing_value).toContain("openai");

  db.close();
});

test("consolidation handles millisecond timestamps and seven-day boost boundaries", () => {
  const db = createGraphDb();
  const nowMs = Date.UTC(2026, 3, 26, 12, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);
  const sevenDaysMs = 7 * 86400_000;

  insertEntity(db, { id: "alpha", name: "Alpha", activation: null });
  insertEntity(db, { id: "beta", name: "Beta", activation: null });
  db.prepare("INSERT INTO edges (source_id, target_id, rel_type, weight, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("alpha", "beta", "related", 2, nowSec);

  insertMention(db, { entityId: "alpha", sessionId: "s-ms", timestamp: nowMs - 1000 });
  insertMention(db, { entityId: "beta", sessionId: "s-ms", timestamp: nowMs - 1000 });
  insertMention(db, { entityId: "alpha", sessionId: "s-too-old", timestamp: Math.floor((nowMs - sevenDaysMs - 1000) / 1000) });
  insertMention(db, { entityId: "beta", sessionId: "s-too-old", timestamp: Math.floor((nowMs - sevenDaysMs - 1000) / 1000) });

  const metrics = runConsolidate({
    db,
    nowMs,
    decayD: 0.5,
    edgeBoostWindowMs: sevenDaysMs,
  });

  expect(metrics.merges_applied).toBe(0);
  expect(metrics.edges_boosted).toBe(1);

  const edge = db.prepare("SELECT weight FROM edges WHERE source_id = 'alpha' AND target_id = 'beta'").get() as {
    weight: number;
  };
  expect(edge.weight).toBeCloseTo(2 + Math.log(2), 5);

  const alpha = db.prepare("SELECT activation FROM entities WHERE id = 'alpha'").get() as {
    activation: number | null;
  };
  expect(alpha.activation).not.toBeNull();
  expect(alpha.activation ?? -Infinity).toBeGreaterThan(0);

  db.close();
});

test("optimize compacts hot cache with provenance and prunes only unanchored vector sessions", async () => {
  const db = createGraphDb();
  const hotDir = join(tempDir, "hot");
  mkdirSync(hotDir, { recursive: true });
  const cachePath = join(hotDir, "cache.md");
  writeFileSync(
    cachePath,
    [
      "## [09:00] butler | session-a\nA 오래된 결정입니다.\n",
      "## [09:10] butler | session-b\nB 오래된 결정입니다.\n",
      "## [09:20] butler | session-c\nC 최근 결정입니다.\n",
      "## [09:30] butler | session-d\nD 최근 결정입니다.\n",
    ].join("\n"),
    "utf8",
  );

  insertEntity(db, { id: "stale", name: "Stale", activation: -4 });
  insertEntity(db, { id: "active", name: "Active", activation: 1 });
  insertMention(db, { entityId: "stale", sessionId: "session-prune", timestamp: 1 });
  insertMention(db, { entityId: "stale", sessionId: "session-keep", timestamp: 1 });
  insertMention(db, { entityId: "active", sessionId: "session-keep", timestamp: 1 });

  const deletedPredicates: string[] = [];
  const table: OptimizeTable = {
    async delete(predicate: string) {
      deletedPredicates.push(predicate);
    },
    async optimize() {},
  };

  const metrics = await runOptimize({
    db,
    table,
    hotCacheDir: hotDir,
    hotCacheCompactThresholdBytes: 1,
    activationPruneFloor: -3,
    compactHotCache: (filePath) => compactHotCacheFile(filePath, {
      now: Date.UTC(2026, 3, 26, 12, 0, 0),
    }),
  });

  expect(metrics.caches_compacted).toBe(1);
  expect(metrics.vectors_pruned).toBe(1);
  expect(metrics.lancedb_compacted).toBe(true);
  expect(deletedPredicates).toEqual(["session_id IN ('session-prune')"]);

  const compacted = readFileSync(cachePath, "utf8");
  expect(compacted).toContain("## [compressed] 2026-04-26");
  expect(compacted).toContain("Provenance:");
  expect(compacted).toContain("session-a");
  expect(compacted).toContain("session-c");

  db.close();
});

test("memory health reports maintenance missing, failed, repaired, and stale states", () => {
  const butlerData = tempDir;
  const memoryDir = join(butlerData, "cognition", "memory");
  mkdirSync(join(memoryDir, "hot"), { recursive: true });
  mkdirSync(join(butlerData, "transcripts"), { recursive: true });
  writeFileSync(join(memoryDir, "hot", "cache.md"), "cached\n", "utf8");
  writeFileSync(join(butlerData, "transcripts", "main.jsonl"), "{}\n", "utf8");

  const now = Date.UTC(2026, 3, 26, 12, 0, 0);
  utimesSync(join(memoryDir, "hot", "cache.md"), now / 1000, now / 1000);

  const missing = readMemoryHealth({ butlerData, now });
  expect(missing.maintenanceStatus).toBe("missing");
  expect(missing.diagnostics).toContain("memory maintenance has not run");

  const summaryPath = join(butlerData, "cognition", "consolidation", "run-summary.jsonl");
  mkdirSync(join(butlerData, "cognition", "consolidation"), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify({
    ts: new Date(now - 5000).toISOString(),
    phase: "summary",
    status: "error",
    duration_ms: 10,
    metrics: { failed_phases: ["consolidate"] },
  })}\n`, "utf8");
  const failed = readMemoryHealth({ butlerData, now });
  expect(failed.maintenanceStatus).toBe("failed");
  expect(failed.maintenanceFailedPhases).toEqual(["consolidate"]);

  writeFileSync(summaryPath, [
    JSON.stringify({
      ts: new Date(now - 5000).toISOString(),
      phase: "summary",
      status: "error",
      duration_ms: 10,
      metrics: { failed_phases: ["consolidate"] },
    }),
    JSON.stringify({
      ts: new Date(now - 1000).toISOString(),
      phase: "summary",
      status: "ok",
      duration_ms: 10,
      metrics: { failed_phases: [] },
    }),
    "",
  ].join("\n"), "utf8");
  const repaired = readMemoryHealth({ butlerData, now });
  expect(repaired.maintenanceStatus).toBe("repaired");
  expect(repaired.maintenanceLastRunAt).toBe(new Date(now - 1000).toISOString());

  writeFileSync(summaryPath, `${JSON.stringify({
    ts: new Date(now - 10_000).toISOString(),
    phase: "summary",
    status: "ok",
    duration_ms: 10,
    metrics: { failed_phases: [] },
  })}\n`, "utf8");
  const stale = readMemoryHealth({ butlerData, now, staleAfterMs: 1000 });
  expect(stale.maintenanceStatus).toBe("stale");
  expect(stale.diagnostics).toContain("memory maintenance is stale");
});

test("consolidation cycle runs project capsule maintenance during health phase", async () => {
  const consolidationDir = join(tempDir, "cognition", "consolidation");
  const logsDir = join(consolidationDir, "logs");
  const summaryPath = join(consolidationDir, "run-summary.jsonl");
  const cfg: ConsolidationCycleConfig = {
    enabled: true,
    totalBudgetMs: 60_000,
    subPhaseBudgetsMs: {
      catchup: 15_000,
      consolidate: 15_000,
      optimize: 15_000,
      health: 15_000,
    },
    lockPath: join(consolidationDir, "locks", "consolidation.lock"),
    logsDir,
    summaryPath,
  };
  const calls: string[] = [];

  const result = await runConsolidationCycle(cfg, {
    runCatchup: async () => ({ catchup_ok: true }),
    runConsolidate: async () => ({ consolidate_ok: true }),
    runOptimize: async () => ({ optimize_ok: true }),
    runProjectCapsules: async () => {
      calls.push("project-capsules");
      return {
        project_capsules_considered: 1,
        project_capsules_refreshed: 1,
        project_capsule_failures: 0,
      };
    },
    runHealth: async () => {
      calls.push("health");
      return { integrity_ok: true };
    },
  });

  expect(result).toMatchObject({ exitCode: 0, phasesRun: 4 });
  expect(calls).toEqual(["project-capsules", "health"]);
  const dailyLog = readdirSync(logsDir)
    .filter((name) => name.startsWith("consolidation-cycle-") && name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(logsDir, name), "utf8"))
    .join("\n");
  const healthEvent = dailyLog.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase?: string; metrics?: Record<string, unknown> })
    .find((line) => line.phase === "health");
  expect(healthEvent?.metrics).toMatchObject({
    integrity_ok: true,
    project_capsules_considered: 1,
    project_capsules_refreshed: 1,
    project_capsule_failures: 0,
  });
});
