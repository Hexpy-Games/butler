import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

import { readMemoryHealth } from "../../packages/butler-agent/src/agent/cognition/memory/quality.ts";
import { compactHotCacheFile } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/hot-cache-compaction.ts";
import { runConsolidate } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/consolidate.ts";
import { runOptimize, runRevisionAwareOptimize, type OptimizeTable } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/optimize.ts";
import { runConsolidationCycle, type ConsolidationCycleConfig } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts";
import { ensureV2MemorySchema } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { acquireConsolidationLock, consolidationLockPath, releaseConsolidationLock } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/lock.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { captureProfileCandidatesFromTranscriptsWithModel, writeProfilingConsentSnapshot } from "../../packages/butler-agent/src/personalization/profiling.ts";

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

test("v2 consolidation recomputes absolute current episode support without merging nodes", () => {
  const db = new Database(":memory:");
  ensureV2MemorySchema(db);
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,origin_kind,status,source_hash,created_at,updated_at) VALUES('ep','k','r2','s','user_input','active','h','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')").run();
  for (const [source, revision, part] of [["current-1", "r2", "p1"], ["current-2", "r2", "p2"], ["stale", "r1", "p3"]] as const) {
    db.query("INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,'ep',?,'conversation','s','m',?,'/text',0,1,'h','user','user_input','2026-09-01T00:00:00Z','user_statement')")
      .run(source, revision, part);
  }
  for (const id of ["left", "right"]) db.query("INSERT INTO entities(id,type,label_original,identity_scope,created_at) VALUES(?,'entity',?,'user','2026-09-01T00:00:00Z')").run(id, id);
  db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,qualifiers) VALUES('edge','left','right','related','{\"legacy\":true,\"active_support_episodes\":99}')").run();
  for (const source of ["current-1", "current-2", "stale"]) db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('edge',?,'user_statement','memory-extract-v2')").run(source);

  const input = { db, nowMs: Date.parse("2026-09-08T00:00:00Z"), decayD: 0.5, edgeBoostWindowMs: 7 * 86_400_000 };
  const first = runConsolidate(input);
  const once = db.query<{ qualifiers: string }, []>("SELECT qualifiers FROM edges WHERE edge_id='edge'").get()!.qualifiers;
  const second = runConsolidate(input);
  expect(first).toMatchObject({ candidates_considered: 1, merges_applied: 0, edges_boosted: 1 });
  expect(second).toMatchObject({ candidates_considered: 1, merges_applied: 0, edges_boosted: 0 });
  expect(JSON.parse(once)).toMatchObject({ legacy: true, active_support_episodes: 1 });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM entities").get()!.n).toBe(2);
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

