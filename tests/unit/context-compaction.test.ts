import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compactTranscript,
  compactionMetricsPath,
  compactionPath,
  maybeAutoCompactSession,
  readCompactionMetrics,
  readLatestCompactionSnapshot,
  renderCompactionContext,
  writeFailedCompactionDiagnostic,
} from "../../packages/butler-agent/src/agent/context/compaction.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";

let tempDir = "";
let originalButlerData: string | undefined;
const runtimeSessionId = "butler/main";
const canonicalSessionId = conversationSessionIdForDurableSession(runtimeSessionId);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-context-compaction-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

function appendConversation(count: number): void {
  const store = new AgentConversationStore({ butlerData: tempDir });
  store.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId: canonicalSessionId,
    actor: "user",
    turnId: "context-compaction-seed",
  });
  for (let index = 0; index < count; index += 1) {
    store.appendUserMessage({
      sessionId: canonicalSessionId,
      turnId: "context-compaction-seed",
      text: `사용자 목표 ${index}: 프로젝트 결정을 기억하고 worker 상태를 유지해야 합니다. ${"맥락 ".repeat(30)}`,
      sourceGateway: "app",
      sourceRef: `u-${index}`,
      now: new Date(index * 1_000).toISOString(),
    });
    store.appendAssistantMessage({
      sessionId: canonicalSessionId,
      turnId: "context-compaction-seed",
      text: `결정 ${index}: 이 선택은 나중에 회상되어야 합니다. ${"세부사항 ".repeat(30)}`,
      sourceGateway: "app",
      sourceRef: `a-${index}`,
      now: new Date(index * 1_000 + 1).toISOString(),
    });
  }
  store.close();
}

function appendFollowUp(text: string): void {
  const store = new AgentConversationStore({ butlerData: tempDir });
  store.appendUserMessage({
    sessionId: canonicalSessionId,
    text,
    sourceGateway: "app",
    sourceRef: "follow-up-after-compaction",
    now: new Date(99_000).toISOString(),
  });
  store.close();
}

test("compaction writes provenance snapshots and preserves suffix ids", async () => {
  appendConversation(10);

  const snapshot = await compactTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
    trigger: "manual",
    modelRef: "openai/test",
    preserveLastEvents: 4,
    budgetOverrides: {
      contextWindowTokens: 1_000,
      reservedOutputTokens: 20,
      reservedToolTokens: 20,
    },
  });

  expect(snapshot.status).toBe("ok");
  expect(snapshot.summary).toContain("Canonical messages summarized");
  expect(snapshot.summarized_event_range.event_count).toBeGreaterThan(0);
  expect(snapshot.preserved_suffix_event_ids).toHaveLength(4);
  expect(snapshot.preserved_suffix_message_ids).toHaveLength(4);
  expect(snapshot.source_hash).toStartWith("sha256:");
  expect(snapshot.provenance.length).toBeGreaterThan(0);
  expect(snapshot.post_estimated_tokens).toBeLessThan(snapshot.pre_estimated_tokens);
  expect(existsSync(compactionPath(tempDir, canonicalSessionId))).toBe(true);

  const rendered = renderCompactionContext(readLatestCompactionSnapshot({
    butlerData: tempDir,
    sessionId: "butler/main",
  }));
  expect(rendered).toContain("## Compaction Summary");
  expect(rendered).toContain("source of truth");
});

test("auto compaction triggers at configured pressure and uses hierarchical chunks", async () => {
  appendConversation(18);

  const snapshot = await maybeAutoCompactSession({
    butlerData: tempDir,
    sessionId: "butler/main",
    modelRef: "openai/test",
    budgetOverrides: {
      contextWindowTokens: 700,
      reservedOutputTokens: 10,
      reservedToolTokens: 10,
    },
  });

  expect(snapshot?.trigger).toBe("auto");
  expect(snapshot?.diagnostics).toContain("hierarchical_chunk_compaction");
});

