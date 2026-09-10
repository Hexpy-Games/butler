import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { readOperationalMetricEvents } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import {
  ingestTaskOutcomeMemory,
  forgetExplicitMemory,
  readTypedMemoryRecord,
  recallMemoryEvidence,
  readMemoryHealth,
  updateExplicitMemory,
} from "../../packages/butler-agent/src/agent/cognition/memory/quality.ts";
import { PlannedTaskStore } from "../../packages/butler-agent/src/agent/work/planned-task.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory, resolveMemorySource } from "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts";
import { createMemoryToolHandlers } from "../../packages/butler-agent/src/agent/tools/memory/index.ts";
import { createRecallMemoryToolHandler } from "../../packages/butler-agent/src/agent/tools/memory/recall_memory/executor.ts";
import { createReadConversationSessionToolHandler } from "../../packages/butler-agent/src/agent/tools/memory/read_conversation_session/executor.ts";
import { advanceNextMemoryProjection } from "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts";
import { processEntry } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { createServer } from "node:net";
import { readGenerationHotCache } from "../../packages/butler-agent/src/agent/cognition/continuity/hot-cache-writer.ts";
import { ensureV2MemorySchema } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { runRevisionAwareOptimize } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/phases/optimize.ts";
import {
  addFeedbackEntry,
  applyFeedbackQualityOperation,
  clearResolvedFeedbackEntries,
  feedbackOwnerRevision,
  listFeedbackQualityOperations,
  recordFeedbackQualityExclusion,
  resolveFeedbackEntry,
} from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";

mock.module("../../packages/butler-agent/src/integrations/providers/runtime.ts", () => ({
  runPromptTextWithUsage: async (request: { prompt: string; model: string }) => {
    const input = JSON.parse(request.prompt) as {
      window_ref: string;
      source_units: Array<{ ref: string; text: string; role: string }>;
    };
    const source = input.source_units[0]!;
    const evidence = [{ unit_ref: source.ref, quote: source.text, occurrence: 0 }];
    const basis = source.role === "task" ? "reviewed_task" : "user_statement";
    return {
      text: JSON.stringify({
        schema: "butler.memory-extract-output.v2",
        window_ref: input.window_ref,
        disposition: "processed",
        covered_unit_refs: input.source_units.map((unit) => unit.ref),
        nodes: [{
          local_ref: "typed-source",
          type: "entity",
          label: "出典",
          resolution: { kind: "create", provisional: false, identity_scope: "user" },
          aliases: [{ text: "出典", evidence }],
          evidence,
        }],
        claims: [{
          local_ref: "typed-constraint",
          type: "constraint",
          resolution: { kind: "create", provisional: false, identity_scope: "user" },
          statement: source.text,
          subject_ref: "typed-source",
          object_ref: "typed-source",
          speech_act: "assertion",
          basis,
          polarity: "positive",
          condition: null,
          valid_from: null,
          valid_to: null,
          salience: "high",
          evidence,
        }], relations: [], corrections: [],
        summary: { text: source.text, evidence },
      }),
      model: request.model,
      usage: { promptTokens: 1, cachedTokens: 0, outputTokens: 1, totalTokens: 2 },
    };
  },
}));

function createCheckedEmbeddingStub() {
  return createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts: string[] };
      socket.end(`${JSON.stringify({
        embeddings: request.texts.map(() => [1, 0]), token_counts: request.texts.map(() => 2),
        embedded_texts: request.texts, omitted_count: 0,
        metadata: {
          model: "test/bge-m3", dimension: 2, pooling: "cls", normalize: true,
          version: "a".repeat(64), max_tokens: 8192, transformers_version: "test",
          node_runtime_version: process.version, bun_runtime_version: Bun.version,
          tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64),
        },
      })}\n`);
    });
  });
}

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-memory-quality-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

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