test("v2 optimize retains old vectors until replacement completes and protects reused live keys", async () => {
  const descriptor = initializeEmptyMemoryGeneration(tempDir);
  const context = {
    butlerData: tempDir,
    target: { kind: "active" as const, expected_generation: descriptor.generation_id },
    signal: new AbortController().signal,
  };
  const db = new Database(join(tempDir, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
  ensureV2MemorySchema(db);
  const now = new Date().toISOString();
  db.query("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("episode", "source", "rev-current", "conversation", "active", "hash", now, now);
  const stage = JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 });
  const pending = JSON.stringify({ state: "pending", blocked_by: null });
  const insertJob = db.query("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertJob.run("old-job", "episode", "rev-old", "v", "g", "m", "low", "[]", stage, stage, stage, stage, stage, now);
  insertJob.run("current-job", "episode", "rev-current", "v", "g", "m", "low", "[]", stage, stage, pending, pending, pending, now);
  const insertUnit = db.query("INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,origin_kind,projection_text,state,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)");
  insertUnit.run("old-unit", "old-job", "episode", "episode", "rev-old", "conversation", "old", "complete", JSON.stringify({ vector_keys: ["old-key", "obsolete-key"] }));
  insertUnit.run("current-unit", "current-job", "episode", "episode", "rev-current", "conversation", "current", "pending", JSON.stringify({ vector_keys: ["current-key"] }));
  const deleted: string[] = [];
  const result = await runRevisionAwareOptimize({ db, table: { delete: async (predicate) => { deleted.push(predicate); } }, context });
  expect(result.vectors_pruned).toBe(0);
  expect(deleted).toEqual([]);

  db.query("UPDATE memory_projection_jobs SET episode_vectors_state=?,node_vectors_state=? WHERE job_id='current-job'").run(stage, stage);
  db.query("UPDATE memory_vector_units SET state='complete',receipt_json=? WHERE unit_id='current-unit'")
    .run(JSON.stringify({ vector_keys: ["old-key", "current-key"] }));
  const gatePath = consolidationLockPath(tempDir);
  const holder = acquireConsolidationLock(gatePath, { purpose: "test_optimize_holder" });
  expect(holder).not.toBeNull();
  const raced = runRevisionAwareOptimize({ db, table: { delete: async (predicate) => { deleted.push(predicate); } }, context });
  db.query("UPDATE memory_projection_jobs SET episode_vectors_state=?,node_vectors_state=? WHERE job_id='current-job'").run(pending, pending);
  releaseConsolidationLock(gatePath, holder!);
  expect((await raced).vectors_pruned).toBe(0);
  expect(deleted).toEqual([]);

  db.query("UPDATE memory_projection_jobs SET episode_vectors_state=?,node_vectors_state=? WHERE job_id='current-job'").run(stage, stage);
  const completed = await runRevisionAwareOptimize({ db, table: { delete: async (predicate) => { deleted.push(predicate); } }, context });
  expect(completed.vectors_pruned).toBe(1);
  expect(deleted).toEqual(["vector_key IN ('obsolete-key')"]);
  db.close();
});

test("serving health does not infer current profile discovery from a zero scan cursor", async () => {
  initializeEmptyMemoryGeneration(tempDir);
  const health = readMemoryHealth({ butlerData: tempDir });
  expect(health.serving).toMatchObject({ available: true, sources: {
    eligible: null, known_eligible: 0, registered: 0, registered_current: 0,
    inventory_complete: false, inventory_reason: "typed_inventory_unavailable",
    coverage_percent: null, known_coverage_percent: null, coverage_reason: "inventory_incomplete",
  } });
  expect(health.serving.cache).toMatchObject({ available: true, current_entries: 0 });
  expect(health.serving.profile).toMatchObject({ available: false, reason: "profile_store_unavailable" });

  writeProfilingConsentSnapshot(tempDir, { mode: "deep", consented_at: "2026-09-10T00:00:00.000Z" });
  const store = new AgentConversationStore({ butlerData: tempDir });
  try {
    const turn = store.beginTurn({ gateway: "app", externalSessionId: "health-profile", sessionId: "cs_health_profile", actor: "user", turnId: "ct_health_profile_1" });
    store.appendUserMessage({ sessionId: "cs_health_profile", turnId: turn.id, messageId: "cm_health_profile_1",
      text: "Remember that current discovery must follow canonical ingress.", originKind: "user_input" });
  } finally { store.close(); }
  const captured = await captureProfileCandidatesFromTranscriptsWithModel(tempDir, {
    modelRunner: async () => JSON.stringify({ candidates: [] }), maxUserMessages: 10, maxModelBatches: 10,
  });
  expect(captured.model_error).toBeUndefined();
  expect(readMemoryHealth({ butlerData: tempDir }).serving.profile).toMatchObject({
    available: true, discovery_incomplete: null, discovery_reason: "discovery_not_observed",
  });

  const later = new AgentConversationStore({ butlerData: tempDir });
  try {
    const turn = later.beginTurn({ gateway: "app", externalSessionId: "health-profile", sessionId: "cs_health_profile", actor: "user", turnId: "ct_health_profile_2" });
    later.appendUserMessage({ sessionId: "cs_health_profile", turnId: turn.id, messageId: "cm_health_profile_2",
      text: "This later canonical ingress has not been discovered yet.", originKind: "user_input" });
  } finally { later.close(); }
  expect(readMemoryHealth({ butlerData: tempDir }).serving.profile).toMatchObject({
    available: true, discovery_incomplete: null, discovery_reason: "discovery_not_observed",
  });
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
    assertWriteAuthority: () => {},
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

test("consolidation cycle rechecks write authority after catchup before maintenance mutation", async () => {
  const consolidationDir = join(tempDir, "cognition", "consolidation-generation-switch");
  const cfg: ConsolidationCycleConfig = {
    enabled: true,
    totalBudgetMs: 60_000,
    subPhaseBudgetsMs: { catchup: 15_000, consolidate: 15_000, optimize: 15_000, health: 15_000 },
    lockPath: join(consolidationDir, "locks", "consolidation.lock"),
    logsDir: join(consolidationDir, "logs"),
    summaryPath: join(consolidationDir, "run-summary.jsonl"),
  };
  let current = true;
  let mutations = 0;
  const result = await runConsolidationCycle(cfg, {
    runCatchup: async () => { current = false; return { ingested: 1 }; },
    assertWriteAuthority: () => { if (!current) throw new Error("memory_generation_changed"); },
    runConsolidate: async () => { mutations += 1; return {}; },
    runOptimize: async () => { mutations += 1; return {}; },
    runHealth: async () => { mutations += 1; return {}; },
  });
  expect(result).toMatchObject({ exitCode: 0, phasesRun: 1 });
  expect(mutations).toBe(0);
});

test("active-generation maintenance entry recomputes absolute v2 support without graph inflation", () => {
  const descriptor = initializeEmptyMemoryGeneration(tempDir);
  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({ cognition: { consolidationCycle: {
    enabled: true, totalBudgetMs: 60_000,
    subPhaseBudgetsMs: { catchup: 15_000, consolidate: 15_000, optimize: 15_000, health: 15_000 },
  } } }));
  const graphPath = join(tempDir, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite");
  const db = new Database(graphPath);
  const observedAt = new Date(Date.now() - 86_400_000).toISOString();
  db.query(`INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,project_id,origin_kind,status,source_hash,created_at,updated_at)
    VALUES('episode','fixture','revision','session',NULL,'user_input','active','hash',?,?)`).run(observedAt, observedAt);
  db.query(`INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
    VALUES('source','episode','revision','conversation_message','session','message','part','/text',0,4,'hash','user','user_input',?,'user_statement')`).run(observedAt);
  for (const [id, label] of [["left", "Left"], ["right", "Right"], ["claim", "Claim"]] as const)
    db.query("INSERT INTO entities(id,type,label_original,properties,identity_scope,project_id,created_at) VALUES(?,? ,?,'{}','user',NULL,?)")
      .run(id, id === "claim" ? "memory_atom" : "entity", label, observedAt);
  db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES('left','source','episode','revision'),('right','source','episode','revision'),('claim','source','episode','revision')").run();
  db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id,qualifiers) VALUES('edge','left','right','related_to','claim','{}')").run();
  db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('edge','source','user_statement','memory-extract-v2')").run();
  db.close();
  const run = () => spawnSync("bun", ["packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts"], {
    cwd: join(import.meta.dir, "../.."), env: { ...process.env, BUTLER_DATA: tempDir, EMBED_SOCKET: join(tempDir, "no-embed.sock") }, encoding: "utf8",
  });
  const first = run();
  expect({ status: first.status, signal: first.signal }).toEqual({ status: 0, signal: null });
  let check = new Database(graphPath, { readonly: true });
  const firstQualifiers = JSON.parse(check.query<{ qualifiers: string }, []>("SELECT qualifiers FROM edges WHERE edge_id='edge'").get()!.qualifiers);
  const firstCounts = check.query<{ edges: number; mentions: number }, []>("SELECT (SELECT COUNT(*) FROM edges) edges,(SELECT COUNT(*) FROM entity_mentions) mentions").get()!;
  check.close();
  const second = run();
  expect({ status: second.status, signal: second.signal }).toEqual({ status: 0, signal: null });
  check = new Database(graphPath, { readonly: true });
  const secondQualifiers = JSON.parse(check.query<{ qualifiers: string }, []>("SELECT qualifiers FROM edges WHERE edge_id='edge'").get()!.qualifiers);
  expect(check.query<{ edges: number; mentions: number }, []>("SELECT (SELECT COUNT(*) FROM edges) edges,(SELECT COUNT(*) FROM entity_mentions) mentions").get()).toEqual(firstCounts);
  check.close();
  expect(firstQualifiers.active_support_episodes).toBe(1);
  expect(secondQualifiers.active_support_episodes).toBe(1);
  expect(Math.abs(Number(secondQualifiers.decayed_support) - Number(firstQualifiers.decayed_support))).toBeLessThan(0.001);
});
