import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentConversationStore,
  conversationStorePath,
  conversationMessagesSourceHash,
} from "../../packages/butler-agent/src/agent/conversation/store.ts";
import type { ConversationIdFactory } from "../../packages/butler-agent/src/agent/conversation/ids.ts";

let tempDir = "";

function deterministicIds(): ConversationIdFactory {
  let next = 0;
  return (prefix) => `${prefix}_${String(++next).padStart(3, "0")}`;
}

function createStore(): AgentConversationStore {
  return new AgentConversationStore({
    butlerData: tempDir,
    idFactory: deterministicIds(),
  });
}

function sourceFiles(root: string): string[] {
  const ignored = new Set([".git", ".tmp", "node_modules", "dist", "build", ".next"]);
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (ignored.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (stat.isFile() && /\.(ts|tsx|js|mjs|cjs)$/u.test(path)) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-conversation-store-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("conversation store creates the canonical schema and migration marker", () => {
  const store = createStore();
  store.close();

  const db = new Database(conversationStorePath(tempDir), { readonly: true });
  try {
    const tables = db.query<{ name: string }, []>(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'virtual table')
    `).all().map((row) => row.name);
    expect(tables).toContain("conversation_sessions");
    expect(tables).toContain("conversation_bindings");
    expect(tables).toContain("conversation_turns");
    expect(tables).toContain("conversation_messages");
    expect(tables).toContain("conversation_parts");
    expect(tables).toContain("conversation_summaries");
    expect(tables).toContain("conversation_turn_outcomes");
    expect(tables).toContain("conversation_projection_outbox");
    expect(tables).toContain("conversation_schema_migrations");
    expect(db.query<{ version: number }, []>("SELECT version FROM conversation_schema_migrations").get()?.version)
      .toBe(2);
  } finally {
    db.close();
  }
});

test("conversation store upgrades a version-one database without losing semantic rows", () => {
  const original = createStore();
  const turn = original.beginTurn({
    gateway: "app",
    externalSessionId: "chat-v1",
    sessionId: "cs_v1",
    actor: "user",
  });
  original.appendUserMessage({ sessionId: turn.session_id, turnId: turn.id, text: "v1 message" });
  original.close();

  const legacy = new Database(conversationStorePath(tempDir));
  legacy.exec("DROP TABLE conversation_turn_outcomes");
  legacy.query("DELETE FROM conversation_schema_migrations WHERE version = 2").run();
  legacy.close();

  const upgraded = createStore();
  expect(upgraded.readSemanticTail("cs_v1", 10)[0]?.parts[0]?.content_json).toEqual({
    text: "v1 message",
  });
  upgraded.close();
  const verified = new Database(conversationStorePath(tempDir), { readonly: true });
  expect(verified.query<{ version: number }, []>(`
    SELECT MAX(version) AS version FROM conversation_schema_migrations
  `).get()?.version).toBe(2);
  expect(verified.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turn_outcomes'
  `).get()?.name).toBe("conversation_turn_outcomes");
  verified.close();
});

test("turn finalization atomically writes an idempotent generation-ordered outcome capsule", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-outcome",
    sessionId: "cs_outcome",
    actor: "user",
    turnId: "turn-outcome",
  });
  const request = store.appendUserMessage({
    sessionId: turn.session_id,
    turnId: turn.id,
    text: "finish this work",
  });
  const assistant = store.appendAssistantMessage({
    sessionId: turn.session_id,
    turnId: turn.id,
    text: "done",
  });
  const capsuleInput = {
    sessionId: turn.session_id,
    turnId: turn.id,
    generation: 1,
    outcome: "delivered" as const,
    requestMessageId: request.id,
    publicAssistantMessageId: assistant.id,
    providerId: "openai",
    modelRef: "openai/gpt-5.2",
    evidenceRefs: ["evidence-1"],
    unresolvedObligations: [],
    createdAt: "2026-07-13T00:00:00.000Z",
  };

  store.finalizeTurn({
    turnId: turn.id,
    status: "complete",
    outcomeCapsule: capsuleInput,
  });
  const first = store.readTurnOutcome(turn.id);
  expect(first).toMatchObject({
    outcome: "delivered",
    generation: 1,
    request_message_id: request.id,
    public_assistant_message_id: assistant.id,
    evidence_refs: ["evidence-1"],
  });
  expect(first?.source_hash).toMatch(/^[a-f0-9]{64}$/u);
  expect(store.readProjectionBatch(null, 20).map((event) => event.kind))
    .toContain("conversation.turn_outcome_written");

  store.writeTurnOutcome(capsuleInput);
  expect(store.readTurnOutcome(turn.id)).toEqual(first);
  store.writeTurnOutcome({ ...capsuleInput, generation: 0, outcome: "failed" });
  expect(store.readTurnOutcome(turn.id)).toEqual(first);
  expect(() => store.writeTurnOutcome({
    ...capsuleInput,
    outcome: "failed",
    safeCode: "different_same_generation",
  })).toThrow("Turn outcome generation conflict");

  const next = store.writeTurnOutcome({
    ...capsuleInput,
    generation: 2,
    outcome: "recoverable",
    publicAssistantMessageId: null,
    unresolvedObligations: ["finish validation"],
    safeCode: "admission_invariant_violation",
  });
  expect(next).toMatchObject({
    generation: 2,
    outcome: "recoverable",
    unresolved_obligations: ["finish validation"],
    safe_code: "admission_invariant_violation",
  });
  store.close();

  const mutated = new Database(conversationStorePath(tempDir));
  mutated.query("UPDATE conversation_parts SET content_json = ? WHERE message_id = ?")
    .run(JSON.stringify({ text: "mutated request" }), request.id);
  mutated.close();
  const reopened = createStore();
  expect(reopened.readTurnOutcome(turn.id)).toBeNull();
  reopened.close();
});

