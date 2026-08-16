import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { readOperationalMetricEvents } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import {
  ingestTaskOutcomeMemory,
  recallMemoryEvidence,
  readMemoryHealth,
  updateExplicitMemory,
} from "../../packages/butler-agent/src/agent/cognition/memory/quality.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-memory-quality-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTask(taskId: string, input: {
  status: string;
  request: string;
  result: string;
}): void {
  const taskDir = join(tempDir, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), `${input.status}\n`, "utf8");
  writeFileSync(join(taskDir, "request.md"), `${input.request}\n`, "utf8");
  writeFileSync(join(taskDir, "result.md"), `${input.result}\n`, "utf8");
  writeFileSync(join(taskDir, "origin.json"), `${JSON.stringify({
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "m-1",
    origin_inbound_event_id: "mock:event:1",
    task_summary: input.request,
    created_at: "2026-04-26T00:00:00.000Z",
    project: tempDir,
    transcript_ref: {
      session_id: "butler/main",
      path: join(tempDir, "transcripts", "butler_main.jsonl"),
      origin_event_id: "mock:event:1",
      origin_message_id: "m-1",
      recent_event_ids: ["mock:event:1"],
    },
    memory_refs: [],
  }, null, 2)}\n`, "utf8");
}

test("memory health reports freshness, backlog, transcripts, and private data location", () => {
  mkdirSync(join(tempDir, "cognition", "memory", "hot"), { recursive: true });
  mkdirSync(join(tempDir, "cognition", "memory", "rules"), { recursive: true });
  mkdirSync(join(tempDir, "cognition", "memory", "projects"), { recursive: true });
  mkdirSync(join(tempDir, "cognition", "memory", "queue"), { recursive: true });
  mkdirSync(join(tempDir, "cognition", "memory", "db"), { recursive: true });
  mkdirSync(join(tempDir, "transcripts"), { recursive: true });
  writeFileSync(join(tempDir, "cognition", "memory", "hot", "cache.md"), "## [00:00] Butler\nremembered chart preference\n", "utf8");
  writeFileSync(join(tempDir, "cognition", "memory", "projects", "butler.md"), "# Project Memory: butler\n", "utf8");
  writeFileSync(join(tempDir, "cognition", "memory", "rules", "rule.md"), "always verify before reporting\n", "utf8");
  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    projects: [{ name: "butler", path: tempDir }, { name: "missing", path: "/tmp/missing" }],
  }), "utf8");
  writeFileSync(join(tempDir, "cognition", "memory", "queue", "sync.jsonl"), "{\"project\":\"butler\"}\n", "utf8");
  writeFileSync(join(tempDir, "cognition", "memory", "queue", "dead-letter.jsonl"), "{\"error\":\"boom\"}\n", "utf8");
  writeFileSync(join(tempDir, "cognition", "memory", "projects", ".refresh-failures.jsonl"), `${JSON.stringify({
    ts: "2026-04-27T00:00:00.000Z",
    projectId: "butler",
    phase: "refresh",
    message: "refresh failed",
  })}\n`, "utf8");
  writeFileSync(join(tempDir, "cognition", "memory", "db", "vector-stats.json"), JSON.stringify({
    row_count: 7,
    updated_at: new Date(Date.now()).toISOString(),
  }), "utf8");
  writeFileSync(join(tempDir, "transcripts", "butler_main.jsonl"), "{}\n", "utf8");
  const graph = new Database(join(tempDir, "cognition", "memory", "db", "graph.sqlite"));
  graph.exec(`
    CREATE TABLE entities (id TEXT);
    CREATE TABLE edges (id TEXT);
    CREATE TABLE entity_mentions (id TEXT);
    INSERT INTO entities VALUES ('entity-1');
    INSERT INTO edges VALUES ('edge-1');
    INSERT INTO entity_mentions VALUES ('mention-1');
  `);
  graph.close();

  const health = readMemoryHealth({
    butlerData: tempDir,
    now: Date.now(),
  });

  expect(health).toMatchObject({
    hotCacheFiles: 1,
    ruleFiles: 1,
    queueBacklog: 1,
    deadLetterCount: 1,
    transcriptFiles: 1,
    projectCapsules: 1,
    missingProjectCapsules: 1,
    projectRefreshFailureCount: 1,
    latestProjectRefreshFailureAt: "2026-04-27T00:00:00.000Z",
    vectorRowCount: 7,
    graphEntityCount: 1,
    graphEdgeCount: 1,
    graphMentionCount: 1,
    stale: false,
  });
  expect(health.diagnostics).toContain("1 memory sync request(s) are queued");
  expect(health.diagnostics).toContain("1 memory sync request(s) are in dead-letter");
  expect(health.diagnostics).toContain("1 registered project capsule(s) are missing");
  expect(health.diagnostics).toContain("1 project capsule refresh failure(s) recorded");

  const memoryHealthMetric = readOperationalMetricEvents({ butlerData: tempDir })
    .find((event) => event.category === "memory" && event.name === "health");
  expect(memoryHealthMetric?.dimensions).toMatchObject({
    vector_rows_count: 7,
    graph_entities_count: 1,
    graph_edges_count: 1,
    graph_mentions_count: 1,
    queue_backlog_count: 1,
    dead_letter_count: 1,
  });
  expect(JSON.stringify(memoryHealthMetric)).not.toContain("remembered chart preference");
});

