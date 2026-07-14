import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  completionJobProcessed,
  publishConversationCompletionObservation,
} from "../../packages/butler-agent/src/agent/cognition/continuity/completion-observation.ts";
import { writeSemanticHotCacheEntry } from "../../packages/butler-agent/src/agent/cognition/continuity/hot-cache-writer.ts";
import { memorySyncQueueFile, type SyncRequest } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/queue.ts";
import {
  pollIteration,
  processEntry,
  resetPauseState,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { ConversationAdmissionTurn } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { readOperationalMetricEvents } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(): { root: string; data: string; projectA: string; projectB: string; saveHot: string; index: string } {
  const root = mkdtempSync(join(tmpdir(), "butler-completion-hot-"));
  roots.push(root);
  const data = join(root, "data");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const saveHot = join(root, "save-hot.ts");
  const index = join(root, "index.ts");
  mkdirSync(data, { recursive: true });
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(saveHot, "");
  writeFileSync(index, "");
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({
    projects: [
      { name: "project-a", path: projectA },
      { name: "project-b", path: projectB },
    ],
  }));
  return { root, data, projectA, projectB, saveHot, index };
}

test("canonical completion publishes one idempotent job and consumer writes only that project turn", () => {
  const { data, projectA, projectB, saveHot, index } = fixture();
  const canonical = seedConversation(data, "project-a", "butler/project-a", "turn-a-2");
  const observation = publishConversationCompletionObservation({
    butlerData: data,
    projectId: "project-a",
    runtimeSessionId: "butler/project-a",
    conversationSessionId: canonical.sessionId,
    conversationTurnId: canonical.turnId,
    inboundMessageId: canonical.userMessageId,
    outboundMessageId: canonical.assistantMessageId,
    outcomeGeneration: 1,
    completedAt: "2026-07-14T02:00:00.000Z",
  });
  publishConversationCompletionObservation({
    butlerData: data,
    projectId: "project-a",
    runtimeSessionId: "butler/project-a",
    conversationSessionId: canonical.sessionId,
    conversationTurnId: canonical.turnId,
    inboundMessageId: canonical.userMessageId,
    outboundMessageId: canonical.assistantMessageId,
    outcomeGeneration: 1,
    completedAt: "2026-07-14T02:00:00.000Z",
  });
  const requests = readRequests(data);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    schema_version: "butler.memory-sync-request.v2",
    job_id: observation.job_id,
    conversation_turn_id: "turn-a-2",
    project_id: "project-a",
  });

  let summarizedInput = "";
  let summarizerCalls = 0;
  const deps = {
    butlerData: data,
    saveHotPath: saveHot,
    indexTsPath: index,
    runSaveHot: (_args: string[], _env: NodeJS.ProcessEnv, input: string) => {
      summarizerCalls += 1;
      summarizedInput = input;
      return spawnResult(0, "**Task**: Preserve the project-A rollout decision.");
    },
    runIndex: () => spawnResult(0, "indexed"),
  };
  const first = processEntry(requests[0]!, deps);
  const replay = processEntry(requests[0]!, deps);

  expect(first).toMatchObject({ dequeue: true, failCount: 0 });
  expect(replay).toMatchObject({ dequeue: true, reason: "completion_already_processed" });
  expect(summarizerCalls).toBe(1);
  expect(summarizedInput).toContain("second user instruction");
  expect(summarizedInput).toContain("second assistant answer");
  expect(summarizedInput).not.toContain("first turn must not be consolidated");
  expect(readFileSync(join(projectA, ".butler", "hot-cache.md"), "utf8"))
    .toContain("project-A rollout decision");
  expect(existsSync(join(projectB, ".butler", "hot-cache.md"))).toBe(false);
  expect(existsSync(join(data, "cognition", "memory", "hot", "cache.md"))).toBe(false);
  expect(completionJobProcessed(data, observation.job_id)).toBe(true);
});