test("turn finalization rolls back when outcome capsule validation fails", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-outcome-rollback",
    sessionId: "cs_outcome_rollback",
    actor: "user",
    turnId: "turn-outcome-rollback",
  });

  expect(() => store.finalizeTurn({
    turnId: turn.id,
    status: "complete",
    outcomeCapsule: {
      sessionId: "wrong-session",
      turnId: turn.id,
      generation: 1,
      outcome: "delivered",
    },
  })).toThrow("Turn outcome session mismatch");
  expect(store.readTurn(turn.id)).toMatchObject({ status: "running", completed_at: null });
  expect(store.readTurnOutcome(turn.id)).toBeNull();
  store.close();
});

test("writer persists turns messages parts and projection outbox atomically", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-1",
    sessionId: "cs_main",
    workspaceId: "workspace-1",
    projectId: "butler",
    actor: "user",
    requestId: "request-1",
    now: "2026-07-02T00:00:00.000Z",
  });

  const user = store.appendUserMessage({
    sessionId: "cs_main",
    turnId: turn.id,
    text: "hello",
    sourceGateway: "app",
    sourceRef: "client-message-1",
    now: "2026-07-02T00:00:01.000Z",
  });
  const assistant = store.appendAssistantMessage({
    sessionId: "cs_main",
    turnId: turn.id,
    text: "hi",
    sourceGateway: "app",
    sourceRef: "assistant-message-1",
    now: "2026-07-02T00:00:02.000Z",
  });

  expect(store.getSessionByGatewayBinding("app", "chat-1")).toMatchObject({
    id: "cs_main",
    project_id: "butler",
    workspace_id: "workspace-1",
  });
  expect(store.readSemanticTail("cs_main", 10).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.parts[0]?.content_json,
  }))).toEqual([
    { id: user.id, role: "user", text: { text: "hello" } },
    { id: assistant.id, role: "assistant", text: { text: "hi" } },
  ]);
  expect(store.readProjectionBatch(null, 10).map((event) => event.kind)).toEqual([
    "conversation.session_bound",
    "conversation.turn_started",
    "conversation.message_committed",
    "conversation.message_committed",
  ]);
  store.close();
});

test("tool call and result parts preserve ids provider shape and ordering", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "cli",
    externalSessionId: "cli-session",
    sessionId: "cs_tools",
    actor: "assistant",
  });
  const assistant = store.appendAssistantMessage({
    sessionId: "cs_tools",
    turnId: turn.id,
    text: "using a tool",
  });

  store.appendToolCall({
    messageId: assistant.id,
    toolCallId: "call_1",
    providerShape: "openai",
    contentJson: { name: "read_file", arguments: { path: "README.md" } },
  });
  store.appendToolResult({
    messageId: assistant.id,
    toolCallId: "call_1",
    parentToolCallId: "call_1",
    providerShape: "openai",
    contentJson: { ok: true, text: "done" },
  });

  const [message] = store.readSemanticTail("cs_tools", 10);
  expect(message?.parts.map((part) => ({
    kind: part.kind,
    tool_call_id: part.tool_call_id,
    parent_tool_call_id: part.parent_tool_call_id,
    provider_shape: part.provider_shape,
  }))).toEqual([
    { kind: "text", tool_call_id: null, parent_tool_call_id: null, provider_shape: null },
    { kind: "tool_call", tool_call_id: "call_1", parent_tool_call_id: null, provider_shape: "openai" },
    { kind: "tool_result", tool_call_id: "call_1", parent_tool_call_id: "call_1", provider_shape: "openai" },
  ]);
  expect(store.readProjectionBatch(null, 10).map((event) => event.kind)).toContain("conversation.tool_result_committed");
  store.close();
});

test("summaries compact covered messages and prompt material keeps canonical provenance", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-2",
    sessionId: "cs_summary",
    actor: "user",
  });
  const first = store.appendUserMessage({ sessionId: "cs_summary", turnId: turn.id, text: "first" });
  const second = store.appendAssistantMessage({ sessionId: "cs_summary", turnId: turn.id, text: "second" });

  const summary = store.writeSummary({
    sessionId: "cs_summary",
    coversFromSeq: first.seq,
    coversToSeq: first.seq,
    sourceHash: conversationMessagesSourceHash([first]),
    model: "test-model",
    summaryText: "first summarized",
  });

  expect(store.readSemanticTail("cs_summary", 10).map((message) => message.id)).toEqual([second.id]);
  const prompt = store.readPromptMaterial({ sessionId: "cs_summary" });
  expect(prompt.summaries.map((summary) => summary.summary_text)).toEqual(["first summarized"]);
  expect(prompt.provenance).toEqual([
    { kind: "summary", id: summary.id },
    { kind: "message", id: second.id },
  ]);
  store.close();
});

