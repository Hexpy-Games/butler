import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { createContextCompactor } from "../../packages/butler-agent/src/agent/btcc/agent-loop/context-compaction.ts";
import { SqliteContextCompactionStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/context-compaction-store.ts";
import { prepareBoundedModelContext } from "../../packages/butler-agent/src/agent/btcc/agent-loop/bounded-turn-context.ts";
import { validateBoundedProviderOrdinals, turnItemOrdinal } from "../../packages/butler-agent/src/agent/btcc/ports/bounded-provider-continuation.ts";
import type { ModelRoundMessage } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { runBtccAgentLoop } from "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { openAIBoundedConversationSerializedBytes } from "../../packages/butler-agent/src/integrations/providers/openai/conversation-items.ts";

function history(count: number): ModelRoundMessage[] {
  const messages: ModelRoundMessage[] = [{ role: "user", content: "Implement the requested change. Keep the API unchanged." }];
  for (let i = 0; i < count; i++) messages.push(
    { role: "assistant", content: `Inspect source ${i}`, toolCalls: [{ id: `c${i}`, name: "read_file", arguments: { path: `file${i}` }, rawArguments: JSON.stringify({ path: `file${i}` }) }] },
    { role: "tool", toolCallId: `c${i}`, content: JSON.stringify({ ok: true, output: { text: "source content ".repeat(150) } }) },
  );
  return messages.map((message, i) => ({ ...message, continuationItemId: `turn-item-${i}` }));
}

function contextDatabase() {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  return db;
}

describe("common BTCC rolling context", () => {
  test("steer received while compacting a final report restores its model and executor tool surface", async () => {
    const db = contextDatabase();
    try {
      let reporting = false, pendingSteer = false, steered = false, rounds = 0;
      const executed: string[] = [];
      const tools = [{ name: "read_file", description: "Read", parameters: { type: "object", properties: {} } }];
      const compactor = createContextCompactor({ turnId: "report-steer", store: new SqliteContextCompactionStore(db),
        summarize: async () => { pendingSteer = reporting && !steered; return "Read six source files; ready to report."; } });
      const result = await runBtccAgentLoop({ prompt: "Inspect the sources", tools,
        maxModelFacingBytes: 24000,
        contextCompactor: { prepare: (messages, bytes, options) => compactor.prepare(messages, reporting ? 8000 : bytes, options) },
        beforeModelRound: async () => {
          if (!pendingSteer) return [];
          pendingSteer = false; steered = true;
          return ["Read the last correction before reporting."];
        },
        afterToolBatch: () => { reporting = executed.length >= 6; return reporting ? "final_report" : "continue"; },
        reviewFinalCandidate: async () => ({ status: "accepted" }),
        modelRound: { async runRound(request) {
          rounds += 1;
          if (rounds === 8) { expect(request.tools).toEqual([]); return { text: "Corrected final report", toolCalls: [] }; }
          expect(request.tools).toEqual(tools);
          if (rounds === 7) expect(steered).toBe(true);
          return { toolCalls: [{ id: `read-${rounds}`, name: "read_file", arguments: {}, rawArguments: "{}" }] };
        } },
        executeTool: async (call) => { executed.push(call.id); return { text: "captured source ".repeat(120) }; },
      });
      expect(executed).toHaveLength(7);
      expect(result.finalText).toBe("Corrected final report");
    } finally { db.close(); }
  });
  test("live provider bookkeeping cannot exhaust a fitting serialized request", async () => {
    const db = contextDatabase();
    try {
      const messages = history(1);
      messages[1]!.providerData = { reasoning: "private provider bookkeeping ".repeat(40000) };
      const compactor = createContextCompactor({ turnId: "provider-data", store: new SqliteContextCompactionStore(db),
        summarize: async () => { throw new Error("actual request fits without compaction"); } });
      const result = await prepareBoundedModelContext({ messages, tools: [], roundId: "r",
        responseItemId: "turn-item-3", maxModelFacingBytes: 16000, compactor,
        statelessMessageBytes: openAIBoundedConversationSerializedBytes });
      expect(result.messages).toEqual(messages);
      expect(result.envelope!.modelFacingBytes).toBeLessThan(16000);
      expect(messages[1]!.providerData).toBeDefined();
    } finally { db.close(); }
  });
  test("small-model summary input budgets include previous summary and instructions", async () => {
    const db = contextDatabase();
    try {
      let summaries = 0;
      const compactor = createContextCompactor({ turnId: "small", store: new SqliteContextCompactionStore(db),
        summarySizing: () => ({ maxBytes: 2200, measure: (text) => Buffer.byteLength(text, "utf8") }),
        summarize: async ({ text }) => {
          summaries++;
          expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2200);
          expect(text).not.toContain("\uFFFD");
          return "이전 내용을 확인했습니다. ".repeat(15);
        } });
      await compactor.prepare(history(8), 16000);
      expect(summaries).toBeGreaterThan(1);
    } finally { db.close(); }
  });
  test("summary target overshoot is not a failure when the complete request fits", async () => {
    const db = contextDatabase();
    try {
      const compactor = createContextCompactor({ turnId: "soft-target", store: new SqliteContextCompactionStore(db),
        summarize: async () => "Verified the requested source; next implement the parser. ".repeat(70) });
      const result = await compactor.prepare(history(30), 16000);
      expect(result.identity).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(16000);
    } finally { db.close(); }
  });
  test("byte pressure compacts even when token capacity is still spacious", async () => {
    const db = contextDatabase();
    try {
      const compactor = createContextCompactor({ turnId: "bytes", store: new SqliteContextCompactionStore(db),
        summarize: async () => "Earlier source reads completed." });
      const result = await prepareBoundedModelContext({ messages: history(15), tools: [], roundId: "r",
        responseItemId: "turn-item-31", maxModelFacingBytes: 16000, compactor,
        contextSizing: { maxMessageBytes: 1_000_000, messageBytes: () => 1000 } });
      expect(result.contextProjection).toBeDefined();
      expect(result.envelope!.modelFacingBytes).toBeLessThan(16000);
    } finally { db.close(); }
  });
  test("a current-only request can use the capacity left unused by a summary", async () => {
    const db = contextDatabase();
    try {
      const compactor = createContextCompactor({ turnId: "current", store: new SqliteContextCompactionStore(db),
        summarize: async () => { throw new Error("nothing to summarize"); } });
      const messages: ModelRoundMessage[] = [{ role: "user", content: "a".repeat(900) }];
      expect((await compactor.prepare(messages, 1000)).messages).toEqual(messages);
    } finally { db.close(); }
  });
  test("the actual model/tool loop keeps executing once and applies steer arriving during summarization", async () => {
    const db = contextDatabase();
    try {
      let pendingSteer = false, didCompact = false, rounds = 0;
      const executions: string[] = [];
      const compactor = createContextCompactor({ turnId: "loop", store: new SqliteContextCompactionStore(db),
        summarize: async ({ text }) => { expect(text).toContain("captured source"); pendingSteer = true; didCompact = true; return "Earlier files inspected; continue the parser change."; } });
      const result = await runBtccAgentLoop({ prompt: "Fix only the parser", instructions: "Stable role and safety instructions",
        model: "test/model", maxModelFacingBytes: 18000, contextCompactor: compactor,
        beforeModelRound: async () => { if (!pendingSteer) return []; pendingSteer = false; return ["Preserve the exported API exactly."]; },
        tools: [{ name: "read_file", description: "Read", parameters: { type: "object", properties: {} } }],
        modelRound: { async runRound(request) {
          expect(request.instructions).toBe("Stable role and safety instructions");
          expect(Buffer.byteLength(JSON.stringify(request.messages))).toBeLessThan(18000);
          if (didCompact) expect(request.messages.some((m) => m.content.includes("Preserve the exported API exactly."))).toBe(true);
          if (rounds++ === 25) return { text: "Parser work finished", toolCalls: [] };
          return { toolCalls: [{ id: `read-${rounds}`, name: "read_file", arguments: {}, rawArguments: "{}" }] };
        } },
        executeTool: async (call) => { executions.push(call.id); return { text: "captured source ".repeat(120) }; },
      });
      expect(didCompact).toBe(true);
      expect(new Set(executions).size).toBe(25);
      expect(executions).toHaveLength(25);
      expect(result.finalText).toBe("Parser work finished");
    } finally { db.close(); }
  });
  test("hundreds of completed units become a stable summary while originals and newest pair remain", async () => {
    const db = contextDatabase();
    try {
      const store = new SqliteContextCompactionStore(db);
      let calls = 0;
      const summarize = async ({ text }: { text: string }) => { calls++; expect(Buffer.byteLength(text)).toBeLessThan(18000); return "Source inspection completed; preserve the API and implement the remaining requested change."; };
      const compactor = createContextCompactor({ turnId: "t", store, summarize });
      const messages = history(180), original = JSON.stringify(messages);
      const first = await compactor.prepare(messages, 24000);
      expect(Buffer.byteLength(JSON.stringify(first.messages))).toBeLessThan(24000);
      expect(JSON.stringify(messages)).toBe(original);
      expect(first.messages[0]).toEqual(messages[0]);
      expect(first.messages.slice(-2)).toEqual(messages.slice(-2));
      expect(calls).toBeGreaterThan(1);
      const priorCalls = calls;
      expect(await compactor.prepare(messages, 24000)).toEqual(first);
      expect(calls).toBe(priorCalls);
      const restored = createContextCompactor({ turnId: "t", store, summarize });
      expect(await restored.prepare(messages, 24000)).toEqual(first);
      expect(calls).toBe(priorCalls);
      validateBoundedProviderOrdinals(first.messages.map((m) => turnItemOrdinal(m.continuationItemId)), messages.length, -1);
      const envelope = await prepareBoundedModelContext({ messages, tools: [], roundId: "r", responseItemId: `turn-item-${messages.length}`, maxModelFacingBytes: 30000, compactor });
      expect(envelope.contextProjection?.projectionRevision).toBe("butler.rolling-context.v1");
    } finally { db.close(); }
  });

  test("new direction and an unanswered call remain exact; failed summary does not publish a boundary", async () => {
    const db = contextDatabase();
    try {
      const store = new SqliteContextCompactionStore(db);
      const messages = history(30);
      messages.push({ role: "user", content: "Stop changing the API. Only fix the parser.", requestSegmentKind: "current_user_request", continuationItemId: "turn-item-61" },
        { role: "assistant", content: "", toolCalls: [{ id: "pending", name: "edit_file", arguments: {}, rawArguments: "{}" }], continuationItemId: "turn-item-62" });
      const failing = createContextCompactor({ turnId: "t", store, summarize: async () => { throw new Error("provider unavailable"); } });
      await expect(failing.prepare(messages, 16000)).rejects.toThrow("provider unavailable");
      expect(store.load("t")).toEqual([]);
      const compactor = createContextCompactor({ turnId: "t", store, summarize: async () => "Inspected sources; parser repair remains." });
      const result = await compactor.prepare(messages, 16000);
      expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
      expect(result.messages.filter((m) => m.role === "tool").every((m) => result.messages.some((a) => a.toolCalls?.some((c) => c.id === m.toolCallId)))).toBe(true);
    } finally { db.close(); }
  });
});