test("auto compaction pressure uses effective post-compaction context instead of raw transcript total", async () => {
  appendConversation(30);

  const budgetOverrides = {
    contextWindowTokens: 6_000,
    reservedOutputTokens: 50,
    reservedToolTokens: 50,
  };
  const first = await maybeAutoCompactSession({
    butlerData: tempDir,
    sessionId: "butler/main",
    modelRef: "openai/test",
    budgetOverrides,
  });
  expect(first?.trigger).toBe("auto");

  appendFollowUp("짧은 후속 질문입니다.");

  const second = await maybeAutoCompactSession({
    butlerData: tempDir,
    sessionId: "butler/main",
    modelRef: "openai/test",
    budgetOverrides,
  });

  expect(second).toBeNull();
});

test("concurrent compactions serialize through one append-only snapshot log", async () => {
  appendConversation(8);

  await Promise.all([
    compactTranscript({
      butlerData: tempDir,
      sessionId: "butler/main",
      trigger: "manual",
      preserveLastEvents: 2,
    }),
    compactTranscript({
      butlerData: tempDir,
      sessionId: "butler/main",
      trigger: "repair",
      preserveLastEvents: 2,
    }),
  ]);

  const raw = readFileSync(compactionPath(tempDir, canonicalSessionId), "utf8")
    .trim()
    .split("\n");
  expect(raw).toHaveLength(2);
  expect(raw.every((line) => JSON.parse(line).status === "ok")).toBe(true);
});

test("semantic compaction preserves tool call result adjacency at the tail boundary", async () => {
  const store = new AgentConversationStore({ butlerData: tempDir });
  store.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId: canonicalSessionId,
    actor: "user",
    turnId: "tool-boundary-seed",
  });
  store.appendUserMessage({
    sessionId: canonicalSessionId,
    turnId: "tool-boundary-seed",
    text: "도구를 써서 확인해줘.",
    sourceRef: "tool-u-1",
  });
  const toolCall = store.appendAssistantMessage({
    sessionId: canonicalSessionId,
    turnId: "tool-boundary-seed",
    text: "",
    parts: [{
      kind: "tool_call",
      contentJson: { name: "read_file", arguments: { path: "README.md" } },
      toolCallId: "call-boundary",
      providerShape: "openai",
    }],
    sourceRef: "tool-call",
  });
  const toolResult = store.appendAssistantMessage({
    sessionId: canonicalSessionId,
    turnId: "tool-boundary-seed",
    text: "",
    parts: [{
      kind: "tool_result",
      contentJson: { ok: true, text: "done" },
      toolCallId: "call-boundary",
      parentToolCallId: "call-boundary",
      providerShape: "openai",
    }],
    sourceRef: "tool-result",
  });
  store.close();

  await compactTranscript({
    butlerData: tempDir,
    sessionId: runtimeSessionId,
    trigger: "manual",
    preserveLastMessages: 1,
  });

  const reopened = new AgentConversationStore({ butlerData: tempDir });
  const tail = reopened.readSemanticTail(canonicalSessionId, 10);
  reopened.close();
  expect(tail.map((message) => message.id)).toEqual([toolCall.id, toolResult.id]);
});