test("completed task reports ingest into task memory with provenance and are retrievable", () => {
  writeTask("task-chart-1", {
    status: "DONE",
    request: "make a chart for install conversion",
    result: "Created the install conversion chart and verified it.",
  });

  const ingested = ingestTaskOutcomeMemory({
    butlerData: tempDir,
    taskId: "task-chart-1",
  });
  const queried = recallMemoryEvidence({
    butlerData: tempDir,
    cue: "install conversion chart",
  });

  expect(ingested).toMatchObject({
    ok: true,
    task_id: "task-chart-1",
    provenance: {
      source: "task-result",
      origin_session_id: "butler/main",
      origin_event_id: "mock:event:1",
    },
  });
  expect(ingested.memory_path.startsWith(join(tempDir, "cognition", "memory", "tasks"))).toBe(true);
  expect(queried.results[0]).toMatchObject({
    source: "task-memory",
    path: ingested.memory_path,
  });
  expect(queried.results[0]?.text).toContain("install conversion chart");
});

test("explicit rule updates are written with provenance and recallable", () => {
  const rule = updateExplicitMemory({
    butlerData: tempDir,
    update: {
      kind: "rule",
      text: "Always cite sources for web-backed claims.",
      source: "app:message:43",
    },
  });

  expect(rule.path.startsWith(join(tempDir, "cognition", "memory", "rules"))).toBe(true);
  expect(recallMemoryEvidence({
    butlerData: tempDir,
    cue: "cite sources",
  }).results[0]).toMatchObject({
    source: "rules",
  });
});

test("recall evidence preserves meaningful line boundaries for model-readable memory", () => {
  const hotDir = join(tempDir, "cognition", "memory", "hot");
  mkdirSync(hotDir, { recursive: true });
  writeFileSync(join(hotDir, "live-recall-e2e.md"), [
    "# Live Recall E2E Memory",
    "Answer line 1: recall_memory: current associative recall tool.",
    "Answer line 2: query_memory: exact durable memory lookup tool.",
    "Quality key: TEST_RECALL_KEY",
    "",
  ].join("\n"), "utf8");

  const recalled = recallMemoryEvidence({
    butlerData: tempDir,
    cue: "Answer line recall_memory query_memory Quality key",
  });

  expect(recalled.results[0]?.text).toContain([
    "Answer line 1: recall_memory: current associative recall tool.",
    "Answer line 2: query_memory: exact durable memory lookup tool.",
    "Quality key: TEST_RECALL_KEY",
  ].join("\n"));
});

test("memory ingestion rejects missing or resultless tasks", () => {
  expect(() => ingestTaskOutcomeMemory({
    butlerData: tempDir,
    taskId: "missing",
  })).toThrow("task not found");

  const taskDir = join(tempDir, "tasks", "task-empty");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  expect(() => ingestTaskOutcomeMemory({
    butlerData: tempDir,
    taskId: "task-empty",
  })).toThrow("no reportable result");
});