test("general-chat completion writes global cache and never needs a project filesystem path", () => {
  const { data, saveHot, index } = fixture();
  const canonical = seedConversation(data, null, "butler/main", "turn-global");
  publishConversationCompletionObservation({
    butlerData: data,
    runtimeSessionId: "butler/main",
    conversationSessionId: canonical.sessionId,
    conversationTurnId: canonical.turnId,
    inboundMessageId: canonical.userMessageId,
    outboundMessageId: canonical.assistantMessageId,
    outcomeGeneration: 1,
    completedAt: "2026-07-14T02:10:00.000Z",
  });
  const result = processEntry(readRequests(data)[0]!, {
    butlerData: data,
    saveHotPath: saveHot,
    indexTsPath: index,
    runSaveHot: () => spawnResult(0, "**Chat**: General continuity summary."),
    runIndex: () => spawnResult(0, "indexed"),
  });

  expect(result.dequeue).toBe(true);
  expect(readFileSync(join(data, "cognition", "memory", "hot", "cache.md"), "utf8"))
    .toContain("General continuity summary");
});

test("missing project binding retries without falling back globally, then succeeds after registry recovery", () => {
  const { data, projectA, saveHot, index } = fixture();
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({ projects: [] }));
  const canonical = seedConversation(data, "project-missing", "butler/project-missing", "turn-missing");
  publishConversationCompletionObservation({
    butlerData: data,
    projectId: "project-missing",
    runtimeSessionId: "butler/project-missing",
    conversationSessionId: canonical.sessionId,
    conversationTurnId: canonical.turnId,
    inboundMessageId: canonical.userMessageId,
    outboundMessageId: canonical.assistantMessageId,
    outcomeGeneration: 1,
    completedAt: "2026-07-14T02:20:00.000Z",
  });
  const request = readRequests(data)[0]!;
  const deps = {
    butlerData: data,
    saveHotPath: saveHot,
    indexTsPath: index,
    runSaveHot: () => spawnResult(0, "**Task**: Recovered scoped project state."),
    runIndex: () => spawnResult(0, "indexed"),
  };
  const failed = processEntry(request, deps);
  expect(failed).toMatchObject({ dequeue: false, reason: "semantic_hot_cache_write_failed" });
  expect(existsSync(join(data, "cognition", "memory", "hot", "cache.md"))).toBe(false);

  writeFileSync(join(data, "butler.config.json"), JSON.stringify({
    projects: [{ name: "project-missing", path: projectA }],
  }));
  const recovered = processEntry(request, deps);
  expect(recovered).toMatchObject({ dequeue: true, failCount: 0 });
  expect(readFileSync(join(projectA, ".butler", "hot-cache.md"), "utf8"))
    .toContain("Recovered scoped project state");
});

test("shared writer recovers stale locks, compacts old entries, and preserves the newest provenance", () => {
  const { data, projectA } = fixture();
  const path = join(projectA, ".butler", "hot-cache.md");
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  writeFileSync(lock, "999999\n");
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lock, stale, stale);
  for (let index = 0; index < 12; index += 1) {
    writeSemanticHotCacheEntry({
      butlerData: data,
      scope: "project",
      projectId: "project-a",
      sessionId: "butler/project-a",
      sourceId: `job-${index}`,
      body: `**Task**: entry-${index} ${"x".repeat(180)}`,
      maxBytes: 1_500,
      lockStaleAfterMs: 1,
    });
  }
  const body = readFileSync(path, "utf8");
  expect(statSync(path).size).toBeLessThanOrEqual(1_500);
  expect(body).toContain("entry-11");
  expect(body).not.toContain("entry-0");
  expect(existsSync(lock)).toBe(false);
});

test("canonical completion jobs bypass project debounce so adjacent turns are not dropped", () => {
  const { root } = fixture();
  resetPauseState();
  const entries = ["job-a", "job-b"].map((jobId) => ({
    schema_version: "butler.memory-sync-request.v2" as const,
    job_id: jobId,
    scope: "project" as const,
    project_id: "project-a",
    project: "project-a",
    topic: null,
    source: "conversation_completion",
    session_id: "butler/project-a",
    timestamp: "2026-07-14T02:30:00.000Z",
    trigger: "turn_completed",
  }));
  let index = 0;
  let processed = 0;
  let dequeued = 0;
  const deps = {
    lockPath: join(root, "no-consolidation.lock"),
    peek: () => entries[index] ?? null,
    dequeue: () => {
      dequeued += 1;
      return entries[index++] ?? null;
    },
    process: () => {
      processed += 1;
      return { dequeue: true, failCount: 0 };
    },
  };
  expect(pollIteration(deps).action).toBe("processed");
  expect(pollIteration(deps).action).toBe("processed");
  expect(processed).toBe(2);
  expect(dequeued).toBe(2);
});