test("summary reads invalidate stale source hashes after semantic mutation", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-stale",
    sessionId: "cs_stale_summary",
    actor: "user",
  });
  const message = store.appendUserMessage({
    sessionId: "cs_stale_summary",
    turnId: turn.id,
    text: "original",
  });
  store.writeSummary({
    sessionId: "cs_stale_summary",
    coversFromSeq: message.seq,
    coversToSeq: message.seq,
    sourceHash: conversationMessagesSourceHash([message]),
    summaryText: "original summary",
    summaryId: "csm_stale",
  });
  store.close();

  const db = new Database(conversationStorePath(tempDir));
  try {
    db.query("UPDATE conversation_parts SET content_json = ? WHERE message_id = ?")
      .run(JSON.stringify({ text: "mutated" }), message.id);
  } finally {
    db.close();
  }

  const reopened = createStore();
  expect(reopened.readSummaries("cs_stale_summary")).toEqual([]);
  const tail = reopened.readSemanticTail("cs_stale_summary", 10);
  expect(tail.map((message) => ({
    id: message.id,
    status: message.status,
    compactedBy: message.compacted_by_summary_id,
    text: message.parts[0]?.content_json,
  }))).toEqual([{
    id: message.id,
    status: "complete",
    compactedBy: null,
    text: { text: "mutated" },
  }]);
  const prompt = reopened.readPromptMaterial({ sessionId: "cs_stale_summary" });
  expect(prompt.summaries).toEqual([]);
  expect(prompt.semantic_tail.map((message) => message.id)).toEqual([message.id]);
  reopened.close();
});

test("prompt material reads the complete uncompacted semantic tail when no explicit limit is requested", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-unbounded-tail",
    sessionId: "cs_unbounded_tail",
    actor: "user",
  });
  for (let index = 0; index < 205; index += 1) {
    store.appendAssistantMessage({
      sessionId: "cs_unbounded_tail",
      turnId: turn.id,
      text: `semantic-${index}`,
    });
  }

  expect(store.readPromptMaterial({ sessionId: "cs_unbounded_tail" }).semantic_tail).toHaveLength(205);
  expect(store.readPromptMaterial({ sessionId: "cs_unbounded_tail", tailLimit: 80 }).semantic_tail)
    .toHaveLength(80);
  store.close();
});

test("summary write rolls back message compaction when the summary insert fails", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-summary-rollback",
    sessionId: "cs_summary_rollback",
    actor: "user",
  });
  const first = store.appendUserMessage({ sessionId: "cs_summary_rollback", turnId: turn.id, text: "first" });
  const second = store.appendAssistantMessage({ sessionId: "cs_summary_rollback", turnId: turn.id, text: "second" });
  store.writeSummary({
    sessionId: "cs_summary_rollback",
    coversFromSeq: first.seq,
    coversToSeq: first.seq,
    sourceHash: conversationMessagesSourceHash([first]),
    summaryText: "first summary",
    summaryId: "csm_duplicate",
  });

  expect(() => store.writeSummary({
    sessionId: "cs_summary_rollback",
    coversFromSeq: second.seq,
    coversToSeq: second.seq,
    sourceHash: conversationMessagesSourceHash([second]),
    summaryText: "second summary",
    summaryId: "csm_duplicate",
  })).toThrow();

  expect(store.readSemanticTail("cs_summary_rollback", 10).map((message) => message.id)).toEqual([second.id]);
  store.close();
});

test("message and outbox writes roll back together when part serialization fails", () => {
  const store = createStore();
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "chat-3",
    sessionId: "cs_rollback",
    actor: "user",
  });
  const beforeOutbox = store.readProjectionBatch(null, 10);

  expect(() => store.appendUserMessage({
    sessionId: "cs_rollback",
    turnId: turn.id,
    text: "bad",
    parts: [{ kind: "text", contentJson: { value: BigInt(1) } }],
  })).toThrow();

  expect(store.readSemanticTail("cs_rollback", 10)).toEqual([]);
  expect(store.readProjectionBatch(null, 10)).toEqual(beforeOutbox);
  store.close();
});

test("gateway modules do not import semantic writer APIs directly", () => {
  const root = process.cwd();
  const gatewayFiles = sourceFiles(join(root, "packages", "butler-agent", "src", "gateways"));
  const directWriterImports = gatewayFiles.filter((file) => {
    const text = readFileSync(file, "utf8");
    return /from ["'][^"']*agent\/conversation\/(?:store|index)\.ts["']/u.test(text) ||
      /\bConversationWriter\b|\bappendUserMessage\b|\bappendAssistantMessage\b/u.test(text);
  });

  expect(directWriterImports).toEqual([]);
});