test("semantic compaction summarizes completed tool groups before the tail boundary", async () => {
  const store = new AgentConversationStore({ butlerData: tempDir });
  store.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId: canonicalSessionId,
    actor: "user",
    turnId: "tool-complete-before-tail",
  });
  const toolCall = store.appendAssistantMessage({
    sessionId: canonicalSessionId,
    turnId: "tool-complete-before-tail",
    text: "",
    parts: [{
      kind: "tool_call",
      contentJson: { name: "read_file" },
      toolCallId: "call-complete-before-tail",
    }],
  });
  const toolResult = store.appendAssistantMessage({
    sessionId: canonicalSessionId,
    turnId: "tool-complete-before-tail",
    text: "",
    parts: [{
      kind: "tool_result",
      contentJson: { ok: true },
      toolCallId: "call-complete-before-tail",
      parentToolCallId: "call-complete-before-tail",
    }],
  });
  const suffix = Array.from({ length: 5 }, (_, index) =>
    store.appendUserMessage({
      sessionId: canonicalSessionId,
      turnId: "tool-complete-before-tail",
      text: `suffix ${index}`,
    }),
  );
  store.close();

  await compactTranscript({
    butlerData: tempDir,
    sessionId: runtimeSessionId,
    trigger: "manual",
    preserveLastMessages: 2,
  });

  const reopened = new AgentConversationStore({ butlerData: tempDir });
  const tail = reopened.readSemanticTail(canonicalSessionId, 10);
  reopened.close();
  expect(tail.map((message) => message.id)).toEqual(suffix.slice(-2).map((message) => message.id));
  expect(tail.map((message) => message.id)).not.toContain(toolCall.id);
  expect(tail.map((message) => message.id)).not.toContain(toolResult.id);
});

test("semantic compaction preserves open tool calls before the tail boundary", async () => {
  const store = new AgentConversationStore({ butlerData: tempDir });
  store.beginTurn({
    gateway: "app",
    externalSessionId: runtimeSessionId,
    sessionId: canonicalSessionId,
    actor: "user",
    turnId: "tool-open-before-tail",
  });
  const toolCall = store.appendAssistantMessage({
    sessionId: canonicalSessionId,
    turnId: "tool-open-before-tail",
    text: "",
    parts: [{
      kind: "tool_call",
      contentJson: { name: "read_file" },
      toolCallId: "call-open-before-tail",
    }],
  });
  const suffix = Array.from({ length: 4 }, (_, index) =>
    store.appendUserMessage({
      sessionId: canonicalSessionId,
      turnId: "tool-open-before-tail",
      text: `open suffix ${index}`,
    }),
  );
  store.close();

  await compactTranscript({
    butlerData: tempDir,
    sessionId: runtimeSessionId,
    trigger: "manual",
    preserveLastMessages: 2,
  });

  const reopened = new AgentConversationStore({ butlerData: tempDir });
  const tail = reopened.readSemanticTail(canonicalSessionId, 10);
  reopened.close();
  expect(tail.map((message) => message.id)).toEqual([
    toolCall.id,
    ...suffix.map((message) => message.id),
  ]);
});

test("compaction writes raw-text-free success and failure telemetry", async () => {
  appendConversation(6);

  const snapshot = await compactTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
    trigger: "manual",
    preserveLastEvents: 2,
    modelRef: "openai/test",
    budgetOverrides: {
      contextWindowTokens: 900,
      reservedOutputTokens: 20,
      reservedToolTokens: 20,
    },
  });
  writeFailedCompactionDiagnostic({
    butlerData: tempDir,
    sessionId: canonicalSessionId,
    modelRef: "openai/test",
    reason: "SECRET raw diagnostic with user text",
  });

  const metrics = readCompactionMetrics({
    butlerData: tempDir,
    sessionId: canonicalSessionId,
  });
  const rawMetrics = readFileSync(compactionMetricsPath(tempDir), "utf8");

  expect(metrics).toHaveLength(2);
  expect(metrics[0]).toMatchObject({
    schema: "butler.context-compaction-metric.v1",
    sessionId: canonicalSessionId,
    trigger: "manual",
    status: "ok",
    snapshotId: snapshot.snapshot_id,
    rawTextStored: false,
  });
  expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0);
  expect(metrics[0].reductionRatio).toBeGreaterThan(0);
  expect(metrics[1]).toMatchObject({
    status: "failed",
    rawTextStored: false,
  });
  expect(metrics[1].diagnostics[0]).toStartWith("redacted_");
  expect(rawMetrics).not.toContain("사용자 목표");
  expect(rawMetrics).not.toContain("세부사항");
  expect(rawMetrics).not.toContain("SECRET raw diagnostic");
});