test("completion observation publication failure never downgrades an already completed answer", () => {
  const { data, projectA } = fixture();
  const store = new AgentConversationStore({ butlerData: data });
  const turn = ConversationAdmissionTurn.begin({
    writer: store,
    binding: {
      sessionId: "butler/project-a",
      role: "butler",
      projectId: "project-a",
      workspacePath: projectA,
      runtimeAdapterId: "codex-api",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      transportBindings: [],
      lifecycleState: "active",
      createdAt: "2026-07-14T02:40:00.000Z",
      updatedAt: "2026-07-14T02:40:00.000Z",
    },
    envelope: {
      eventId: "event-completion-publish-failure",
      transport: "app",
      accountId: "default",
      peer: { kind: "dm", id: "butler/project-a" },
      sender: { id: "user" },
      message: {
        id: "message-completion-publish-failure",
        text: "complete even when cognition queue storage is unavailable",
        timestamp: "2026-07-14T02:40:00.000Z",
      },
    },
    turnId: "turn-completion-publish-failure",
    timestamp: "2026-07-14T02:40:00.000Z",
    butlerData: data,
  });
  turn.admitInbound();
  turn.admitFinalAssistant(
    "The requested answer is complete.",
    "outbound-completion-publish-failure",
  );
  writeFileSync(join(data, "cognition"), "block cognition directory creation");

  turn.finalize("complete", "2026-07-14T02:40:01.000Z");

  expect(store.readTurnOutcome("turn-completion-publish-failure")).toMatchObject({
    outcome: "delivered",
    request_message_id: expect.any(String),
    public_assistant_message_id: expect.any(String),
  });
  expect(readOperationalMetricEvents({ butlerData: data })).toContainEqual(
    expect.objectContaining({
      category: "memory",
      name: "completion_observation_publish",
      status: "error",
      dimensions: { scope: "project" },
    }),
  );
  store.close();
});

function seedConversation(
  butlerData: string,
  projectId: string | null,
  runtimeSessionId: string,
  targetTurnId: string,
): { sessionId: string; turnId: string; userMessageId: string; assistantMessageId: string } {
  const store = new AgentConversationStore({ butlerData });
  const sessionId = `cs_${targetTurnId}`;
  const first = store.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId,
    projectId,
    actor: "user",
    turnId: `${targetTurnId}-prior`,
    now: "2026-07-14T01:00:00.000Z",
  });
  store.appendUserMessage({
    sessionId,
    turnId: first.id,
    text: "first turn must not be consolidated",
    now: "2026-07-14T01:00:01.000Z",
  });
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId,
    projectId,
    actor: "user",
    turnId: targetTurnId,
    now: "2026-07-14T01:01:00.000Z",
  });
  const user = store.appendUserMessage({
    sessionId,
    turnId: turn.id,
    text: "second user instruction",
    now: "2026-07-14T01:01:01.000Z",
  });
  const assistant = store.appendAssistantMessage({
    sessionId,
    turnId: turn.id,
    text: "second assistant answer",
    now: "2026-07-14T01:01:02.000Z",
  });
  store.finalizeTurn({ turnId: turn.id, status: "complete", completedAt: "2026-07-14T01:01:03.000Z" });
  store.close();
  return { sessionId, turnId: turn.id, userMessageId: user.id, assistantMessageId: assistant.id };
}

function readRequests(butlerData: string): SyncRequest[] {
  return readFileSync(memorySyncQueueFile(butlerData), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SyncRequest);
}

function spawnResult(status: number, stdout: string) {
  return { status, signal: null, output: [], pid: 1, stdout, stderr: "" };
}