test("completed task reports ingest into task memory with provenance and are retrievable", async () => {
  const descriptor = initializeEmptyMemoryGeneration(tempDir);
  const store = new PlannedTaskStore(tempDir);
  store.create({
    task_id: "task-chart-1", type: "planned",
    goal: "make a chart for install conversion", project: tempDir,
    created_at: "2026-04-26T00:00:00.000Z", origin_session_id: "butler/main",
    origin_event_id: "mock:event:1", decision_policy: "autonomous",
    acceptance_criteria: ["chart verified"], verification_commands: ["bun test"],
    review_policy: "review every criterion",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "report after review",
  });
  store.transition("task-chart-1", "PLANNED_RUNNING");
  store.writeAttemptResult("task-chart-1", 1, "Created the install conversion chart and verified it.");
  store.transition("task-chart-1", "WORKER_DONE");
  store.transition("task-chart-1", "REVIEWING");
  store.writeReview({
    task_id: "task-chart-1", attempt: 1, verdict: "PASS",
    reviewed_at: "2026-04-26T00:10:00.000Z",
    goal_review: { goal: "make a chart for install conversion", verdict: "PASS", evidence: "chart verified" },
    criteria: [{ criterion: "chart verified", verdict: "PASS", evidence: "test passed" }],
    missing_evidence: [], repair_recommendation: null,
  });
  store.transition("task-chart-1", "REVIEW_PASSED");
  store.transition("task-chart-1", "PUBLIC_REPORT_READY");
  store.writePublicReport("task-chart-1", "Created the install conversion chart and verified it.");

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
  expect(ingested).toHaveProperty("task_id", "task-chart-1");
  expect(ingested.memory_path.startsWith(join(tempDir, "cognition", "memory", "tasks"))).toBe(true);
  expect(queried.results[0]).toMatchObject({
    source: "task-memory",
    path: ingested.memory_path,
  });
  expect(queried.results[0]?.text).toContain("install conversion chart");
  const queued = readFileSync(join(tempDir, "cognition", "memory", "queue", "sync.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { source: Parameters<typeof ingestConversationMemory>[0]["source"] });
  const taskNotice = queued.find((entry) => entry.source.kind === "task_report");
  expect(taskNotice).toBeTruthy();
  const progress = await ingestConversationMemory({
    context: {
      butlerData: tempDir,
      target: { kind: "active", expected_generation: descriptor.generation_id },
      signal: new AbortController().signal,
    },
    source: taskNotice!.source,
  });
  expect(progress.source.state).toBe("complete");
  await advanceNextMemoryProjection({
    context: {
      butlerData: tempDir,
      target: { kind: "active", expected_generation: descriptor.generation_id },
      signal: new AbortController().signal,
    },
  });
  const taskDb = new Database(join(
    tempDir,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  ), { readonly: true });
  const taskSource = taskDb.query<{ source_id: string }, []>(
    "SELECT source_id FROM memory_chunk_sources WHERE source_kind='task_report'",
  ).get();
  expect(taskDb.query<{ basis: string }, []>(
    "SELECT json_extract(properties,'$.basis') basis FROM entities WHERE type='constraint'",
  ).get()?.basis).toBe("reviewed_task");
  taskDb.close();
  expect(resolveMemorySource({
    context: {
      butlerData: tempDir,
      target: { kind: "active", expected_generation: descriptor.generation_id },
      signal: new AbortController().signal,
    },
    sourceRef: taskSource!.source_id,
  }).text).toBe("Created the install conversion chart and verified it.\n");
  store.writeAttemptResult("task-chart-1", 2, "Created a corrected install conversion chart.");
  store.writeReview({
    task_id: "task-chart-1", attempt: 2, verdict: "PASS",
    reviewed_at: "2026-04-26T00:20:00.000Z",
    goal_review: { goal: "make a chart for install conversion", verdict: "PASS", evidence: "corrected chart verified" },
    criteria: [{ criterion: "chart verified", verdict: "PASS", evidence: "corrected test passed" }],
    missing_evidence: [], repair_recommendation: null,
  });
  store.writePublicReport("task-chart-1", "Created a corrected install conversion chart.");
  ingestTaskOutcomeMemory({ butlerData: tempDir, taskId: "task-chart-1" });
  expect(await processEntry(taskNotice as any, { butlerData: tempDir })).toMatchObject({
    dequeue: true,
    generationId: descriptor.generation_id,
  });
  writeFileSync(
    join(tempDir, "tasks", "task-chart-1", "public-report.md"),
    "Rewritten without a matching review binding.\n",
    "utf8",
  );
  expect(() => resolveMemorySource({
    context: {
      butlerData: tempDir,
      target: { kind: "active", expected_generation: descriptor.generation_id },
      signal: new AbortController().signal,
    },
    sourceRef: taskSource!.source_id,
  })).toThrow("memory_source_changed");
});

test("explicit rule updates are written with provenance and recallable", async () => {
  initializeEmptyMemoryGeneration(tempDir);
  const legacyRulesDir = join(tempDir, "cognition", "memory", "rules");
  mkdirSync(legacyRulesDir, { recursive: true });
  writeFileSync(join(legacyRulesDir, "legacy-rule.md"), "Keep this legacy rule private.\n", "utf8");
  writeFileSync(
    join(legacyRulesDir, "INDEX.md"),
    "- [Keep this legacy rule private.](legacy-rule.md)\n",
    "utf8",
  );
  const legacyForgotten = forgetExplicitMemory({
    butlerData: tempDir,
    recordId: "legacy-rule",
    operationId: "effect-legacy-rule-forget",
  });
  expect(legacyForgotten).toMatchObject({ record_id: "legacy-rule", replayed: false });
  expect(readTypedMemoryRecord(tempDir, "explicit_record", "legacy-rule")).toBeNull();
  expect(readFileSync(join(legacyRulesDir, "INDEX.md"), "utf8")).not.toContain("legacy-rule.md");
  expect(() => readFileSync(join(legacyRulesDir, "legacy-rule.md"), "utf8")).toThrow();
  expect(() => readFileSync(join(tempDir, "cognition", "memory", "queue", "sync.jsonl"), "utf8"))
    .toThrow();
  const handler = createMemoryToolHandlers({
    butlerHome: tempDir, butlerData: tempDir, projectId: tempDir,
  }).update_explicit_memory;
  const call = {
    name: "update_explicit_memory",
    args: { kind: "rule", text: "Always cite sources for web-backed claims.", source: "app:message:43" },
    rawArguments: "{}",
  };
  const rule = await handler(call, { effectOccurrenceId: "effect-rule-ja-1" }) as ReturnType<typeof updateExplicitMemory>;
  const replay = await handler(call, { effectOccurrenceId: "effect-rule-ja-1" }) as ReturnType<typeof updateExplicitMemory>;

  expect(rule).not.toHaveProperty("path");
  expect(replay).toMatchObject({ record_id: rule.record_id, revision: rule.revision, replayed: true });
  expect(recallMemoryEvidence({
    butlerData: tempDir,
    cue: "cite sources",
  }).results[0]).toMatchObject({
    source: "rules",
  });
  const modified = updateExplicitMemory({
    butlerData: tempDir,
    recordId: rule.record_id,
    operationId: "effect-rule-modify-2",
    update: { kind: "rule", text: "  Always cite current sources.  ", source: "continuity" },
  });
  expect(readTypedMemoryRecord(
    tempDir,
    "explicit_record",
    modified.record_id,
  )?.text).toBe("  Always cite current sources.  ");
  const historicalReplay = updateExplicitMemory({
    butlerData: tempDir,
    recordId: rule.record_id,
    operationId: "effect-rule-ja-1",
    projectId: tempDir,
    update: {
      kind: "rule",
      text: call.args.text,
      source: call.args.source,
    },
  });
  expect(historicalReplay).toMatchObject({ replayed: true, revision: rule.revision });
  expect(readTypedMemoryRecord(tempDir, "explicit_record", rule.record_id)?.text)
    .toBe("  Always cite current sources.  ");
  forgetExplicitMemory({
    butlerData: tempDir,
    recordId: rule.record_id,
    operationId: "effect-rule-forget-3",
  });
  expect(readTypedMemoryRecord(tempDir, "explicit_record", rule.record_id)).toBeNull();
});

test("typed explicit owner registers through the normal projection and raw source reader", async () => {
  const descriptor = initializeEmptyMemoryGeneration(tempDir);
  const authored = new AgentConversationStore({ butlerData: tempDir });
  let authoredMessageId!: string;
  try {
    authored.beginTurn({
      gateway: "app",
      externalSessionId: "runtime-authored-session",
      sessionId: "canonical-authored-session",
      projectId: tempDir,
      actor: "user",
      turnId: "authored-turn",
      requestId: "app-request-authored",
    });
    const message = authored.appendUserMessage({
      sessionId: "canonical-authored-session",
      turnId: "authored-turn",
      text: "次の二つの規則を記憶してください。",
      originKind: "user_input",
      originRef: "test",
      sourceGateway: "app",
      sourceRef: "app-request-authored",
    });
    authoredMessageId = message.id;
  } finally {
    authored.close();
  }
  const rule = await createMemoryToolHandlers({
    butlerHome: tempDir,
    butlerData: tempDir,
    projectId: tempDir,
    sessionId: "runtime-authored-session",
    turnId: "authored-turn",
  }).update_explicit_memory({
    name: "update_explicit_memory",
    args: {
      kind: "rule",
      text: "出典を確認する。",
      source: "native",
    },
    rawArguments: "{}",
  }, { effectOccurrenceId: "effect-multilingual-1" }) as ReturnType<typeof updateExplicitMemory>;
  const secondRule = await createMemoryToolHandlers({
    butlerHome: tempDir,
    butlerData: tempDir,
    projectId: tempDir,
    sessionId: "runtime-authored-session",
    turnId: "authored-turn",
  }).update_explicit_memory({
    name: "update_explicit_memory",
    args: { kind: "rule", text: "تحقق من المصدر قبل الإجابة.", source: "native" },
    rawArguments: "{}",
  }, { effectOccurrenceId: "effect-multilingual-2" }) as ReturnType<typeof updateExplicitMemory>;
  const finalized = new AgentConversationStore({ butlerData: tempDir });
  try {
    finalized.finalizeTurn({
      turnId: "authored-turn", status: "complete",
      outcomeCapsule: {
        sessionId: "canonical-authored-session", turnId: "authored-turn",
        generation: 1, outcome: "delivered", requestMessageId: authoredMessageId,
      },
    });
  } finally { finalized.close(); }
  const context = {
    butlerData: tempDir,
    target: { kind: "active" as const, expected_generation: descriptor.generation_id },
    signal: new AbortController().signal,
  };
  const queuedNotices = readFileSync(join(tempDir, "cognition", "memory", "queue", "sync.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  for (const written of [rule, secondRule]) {
    const notice = queuedNotices.find((entry) =>
      entry.source?.operation_id === written.operation_id,
    );
    expect(await processEntry(notice, { butlerData: tempDir })).toMatchObject({ dequeue: true });
  }
  await advanceNextMemoryProjection({ context });
  const db = new Database(join(tempDir, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
  const source = db.query<{
    source_id: string;
    conversation_message_id: string | null;
  }, [string]>(
    "SELECT source_id,conversation_message_id FROM memory_chunk_sources WHERE source_kind='explicit_record' AND part_id=?",
  ).get(rule.record_id);
  const constraint = db.query<{ basis: string }, []>(
    "SELECT json_extract(properties,'$.basis') basis FROM entities WHERE type='constraint'",
  ).get();
  db.close();
  expect(source).toBeTruthy();
  expect(source?.conversation_message_id).toBe(authoredMessageId);
  expect(constraint?.basis).toBe("user_statement");
  expect(resolveMemorySource({ context, sourceRef: source!.source_id })).toMatchObject({
    source_kind: "explicit_record",
    conversation_session_id: "canonical-authored-session",
    conversation_message_id: authoredMessageId,
    text: "出典を確認する。",
  });
  const canonical = new AgentConversationStore({ butlerData: tempDir });
  try {
    canonical.beginTurn({
      gateway: "app", externalSessionId: "query-session", sessionId: "query-session",
      actor: "user", turnId: "query-turn",
    });
  } finally { canonical.close(); }
  const toolInput = {
    butlerHome: tempDir, butlerData: tempDir, sessionId: "query-session",
    turnId: "query-turn", currentUserMessage: "出典",
  };
  const recalled = await createRecallMemoryToolHandler(toolInput)({
    name: "recall_memory",
    args: { cue: "出典", include_vector: false, scope: "all_user_sessions" },
    rawArguments: "{}", toolContractVersion: 2,
  }, { effectOccurrenceId: "typed-recall-1" }) as any;
  const evidence = recalled.results[0].evidence[0];
  expect(evidence).toMatchObject({
    source_kind: "explicit_record",
    conversation_session_id: "canonical-authored-session",
    conversation_message_id: authoredMessageId,
  });
  const read = await createReadConversationSessionToolHandler(toolInput)({
    name: "read_conversation_session",
    args: structuredClone(evidence.read_args),
    rawArguments: JSON.stringify(evidence.read_args),
    toolContractVersion: 2,
  } as any) as any;
  expect(read).toMatchObject({
    ok: true,
    mode: "source",
    source_kind: "explicit_record",
    conversation_session_id: "canonical-authored-session",
    conversation_message_id: authoredMessageId,
    text: "出典を確認する。",
  });
  const embeddingServer = createCheckedEmbeddingStub();
  await new Promise<void>((resolve, reject) => {
    embeddingServer.once("error", reject);
    embeddingServer.listen(process.env.EMBED_SOCKET!, resolve);
  });
  let hotState = "";
  const projectionProgress: Array<{
    job_id: string;
    semantic_graph: string;
    episode_vectors: string;
    node_vectors: string;
    hot_cache: string;
  }> = [];
  let afterTwelve: Array<{
    unit_id: string;
    state: string;
    attempt_count: number;
    next_attempt_at: string | null;
  }> = [];
  let observedNoRunnableWork = false;
  try {
    // Drain production advances until no work is runnable; 64 is only a fixture safety cap.
    for (let quantum = 0; quantum < 64; quantum += 1) {
      const next = await advanceNextMemoryProjection({ context });
      if (!next) {
        observedNoRunnableWork = true;
        break;
      }
      hotState = next.hot_cache.state ?? hotState;
      projectionProgress.push({
        job_id: next.job_id,
        semantic_graph: next.semantic_graph.state,
        episode_vectors: next.episode_vectors.state,
        node_vectors: next.node_vectors.state,
        hot_cache: next.hot_cache.state,
      });
      if (quantum === 11) {
        const diagnosticDb = new Database(join(
          tempDir, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite",
        ), { readonly: true });
        afterTwelve = diagnosticDb.query<{
          unit_id: string;
          state: string;
          attempt_count: number;
          next_attempt_at: string | null;
        }, []>(
          "SELECT unit_id,state,attempt_count,next_attempt_at FROM memory_vector_units WHERE state!='complete' ORDER BY unit_id",
        ).all();
        diagnosticDb.close();
      }
    }
  } finally {
    await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
  }
  expect(hotState).toBe("complete");
  const vectorDb = new Database(join(
    tempDir,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  ), { readonly: true });
  const vectorStates = vectorDb.query<{ state: string; count: number }, []>(
    "SELECT state,COUNT(*) count FROM memory_vector_units GROUP BY state",
  ).all();
  const incompleteVectorUnits = vectorDb.query<{
    unit_id: string;
    job_id: string;
    record_kind: string;
    state: string;
    attempt_count: number;
    next_attempt_at: string | null;
  }, []>(
    "SELECT unit_id,job_id,record_kind,state,attempt_count,next_attempt_at FROM memory_vector_units WHERE state!='complete' ORDER BY job_id,unit_id",
  ).all();
  vectorDb.close();
  console.info("projection_drain_evidence", JSON.stringify({
    after_twelve: afterTwelve,
    returned_progress_count: projectionProgress.length,
    final_progress: projectionProgress.at(-1) ?? null,
    observed_no_runnable_work: observedNoRunnableWork,
    remaining: incompleteVectorUnits,
  }));
  if (incompleteVectorUnits.length > 0) {
    throw new Error(`projection_drain_incomplete:${JSON.stringify({
      after_twelve: afterTwelve,
      progress: projectionProgress,
      observed_no_runnable_work: observedNoRunnableWork,
      remaining: incompleteVectorUnits,
    })}`);
  }
  expect(observedNoRunnableWork).toBe(true);
  expect(vectorStates.some((row) => row.state !== "complete")).toBe(false);
  expect(vectorStates.reduce((sum, row) => sum + row.count, 0)).toBeGreaterThanOrEqual(2);
  expect(readGenerationHotCache({ butlerData: tempDir, projectId: tempDir })).toContain(
    "出典を確認する。",
  );
  const servingHealth = readMemoryHealth({ butlerData: tempDir }).serving;
  expect(servingHealth.available).toBe(true);
  expect(servingHealth.sources.eligible).toBeNull();
  expect(servingHealth.sources.known_eligible).toBeGreaterThanOrEqual(1);
  expect(servingHealth.sources.registered_current).toBeGreaterThanOrEqual(2);
  expect(servingHealth.stages.semantic_graph.complete).toBeGreaterThanOrEqual(2);
  expect(servingHealth.cache.current_entries).toBeGreaterThanOrEqual(2);
  const feedback = addFeedbackEntry(tempDir, {
    text: "Exclude this exact source.",
    targetRef: evidence.source_ref,
    scope: "source",
  });
  const targetDb = new Database(join(
    tempDir,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  ), { readonly: true });
  const target = targetDb.query<{ episode_id: string; revision: string }, [string]>(
    "SELECT episode_id,revision FROM memory_chunk_sources WHERE source_id=?",
  ).get(source!.source_id)!;
  targetDb.close();
  recordFeedbackQualityExclusion(tempDir, {
    feedback_id: feedback.feedback_id,
    operation_id: "exclude-multilingual-source",
    intent: "exclude",
    actor: "operator",
    source_ref: source!.source_id,
    source_revision: target.revision,
    source_hash: resolveMemorySource({ context, sourceRef: source!.source_id }).source_hash,
    generation_id: descriptor.generation_id,
    episode_id: target.episode_id,
    target_revision: target.revision,
    feedback_owner_revision: feedbackOwnerRevision(feedback),
    scope: "all_user_sessions",
  });
  expect(readMemoryHealth({ butlerData: tempDir }).serving.pending_quality_operations).toBe(1);
  expect(readGenerationHotCache({ butlerData: tempDir, projectId: tempDir }))
    .toBe("تحقق من المصدر قبل الإجابة.");
  const excludedRecall = await createRecallMemoryToolHandler(toolInput)({
    name: "recall_memory",
    args: { cue: "出典", include_vector: false, scope: "all_user_sessions" },
    rawArguments: "{}",
    toolContractVersion: 2,
  }, { effectOccurrenceId: "typed-recall-excluded" }) as any;
  expect(excludedRecall.results.flatMap((result: any) => result.evidence)
    .some((item: any) => item.source_ref === evidence.source_ref)).toBe(false);
  expect(await applyFeedbackQualityOperation(tempDir, {
    feedbackId: feedback.feedback_id,
    operationId: "exclude-multilingual-source",
    sourceRevision: target.revision,
  })).toMatchObject({ status: "applied" });
  expect(readMemoryHealth({ butlerData: tempDir }).serving.pending_quality_operations).toBe(0);
  resolveFeedbackEntry(tempDir, feedback.feedback_id, "applied");
  clearResolvedFeedbackEntries(tempDir);
  const excludedRawRead = await createReadConversationSessionToolHandler(toolInput)({
    name: "read_conversation_session",
    args: structuredClone(evidence.read_args),
    rawArguments: JSON.stringify(evidence.read_args),
    toolContractVersion: 2,
  } as any) as any;
  expect(excludedRawRead).toMatchObject({ ok: true, text: "出典を確認する。" });
  expect(readGenerationHotCache({ butlerData: tempDir, projectId: tempDir }))
    .toBe("تحقق من المصدر قبل الإجابة.");
  const staleFeedback = addFeedbackEntry(tempDir, {
    text: "Exclude this source if it is still the same revision.",
    targetRef: evidence.source_ref,
    scope: "source",
  });
  recordFeedbackQualityExclusion(tempDir, {
    feedback_id: staleFeedback.feedback_id,
    operation_id: "exclude-before-source-change",
    intent: "exclude",
    actor: "operator",
    source_ref: source!.source_id,
    source_revision: target.revision,
    source_hash: resolveMemorySource({ context, sourceRef: source!.source_id }).source_hash,
    generation_id: descriptor.generation_id,
    episode_id: target.episode_id,
    target_revision: target.revision,
    feedback_owner_revision: feedbackOwnerRevision(staleFeedback),
    scope: "all_user_sessions",
  });
  const typedBindingPath = join(
    tempDir,
    "cognition",
    "memory",
    "rules",
    `${rule.record_id}.source.json`,
  );
  const typedBinding = readFileSync(typedBindingPath, "utf8");
  const typedSourcePath = join(
    tempDir,
    "cognition",
    "memory",
    "rules",
    `${rule.record_id}.md`,
  );
  const typedSource = readFileSync(typedSourcePath, "utf8");
  writeFileSync(typedBindingPath, "{", "utf8");
  try {
    await expect(applyFeedbackQualityOperation(tempDir, {
      feedbackId: staleFeedback.feedback_id,
      operationId: "exclude-before-source-change",
      sourceRevision: target.revision,
    })).rejects.toThrow("memory_source_unavailable");
    expect(listFeedbackQualityOperations(tempDir).find((operation) =>
      operation.operation_id === "exclude-before-source-change",
    )?.status).toBe("pending");
    expect(() => updateExplicitMemory({
      butlerData: tempDir,
      recordId: rule.record_id,
      operationId: "effect-unavailable-update",
      update: { kind: "rule", text: "Do not replace an unavailable owner.", source: "native" },
    })).toThrow("memory_source_unavailable");
    expect(readFileSync(typedBindingPath, "utf8")).toBe("{");
    expect(readFileSync(typedSourcePath, "utf8")).toBe(typedSource);
    expect(() => forgetExplicitMemory({
      butlerData: tempDir,
      recordId: rule.record_id,
      operationId: "effect-unavailable-forget",
    })).toThrow("memory_source_unavailable");
    expect(readFileSync(typedBindingPath, "utf8")).toBe("{");
    expect(readFileSync(typedSourcePath, "utf8")).toBe(typedSource);
  } finally {
    writeFileSync(typedBindingPath, typedBinding, "utf8");
  }
  const beforeReplacementDb = new Database(join(tempDir, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
  const oldVectorKeys = beforeReplacementDb.query<{ receipt_json: string }, [string]>(`
    SELECT u.receipt_json FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id
    WHERE j.episode_id=? AND j.revision<>'' AND u.state='complete' AND u.receipt_json IS NOT NULL
  `).all(target.episode_id).flatMap((row) => (JSON.parse(row.receipt_json) as { vector_keys?: string[] }).vector_keys ?? []);
  beforeReplacementDb.close();
  const modified = updateExplicitMemory({
    butlerData: tempDir,
    recordId: rule.record_id,
    operationId: "effect-multilingual-modify",
    conversationSessionId: "canonical-authored-session",
    conversationMessageId: authoredMessageId,
    update: { kind: "rule", text: "出典を二度確認する。", source: "native" },
  });
  const modifiedNotice = readFileSync(join(tempDir, "cognition", "memory", "queue", "sync.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .find((entry) => entry.source?.operation_id === modified.operation_id);
  const replacementEmbeddingServer = createCheckedEmbeddingStub();
  await new Promise<void>((resolve, reject) => {
    replacementEmbeddingServer.once("error", reject);
    replacementEmbeddingServer.listen(process.env.EMBED_SOCKET!, resolve);
  });
  try {
    expect(await processEntry(modifiedNotice, { butlerData: tempDir })).toMatchObject({ dequeue: true });
    for (let step = 0; step < 64; step += 1) {
      if (await advanceNextMemoryProjection({ context }) === null) break;
    }
  } finally {
    await new Promise<void>((resolve) => replacementEmbeddingServer.close(() => resolve()));
  }
  const replacementDb = new Database(join(tempDir, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"));
  const liveVectorKeys = new Set(replacementDb.query<{ receipt_json: string }, [string]>(`
    SELECT u.receipt_json FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id
    JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
    WHERE j.episode_id=? AND u.state='complete' AND u.receipt_json IS NOT NULL
  `).all(target.episode_id).flatMap((row) => (JSON.parse(row.receipt_json) as { vector_keys?: string[] }).vector_keys ?? []));
  const obsoleteVectorKeys = [...new Set(oldVectorKeys.filter((key) => !liveVectorKeys.has(key)))];
  const deletionPredicates: string[] = [];
  const optimized = await runRevisionAwareOptimize({ db: replacementDb, context, table: { delete: async (predicate) => { deletionPredicates.push(predicate); } } });
  replacementDb.close();
  expect(obsoleteVectorKeys.length).toBeGreaterThan(0);
  expect(optimized.vectors_pruned).toBe(obsoleteVectorKeys.length);
  for (const key of obsoleteVectorKeys) expect(deletionPredicates.join("\n")).toContain(key);
  for (const key of liveVectorKeys) expect(deletionPredicates.join("\n")).not.toContain(key);
  expect(await applyFeedbackQualityOperation(tempDir, {
    feedbackId: staleFeedback.feedback_id,
    operationId: "exclude-before-source-change",
    sourceRevision: target.revision,
  })).toMatchObject({ status: "stale" });
  expect((await createRecallMemoryToolHandler(toolInput)({
    name: "recall_memory",
    args: { cue: "二度確認", include_vector: false, scope: "all_user_sessions" },
    rawArguments: "{}", toolContractVersion: 2,
  }, { effectOccurrenceId: "typed-recall-modified" }) as any).results.length).toBeGreaterThan(0);
  const forgotten = forgetExplicitMemory({
    butlerData: tempDir,
    recordId: rule.record_id,
    operationId: "effect-multilingual-forget",
  });
  const forgottenNotice = readFileSync(join(tempDir, "cognition", "memory", "queue", "sync.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .find((entry) => entry.source?.operation_id === "effect-multilingual-forget");
  expect(await processEntry(forgottenNotice, { butlerData: tempDir })).toMatchObject({ dequeue: true });
  expect(forgotten.replayed).toBe(false);
  expect((await createRecallMemoryToolHandler(toolInput)({
    name: "recall_memory",
    args: { cue: "二度確認", include_vector: false, scope: "all_user_sessions" },
    rawArguments: "{}", toolContractVersion: 2,
  }, { effectOccurrenceId: "typed-recall-forgotten" }) as any).results).toHaveLength(0);
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

test("typed source schema migration preserves pre-A rows and permits nullable canonical ids", () => {
  const db = new Database(join(tempDir, "pre-a.sqlite"));
  db.exec(`
    CREATE TABLE memory_chunks(
      memory_chunk_id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,current_revision TEXT NOT NULL,
      conversation_session_id TEXT,conversation_turn_id TEXT,conversation_start TEXT,conversation_end TEXT,
      project_id TEXT,origin_kind TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',
      summary_status TEXT NOT NULL DEFAULT 'pending',source_hash TEXT NOT NULL,created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO memory_chunks VALUES(
      'episode-old','conversation:old','revision-old','session-old',NULL,'2026-09-09T00:00:00.000Z',
      '2026-09-09T00:00:00.000Z',NULL,'conversation','active','','pending','hash-old',
      '2026-09-09T00:00:00.000Z','2026-09-09T00:00:00.000Z'
    );
    CREATE TABLE memory_chunk_sources(
      source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,
      conversation_session_id TEXT NOT NULL,conversation_message_id TEXT NOT NULL,part_id TEXT NOT NULL,
      scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,
      role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL
    );
    INSERT INTO memory_chunk_sources VALUES(
      'source-old','episode-old','revision-old','conversation','session-old','message-old','part-old',
      '/text',0,3,'hash-old','user','user_input','2026-09-09T00:00:00.000Z','user_statement'
    );
    CREATE TABLE memory_source_split_parents(
      source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,
      conversation_session_id TEXT NOT NULL,conversation_message_id TEXT NOT NULL,part_id TEXT NOT NULL,
      scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,
      role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,
      child_source_ids_json TEXT NOT NULL,recorded_at TEXT NOT NULL
    );
  `);
  ensureV2MemorySchema(db);
  const nullable = db.query<{ name: string; notnull: number }, []>(
    "PRAGMA table_info(memory_chunk_sources)",
  ).all().filter((column) => column.name.startsWith("conversation_"));
  expect(nullable.map((column) => column.notnull)).toEqual([0, 0]);
  expect(db.query<{ source_id: string }, []>(
    "SELECT source_id FROM memory_chunk_sources",
  ).all()).toEqual([{ source_id: "source-old" }]);
  db.query(`INSERT INTO memory_chunk_sources VALUES(
    'source-new','episode-old','revision-new','explicit_record',NULL,NULL,'rule-new','/text',0,3,
    'hash-new','explicit','unknown','2026-09-09T00:00:01.000Z','user_statement'
  )`).run();
  db.close();
});
