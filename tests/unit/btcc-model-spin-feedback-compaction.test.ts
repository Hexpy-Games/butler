import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteContextCompactionStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/context-compaction-store.ts";
import { createContextCompactor } from "../../packages/butler-agent/src/agent/btcc/agent-loop/context-compaction.ts";
import {
  ContextCapacityExceededError,
  summaryMaxOutputTokens,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/context-capacity.ts";
import { createGuidedContextSummarizer } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-context-summarizer.ts";
import { atomicUnits } from "../../packages/butler-agent/src/agent/btcc/agent-loop/bounded-turn-context.ts";
import { runBtccAgentLoop } from "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { runGuidedAgentLoopWithOperationalReport } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-report.ts";
import { runtimeFailureMessage } from "../../packages/butler-agent/src/agent/btcc/turn/turn-runtime-failure.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import type { ModelRoundMessage, ModelRoundRequest } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

function history(count: number, output = "source content ".repeat(150), prompt = "Implement the requested change."): ModelRoundMessage[] {
  const messages: ModelRoundMessage[] = [{ role: "user", content: prompt }];
  for (let i = 0; i < count; i++) messages.push(
    { role: "assistant", content: `Inspect source ${i}`, toolCalls: [{ id: `c${i}`, name: "read_file", arguments: { path: `file${i}` }, rawArguments: JSON.stringify({ path: `file${i}` }) }] },
    { role: "tool", toolCallId: `c${i}`, content: JSON.stringify({ ok: true, output: { text: output } }) },
  );
  return messages.map((message, i) => ({ ...message, continuationItemId: `turn-item-${i}` }));
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function store() {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  return new SqliteContextCompactionStore(db);
}

function contextLimitError(): ModelProviderRequestError {
  return new ModelProviderRequestError({
    code: "provider_context_limit_exceeded",
    message: "context length exceeded",
    retryable: false,
  });
}

describe("bounded deterministic compaction", () => {
  test("a summary that ignores its length is truncated deterministically after one call", async () => {
    let calls = 0;
    const compactor = createContextCompactor({ turnId: "long-summary", store: store(),
      summarize: async ({ text }) => {
        calls++;
        expect(text).not.toMatch(/within \d+ UTF-8 bytes/u);
        expect(text).toContain("Objective");
        return "The model wrote far too much. ".repeat(4000);
      } });
    const result = await compactor.prepare(history(60), 16000);
    expect(calls).toBe(1);
    expect(bytes(result.messages)).toBeLessThanOrEqual(16000);
    expect(result.identity).toBeDefined();
    expect(JSON.stringify(result.messages)).toContain("[summary truncated");
  });

  test("old tool outputs become retrievable placeholders before any summary", async () => {
    const compactor = createContextCompactor({ turnId: "prune", store: store(),
      summarize: async () => { throw new Error("pruning alone fits"); } });
    const messages = history(12);
    const result = await compactor.prepare(messages, 30000);
    expect(bytes(result.messages)).toBeLessThanOrEqual(30000);
    const tools = result.messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(12);
    expect(tools[0]!.content).toContain("read_operation_results");
    expect(tools[0]!.content).toContain("output_omitted");
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  test("a budget too small for header and summary skips summarization", async () => {
    const messages = history(30, "source content ".repeat(150), "p".repeat(9000));
    const required = bytes(atomicUnits(messages).flatMap((unit) => unit.mandatory ? unit.messages : []));
    const compactor = createContextCompactor({ turnId: "tiny", store: store(),
      summarize: async () => { throw new Error("summarize must be skipped"); } });
    const result = await compactor.prepare(messages, required + 600);
    expect(bytes(result.messages)).toBeLessThanOrEqual(required + 600);
    expect(result.messages[0]).toEqual(messages[0]);
  });

  test("a failed or empty summary falls back to deterministic pruning", async () => {
    const saved = store();
    for (const summarize of [async () => { throw new Error("provider unavailable"); }, async () => "  "]) {
      const compactor = createContextCompactor({ turnId: "fallback", store: saved, summarize });
      const result = await compactor.prepare(history(80), 16000);
      expect(bytes(result.messages)).toBeLessThanOrEqual(16000);
      expect(JSON.stringify(result.messages)).toContain("read_operation_results");
    }
    expect(saved.load("fallback")).toEqual([]);
  });

  test("summarizer input caps tool outputs and drops oldest items to fit", async () => {
    let seen = "";
    const compactor = createContextCompactor({ turnId: "input", store: store(),
      summarySizing: () => ({ maxBytes: 6000, measure: (text) => Buffer.byteLength(text, "utf8") }),
      summarize: async ({ text }) => { seen = text; return "Inspected sources."; } });
    await compactor.prepare(history(60, "x".repeat(9000)), 20000);
    expect(Buffer.byteLength(seen, "utf8")).toBeLessThanOrEqual(6000);
    expect(seen).not.toContain("x".repeat(2100));
  });

  test("CJK summaries are truncated at a UTF-8 boundary under token-scaled measurement", async () => {
    const compactor = createContextCompactor({ turnId: "cjk", store: store(),
      summarize: async () => "이전 작업에서 파서 변경을 확인했습니다. ".repeat(3000) });
    const measure = (messages: readonly ModelRoundMessage[]) => bytes(messages) * 1.5;
    const result = await compactor.prepare(history(60, "소스 내용 ".repeat(200)), 30000, measure);
    expect(measure(result.messages)).toBeLessThanOrEqual(30000);
    expect(JSON.stringify(result.messages)).not.toContain("�");
    expect(summaryMaxOutputTokens(12000, { maxOutputTokens: 128000 })).toBeLessThanOrEqual(3000);
    expect(summaryMaxOutputTokens(12000, undefined)).toBeLessThanOrEqual(3000);
    expect(summaryMaxOutputTokens(400_000, { maxOutputTokens: 8192 })).toBe(8192);
  });

  test("mandatory content that cannot fit escalates with actionable guidance", async () => {
    const compactor = createContextCompactor({ turnId: "mandatory", store: store(),
      summarize: async () => "unused" });
    const error = await compactor.prepare([{ role: "user", content: "a".repeat(20000) }], 16000)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextCapacityExceededError);
    expect((error as ContextCapacityExceededError).code).toBe("context_capacity_exceeded");
    const message = runtimeFailureMessage("please fix", { code: "context_capacity_exceeded", retryable: false });
    expect(message).toContain("larger context window");
    const korean = runtimeFailureMessage("고쳐 주세요", { code: "context_capacity_exceeded", retryable: false });
    expect(korean).toContain("컨텍스트");
  });

  test("a provider context-limit rejection compacts harder and retries the round once", async () => {
    const requests: ModelRoundRequest[] = [];
    const compactor = createContextCompactor({ turnId: "overflow", store: store(),
      summarize: async () => "Earlier reads done." });
    const result = await runBtccAgentLoop({
      prompt: "Summarize the sources", tools: [], maxModelFacingBytes: 60000,
      contextCompactor: compactor,
      modelRound: { async runRound(request) {
        requests.push(request);
        if (requests.length > 2) throw new Error("scripted model exceeded 2 rounds");
        if (requests.length === 1) throw contextLimitError();
        return { text: "Done", toolCalls: [] };
      } },
      executeTool: async () => ({}),
    }).catch((error: unknown) => error);
    expect(result).toEqual(expect.objectContaining({ finalText: "Done" }));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.roundId).not.toBe(requests[0]!.roundId);
  });

  test("a repeated provider context-limit rejection becomes the actionable escalation", async () => {
    let rounds = 0;
    const compactor = createContextCompactor({ turnId: "overflow-twice", store: store(),
      summarize: async () => "Earlier reads done." });
    const report = await runGuidedAgentLoopWithOperationalReport({
      options: {
        prompt: "Summarize", tools: [], contextCompactor: compactor,
        modelRound: { async runRound() {
          rounds++;
          if (rounds > 2) throw new Error("scripted model exceeded 2 rounds");
          throw contextLimitError();
        } },
        executeTool: async () => ({}),
      },
      parentSignal: new AbortController().signal,
      originalRequest: "Summarize",
      loadFacts: async () => ({ work: null, toolCalls: [], effects: [] }),
    });
    expect(report).toEqual({ failure: { code: "context_capacity_exceeded", retryable: false } });
    expect(rounds).toBe(2);
  });

  test("compaction model calls are recorded for accounting only", async () => {
    const events: string[] = [];
    const summarize = createGuidedContextSummarizer({
      turnId: "t", signal: new AbortController().signal, butlerData: "/tmp/none",
      resolveModelRef: () => "test/model",
      modelRound: {
        contextSizing: () => ({ maxOutputTokens: 64000, maxMessageBytes: 400000, messageBytes: () => 10 }),
        async runRound(request) {
          events.push(`round:${request.maxOutputTokens}`);
          return { text: "summary", toolCalls: [] };
        },
      },
      continuationBudget: {
        admitRequest: async ({ roundId }) => { events.push(`admit:${roundId.startsWith("btcc-summary-")}`); throw new Error("budget exhausted"); },
        recordOutput: async ({ outputBytes }) => { events.push(`output:${outputBytes}`); },
      },
    });
    expect(await summarize({ text: "history", maxOutputBytes: 8000, sourceDigest: "a".repeat(64) })).toBe("summary");
    expect(events[0]).toBe("admit:true");
    expect(events[1]).toBe("round:2000");
    expect(events[2]).toStartWith("output:");
  });
});
