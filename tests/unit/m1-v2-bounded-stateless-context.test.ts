import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoundedTurnContext } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/bounded-turn-context.ts";
import {
  createTurnContinuationBudgetState,
  selectTurnContinuationBudget,
  transitionTurnContinuationBudget,
  TurnContinuationBudgetExhaustedError,
} from "../../packages/butler-agent/src/agent/btcc/turn/continuation-budget.ts";
import type { ModelRoundMessage } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteGuidedTurnStateRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-guided-turn-state-repository.ts";
import { SqliteRuntimeOwnerRegistry } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { buildModelRoute, createModelRoutePort } from
  "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { modelRoundOutputBytes } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/bounded-turn-context.ts";
import { createProviderModelRoundPort } from
  "../../packages/butler-agent/src/integrations/providers/runtime.ts";
import { hydrateAcceptedModelRound, normalizeAcceptedModelRound } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-model-response-normalizer.ts";

const limits = {
  maxModelRequests: 120,
  maxToolRounds: 120,
  maxModelFacingBytes: 3_200,
  maxCumulativeModelFacingBytes: 300_000,
  maxOutputBytes: 50_000,
  maxElapsedMs: 60_000,
  maxIdleMs: 30_000,
};

function longHistory(rounds = 100): ModelRoundMessage[] {
  const messages: ModelRoundMessage[] = [{
    role: "user",
    content: "CURRENT REQUEST active Work W-1 required ref source:current",
  }];
  for (let index = 0; index < rounds; index += 1) {
    const id = `call-${index}`;
    messages.push({
      role: "assistant",
      content: `assistant-${index}-${"A".repeat(80)}`,
      toolCalls: [{ id, name: "read_file", arguments: { index }, rawArguments: JSON.stringify({ index }) }],
    });
    messages.push({
      role: "tool",
      toolCallId: id,
      name: "read_file",
      content: JSON.stringify({ validation: index, body: "T".repeat(120) }),
    });
    messages.push({ role: "user", content: `review-${index}` });
  }
  return messages;
}

test("100-round user assistant and tool history produces one bounded deterministic carrier", () => {
  const history = longHistory();
  const first = buildBoundedTurnContext(history, limits.maxModelFacingBytes);
  const second = buildBoundedTurnContext(history, limits.maxModelFacingBytes);
  expect(first.modelFacingBytes).toBeLessThanOrEqual(limits.maxModelFacingBytes);
  expect(first).toEqual(second);
  expect(first.evictedAtomicUnits).toBeGreaterThan(180);
  expect(first.messages[0]?.content).toContain("CURRENT REQUEST");
  expect(first.messages.at(-1)?.content).toBe("review-99");
  expect(JSON.stringify(first.messages)).not.toContain("assistant-0-");
  expect(JSON.stringify(first.messages)).toContain("assistant-99-");
});

test("tool calls and results are admitted or evicted as indivisible atomic units", () => {
  const bounded = buildBoundedTurnContext(longHistory(30), 1_800);
  const calls = new Set(bounded.messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [],
  ));
  const results = new Set(bounded.messages.flatMap((message) =>
    message.role === "tool" && message.toolCallId ? [message.toolCallId] : [],
  ));
  expect(calls).toEqual(results);
});

test("orphaned or duplicate tool results fail closed before provider admission", () => {
  expect(() => buildBoundedTurnContext([
    { role: "user", content: "current" },
    { role: "tool", content: "orphan", toolCallId: "missing", name: "read_file" },
  ], 1_000)).toThrow("turn_tool_protocol_orphan");
  expect(() => buildBoundedTurnContext([
    { role: "user", content: "current" },
    { role: "assistant", content: "", toolCalls: [{
      id: "call", name: "read_file", arguments: {}, rawArguments: "{}",
    }] },
    { role: "tool", content: "one", toolCallId: "call", name: "read_file" },
    { role: "tool", content: "two", toolCallId: "call", name: "read_file" },
  ], 1_000)).toThrow("turn_tool_protocol_orphan");
});

test("an incomplete newest tool pair is mandatory and overflow remains explicit", () => {
  const messages = longHistory(3);
  messages.push({
    role: "assistant", content: "open", toolCalls: [{
      id: "open-call", name: "read_file", arguments: {}, rawArguments: "{}",
    }],
  });
  const bounded = buildBoundedTurnContext(messages, 64);
  expect(bounded.modelFacingBytes).toBeGreaterThan(64);
  expect(JSON.stringify(bounded.messages)).toContain("open-call");
});

test("durable budget admissions are monotonic idempotent and terminal exactly once", () => {
  let state = createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs: 1_000 });
  const event = { kind: "admit_request" as const, roundId: "round-1", requestDigest: "a".repeat(64), modelFacingBytes: 900 };
  state = transitionTurnContinuationBudget(state, event, 1_001);
  state = transitionTurnContinuationBudget(state, event, 1_002);
  expect(state.admittedRequests).toHaveLength(1);
  state = transitionTurnContinuationBudget(state, { kind: "record_tool_round", roundId: "tool-1" }, 1_003);
  state = transitionTurnContinuationBudget(state, { kind: "record_tool_round", roundId: "tool-1" }, 1_004);
  expect(state.completedToolRounds).toEqual(["tool-1"]);
  let terminal: TurnContinuationBudgetExhaustedError | undefined;
  try {
    transitionTurnContinuationBudget(state, { ...event, roundId: "round-over", modelFacingBytes: limits.maxModelFacingBytes + 1 }, 1_005);
  } catch (error) {
    terminal = error as TurnContinuationBudgetExhaustedError;
  }
  expect(terminal?.state.terminal).toMatchObject({
    code: "turn_continuation_budget_exhausted", reason: "model_facing_bytes",
  });
  expect(() => transitionTurnContinuationBudget(terminal!.state, event, 1_006))
    .toThrow(TurnContinuationBudgetExhaustedError);
});

test("SQLite atomically retains terminal exhaustion across repository restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-continuation-budget-"));
  const dbPath = join(root, "btcc.sqlite");
  let db = new Database(dbPath);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  let owner = sqliteOwner(db, "owner-1");
  let turns = new SqliteGuidedTurnStateRepository(db, owner);
  const state = createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs: 1_000 });
  insertBudgetTurn(db, state);
  const turn = await turns.findTurn("turn");
  const claim = await turns.acquireStateExecutionClaim(turn!);
  await expect(turns.transitionContinuationBudget!({
    turnId: "turn", expectedRevision: 0, executionFence: 0,
    claimId: claim.claimId, nowMs: 1_001,
    event: {
      kind: "admit_request", roundId: "overflow", requestDigest: "d".repeat(64),
      modelFacingBytes: limits.maxModelFacingBytes + 1,
    },
  })).rejects.toThrow("model_facing_bytes");
  owner.close();
  db.close();

  db = new Database(dbPath);
  owner = sqliteOwner(db, "owner-2");
  turns = new SqliteGuidedTurnStateRepository(db, owner);
  expect((await turns.findTurn("turn"))?.continuationBudget?.terminal).toMatchObject({
    code: "turn_continuation_budget_exhausted", reason: "model_facing_bytes",
  });
  owner.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("SQLite restart preserves admitted request tool-round and output accounting", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-continuation-progress-"));
  const dbPath = join(root, "btcc.sqlite");
  let db = new Database(dbPath);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  let owner = sqliteOwner(db, "progress-1");
  let turns = new SqliteGuidedTurnStateRepository(db, owner);
  insertBudgetTurn(db, createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs: 1_000 }));
  const turn = await turns.findTurn("turn");
  const claim = await turns.acquireStateExecutionClaim(turn!);
  const common = {
    turnId: "turn", expectedRevision: 0, executionFence: 0,
    claimId: claim.claimId,
  };
  await turns.transitionContinuationBudget!({
    ...common, nowMs: 1_001,
    event: { kind: "admit_request", roundId: "round", requestDigest: "f".repeat(64), modelFacingBytes: 700 },
  });
  await turns.transitionContinuationBudget!({
    ...common, nowMs: 1_002,
    event: { kind: "record_tool_round", roundId: "tool-round" },
  });
  await turns.transitionContinuationBudget!({
    ...common, nowMs: 1_003,
    event: { kind: "record_output", roundId: "round", outputBytes: 321 },
  });
  owner.close();
  db.close();

  db = new Database(dbPath);
  owner = sqliteOwner(db, "progress-2");
  turns = new SqliteGuidedTurnStateRepository(db, owner);
  expect((await turns.findTurn("turn"))?.continuationBudget).toMatchObject({
    admittedRequests: [{ roundId: "round", modelFacingBytes: 700 }],
    completedToolRounds: ["tool-round"], completedOutputRounds: ["round"],
    consumedOutputBytes: 321, terminal: null,
    consumedModelFacingBytes: 700,
  });
  owner.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("retry reuses exact admission while changed fallback input fails closed", () => {
  let state = createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs: 1_000 });
  state = transitionTurnContinuationBudget(state, {
    kind: "admit_request", roundId: "same-round", requestDigest: "b".repeat(64), modelFacingBytes: 800,
  }, 1_001);
  expect(transitionTurnContinuationBudget(state, {
    kind: "admit_request", roundId: "same-round", requestDigest: "b".repeat(64), modelFacingBytes: 800,
  }, 1_002).admittedRequests).toHaveLength(1);
  expect(() => transitionTurnContinuationBudget(state, {
    kind: "admit_request", roundId: "same-round", requestDigest: "c".repeat(64), modelFacingBytes: 800,
  }, 1_003)).toThrow("admission_changed");
});

test("distinct requests consume the cumulative prompt admission budget", () => {
  const cumulativeLimits = { ...limits, maxCumulativeModelFacingBytes: 1_000 };
  let state = createTurnContinuationBudgetState({
    turnId: "turn", limits: cumulativeLimits, nowMs: 1_000,
  });
  state = transitionTurnContinuationBudget(state, {
    kind: "admit_request", roundId: "round-1",
    requestDigest: "1".repeat(64), modelFacingBytes: 600,
  }, 1_001);
  expect(state.consumedModelFacingBytes).toBe(600);
  expect(() => transitionTurnContinuationBudget(state, {
    kind: "admit_request", roundId: "round-2",
    requestDigest: "2".repeat(64), modelFacingBytes: 500,
  }, 1_002)).toThrow("max_cumulative_model_facing_bytes");
});

test("default-off selection preserves legacy and enabled config rejects unsafe ceilings", () => {
  expect(selectTurnContinuationBudget({})).toBeNull();
  expect(selectTurnContinuationBudget({ BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT: "off" })).toBeNull();
  expect(() => selectTurnContinuationBudget({
    BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT: "on",
    BUTLER_M1_V2_CONTINUATION_MAX_MODEL_REQUESTS: "201",
  })).toThrow("unsafe_turn_continuation_limit:maxModelRequests");
});

test("production composition reaches the official serializer with bounded multi-round bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-bounded-production-"));
  const previous = {
    bounded: process.env.BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT,
    maxBytes: process.env.BUTLER_M1_V2_CONTINUATION_MAX_MODEL_FACING_BYTES,
    surface: process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE,
    replay: process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY,
    base: process.env.OPENAI_BASE_URL,
  };
  const originalFetch = globalThis.fetch;
  process.env.BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT = "on";
  process.env.BUTLER_M1_V2_CONTINUATION_MAX_MODEL_FACING_BYTES = "18000";
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = "on";
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = "on";
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const index = responseIndex++;
    const item = index < 8 ? {
      type: "function_call", call_id: `call-${index}`,
      name: "web_search", arguments: JSON.stringify({ query: index }),
    } : {
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: "bounded production final" }],
    };
    const completed = {
      id: index < 8 ? `response-${index}` : "response-final",
      model: "gpt-5.6-sol", output: [item],
    };
    return new Response([
      `data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const bindings = new SessionBindingStore(join(root, "sessions.sqlite"), "ephemeral");
  bindings.upsert({
    sessionId: "session", role: "butler", workspacePath: root,
    runtimeAdapterId: "native", modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol", transportBindings: [],
    metadata: { accessMode: "read_only", runtimePolicy: { trackingMode: "none" } },
  });
  const composition = createProductionBtccComposition({
    butlerHome: root, butlerData: root, appMessageDbPath: join(root, "app.sqlite"),
    ownerId: "bounded-production", sessionBindings: bindings,
    modelRound: {
      runRound: (request) => runOpenAIModelRound(request, {
        authorization: `Bearer x.${Buffer.from(JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
        })).toString("base64url")}.x`,
        mode: "codex_subscription",
      }),
    },
  });
  try {
    const result = await composition.btcc.runTurn({
      turnId: "turn", sessionId: "session", eventId: "event",
      transport: "app", accountId: "local", peer: { kind: "dm", id: "session" },
      sender: { id: "user" },
      message: { id: "message", content: "현재 요청과 active Work를 유지하세요.", timestamp: new Date(1_000).toISOString() },
      trigger: { kind: "user_message" },
      route: { role: "butler", workspacePath: root },
    });
    expect(result).toMatchObject({ kind: "delivered", content: "bounded production final" });
    expect(bodies).toHaveLength(9);
    expect(bodies.every((body) => Buffer.byteLength(JSON.stringify(body)) < 24_000)).toBe(true);
    expect(JSON.stringify(bodies.at(-1))).toContain("현재 요청");
    expect(JSON.stringify(bodies.at(-1))).not.toContain("call-0");
    expect(JSON.stringify(bodies.at(-1))).toContain("call-7");
    const evidence = new Database(join(root, "app.sqlite"), { readonly: true });
    const turnRow = evidence.query<{
      model_selection_json: string; route_state_json: string;
    }, [string]>(`
      SELECT model_selection_json, route_state_json FROM btcc_turns WHERE turn_id = ?
    `).get("turn")!;
    expect(JSON.parse(turnRow.model_selection_json)).not.toHaveProperty("modelRoute");
    expect(JSON.parse(turnRow.route_state_json)).toHaveProperty("routeDigest");
    const acceptances = evidence.query<{ normalized_response_json: string }, []>(`
      SELECT normalized_response_json FROM btcc_model_round_acceptances
    `).all();
    expect(acceptances.length).toBeGreaterThan(0);
    expect(acceptances.every((row) =>
      !row.normalized_response_json.includes("statelessInput") &&
      !row.normalized_response_json.includes("providerData"),
    )).toBe(true);
    evidence.close();
  } finally {
    await composition.host.close();
    bindings.close();
    globalThis.fetch = originalFetch;
    restoreEnv("BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT", previous.bounded);
    restoreEnv("BUTLER_M1_V2_CONTINUATION_MAX_MODEL_FACING_BYTES", previous.maxBytes);
    restoreEnv("BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE", previous.surface);
    restoreEnv("BUTLER_M1_V2_EXACT_ONCE_REPLAY", previous.replay);
    restoreEnv("OPENAI_BASE_URL", previous.base);
    rmSync(root, { recursive: true, force: true });
  }
});

test("model route retry and fallback cannot replace the admitted bounded carrier", async () => {
  const seen: Array<{ digest: string | undefined; bytes: number | undefined; continuation: unknown }> = [];
  let calls = 0;
  const routed = createModelRoutePort({
    base: { async runRound(request) {
      seen.push({
        digest: request.boundedContinuation?.requestDigest,
        bytes: request.boundedContinuation?.modelFacingBytes,
        continuation: request.continuation,
      });
      calls += 1;
      if (calls < 3) throw new ModelProviderRequestError({
        provider: "openai", api: "responses", code: "provider_unavailable",
        message: "retry", retryable: true, statusCode: 503,
      });
      return { text: "done", toolCalls: [] };
    } },
    turnId: "turn",
    route: buildModelRoute({
      primaryModelRef: "openai/primary", backupModelRefs: ["openai/backup"],
      reasoningEffort: "medium", catalogGeneration: "test", retryCeiling: 2,
    }),
    onRouteEvent: async () => ({ status: "recorded" }),
  });
  await routed.runRound({
    roundId: "round", model: "openai/primary", messages: [{ role: "user", content: "bounded" }],
    tools: [], continuation: { full: "legacy" },
    boundedContinuation: {
      schemaVersion: "butler.turn-context-envelope.v1",
      modelFacingBytes: 100, requestDigest: "e".repeat(64),
      responseItemId: "response-item-route",
      admitProviderBody: async () => {},
    },
  });
  expect(seen.map((item) => item.digest)).toEqual(["e".repeat(64), "e".repeat(64), "e".repeat(64)]);
  expect(seen.map((item) => item.bytes)).toEqual([100, 100, 100]);
  expect(seen.at(-1)?.continuation).toBeUndefined();
});

test("official Responses sends a newly admitted tool result after older units are evicted", async () => {
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const index = responseIndex++;
    return Response.json(index < 2 ? {
      id: `response-${index}`, model: "gpt-5.6-sol", output: [{
        type: "function_call", call_id: `call-${index}`,
        name: "read_file", arguments: JSON.stringify({ index }),
      }],
    } : {
      id: "response-final", model: "gpt-5.6-sol", output: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      }],
    });
  }) as typeof fetch;
  const envelope = {
    schemaVersion: "butler.turn-context-envelope.v1" as const,
    modelFacingBytes: 1_000, requestDigest: "a".repeat(64),
    responseItemId: "response-item-eviction",
    admitProviderBody: async () => {},
  };
  try {
    const first = await runOpenAIModelRound({
      roundId: "r0", model: "openai/gpt-5.6-sol",
      messages: [{ role: "user", content: "CURRENT" }], tools: [],
      boundedContinuation: envelope,
    }, { authorization: "Bearer test", mode: "api_key" });
    const second = await runOpenAIModelRound({
      roundId: "r1", model: "openai/gpt-5.6-sol", continuation: first.continuation,
      messages: [
        { role: "user", content: "CURRENT" },
        { role: "assistant", content: "", toolCalls: [{
          id: "call-0", name: "read_file", arguments: { index: 0 }, rawArguments: "{\"index\":0}",
        }] },
        { role: "tool", name: "read_file", toolCallId: "call-0", content: "OLD-RESULT" },
      ], tools: [], boundedContinuation: envelope,
    }, { authorization: "Bearer test", mode: "api_key" });
    await runOpenAIModelRound({
      roundId: "r2", model: "openai/gpt-5.6-sol", continuation: second.continuation,
      messages: [
        { role: "user", content: "CURRENT" },
        { role: "assistant", content: "", toolCalls: [{
          id: "call-1", name: "read_file", arguments: { index: 1 }, rawArguments: "{\"index\":1}",
        }] },
        { role: "tool", name: "read_file", toolCallId: "call-1", content: "NEW-RESULT" },
      ], tools: [], boundedContinuation: envelope,
    }, { authorization: "Bearer test", mode: "api_key" });
    expect(JSON.stringify(bodies[1])).toContain("OLD-RESULT");
    expect(JSON.stringify(bodies[2]).match(/NEW-RESULT/g)).toHaveLength(1);
    expect(bodies[2]).toMatchObject({ previous_response_id: "response-1" });
    expect(second.continuation).not.toHaveProperty("statelessInput");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
  }
});

test("official Responses does not resend provider assistant text paired with a function call", async () => {
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    call += 1;
    return Response.json(call === 1 ? {
      id: "response-text-call", model: "gpt-5.6-sol", output: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "PROVIDER-TEXT" }],
      }, {
        type: "function_call", call_id: "text-call", name: "read_file", arguments: "{}",
      }],
    } : { id: "response-final", model: "gpt-5.6-sol", output: [] });
  }) as unknown as typeof fetch;
  const envelope = {
    schemaVersion: "butler.turn-context-envelope.v1" as const,
    modelFacingBytes: 1_000, requestDigest: "f".repeat(64),
    responseItemId: "response-item-text-call",
    admitProviderBody: async () => {},
  };
  try {
    const first = await runOpenAIModelRound({
      roundId: "first", model: "openai/gpt-5.6-sol",
      messages: [{ role: "user", content: "CURRENT" }], tools: [],
      boundedContinuation: envelope,
    }, { authorization: "Bearer test", mode: "api_key" });
    await runOpenAIModelRound({
      roundId: "second", model: "openai/gpt-5.6-sol", continuation: first.continuation,
      messages: [
        { role: "user", content: "CURRENT" },
        { role: "assistant", content: "PROVIDER-TEXT",
          continuationItemId: "response-item-text-call", toolCalls: [{
          id: "text-call", name: "read_file", arguments: {}, rawArguments: "{}",
        }] },
        { role: "tool", name: "read_file", toolCallId: "text-call", content: "NEW-TOOL" },
      ], tools: [], boundedContinuation: envelope,
    }, { authorization: "Bearer test", mode: "api_key" });
    expect(JSON.stringify(bodies[1]).match(/NEW-TOOL/g)).toHaveLength(1);
    expect(JSON.stringify(bodies[1])).not.toContain("PROVIDER-TEXT");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
  }
});

test("text-only assistant and correction identities remain distinct across eviction", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-bounded-text-identities-"));
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    call += 1;
    return Response.json({
      id: `text-response-${call}`, model: "gpt-5.6-sol", output: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "SAME-ASSISTANT" }],
      }],
    });
  }) as unknown as typeof fetch;
  const envelope = {
    schemaVersion: "butler.turn-context-envelope.v1" as const,
    modelFacingBytes: 1_000, requestDigest: "8".repeat(64),
    responseItemId: "response-text-1",
    admitProviderBody: async () => {},
  };
  try {
    const first = await runOpenAIModelRound({
      roundId: "r1", model: "openai/gpt-5.6-sol", butlerData: root,
      messages: [{ role: "user", content: "CURRENT" }], tools: [],
      boundedContinuation: envelope,
    }, { authorization: "Bearer test", mode: "api_key" });
    const second = await runOpenAIModelRound({
      roundId: "r2", model: "openai/gpt-5.6-sol", butlerData: root,
      continuation: first.continuation, tools: [],
      messages: [
        { role: "user", content: "CURRENT" },
        { role: "assistant", content: "SAME-ASSISTANT", continuationItemId: "response-text-1" },
        { role: "user", content: "SAME-CORRECTION", continuationItemId: "correction-one" },
      ],
      boundedContinuation: { ...envelope, responseItemId: "response-text-2" },
    }, { authorization: "Bearer test", mode: "api_key" });
    await runOpenAIModelRound({
      roundId: "r3", model: "openai/gpt-5.6-sol", butlerData: root,
      continuation: second.continuation, tools: [],
      messages: [
        { role: "user", content: "CURRENT" },
        { role: "assistant", content: "SAME-ASSISTANT", continuationItemId: "response-text-2" },
        { role: "user", content: "SAME-CORRECTION", continuationItemId: "correction-two" },
      ],
      boundedContinuation: { ...envelope, responseItemId: "response-text-3" },
    }, { authorization: "Bearer test", mode: "api_key" });
    expect(JSON.stringify(bodies[1]).match(/SAME-CORRECTION/g)).toHaveLength(1);
    expect(JSON.stringify(bodies[1])).not.toContain("SAME-ASSISTANT");
    expect(JSON.stringify(bodies[2]).match(/SAME-CORRECTION/g)).toHaveLength(1);
    expect(JSON.stringify(bodies[2])).not.toContain("SAME-ASSISTANT");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
    rmSync(root, { recursive: true, force: true });
  }
});

test("route fallback official body preserves the admitted bounded carrier", async () => {
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  let fallbackBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    fallbackBody = JSON.parse(String(init?.body));
    return Response.json({
      id: "fallback-response", model: "backup", output: [{
        type: "message", role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      }],
    });
  }) as typeof fetch;
  const routed = createModelRoutePort({
    base: { async runRound(request) {
      if (request.model === "openai/gpt-5.6-sol") throw new ModelProviderRequestError({
        provider: "openai", api: "responses", code: "provider_unavailable",
        message: "fallback", retryable: false, statusCode: 503,
      });
      return runOpenAIModelRound(request, {
        authorization: "Bearer test", mode: "api_key",
      });
    } },
    turnId: "turn",
    route: buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: ["openai/gpt-5.6-luna"],
      reasoningEffort: "medium", catalogGeneration: "test", retryCeiling: 1,
    }),
    onRouteEvent: async () => ({ status: "recorded" }),
  });
  try {
    await routed.runRound({
      roundId: "round", model: "openai/gpt-5.6-sol", continuation: {
        provider: "openai", responseId: "old-response",
        sent: { toolMessages: 8, userMessages: 8 },
        statelessInput: [{ role: "user", content: [{ type: "input_text", text: "UNBOUNDED-OLD" }] }],
        statelessManifest: [],
      },
      messages: [
        { role: "user", content: "CURRENT-REQUEST" },
        { role: "assistant", content: "LATEST-PROTOCOL",
          continuationItemId: "fallback-assistant", toolCalls: [{
          id: "latest-call", name: "read_file", arguments: {}, rawArguments: "{}",
        }] },
        { role: "tool", name: "read_file", toolCallId: "latest-call", content: "LATEST-REF" },
      ],
      tools: [], boundedContinuation: {
        schemaVersion: "butler.turn-context-envelope.v1",
        modelFacingBytes: 1_000, requestDigest: "b".repeat(64),
        responseItemId: "response-item-fallback",
        admitProviderBody: async () => {},
      },
    });
    const serialized = JSON.stringify(fallbackBody);
    expect(serialized).toContain("CURRENT-REQUEST");
    expect(serialized).toContain("LATEST-PROTOCOL");
    expect(serialized).toContain("LATEST-REF");
    expect(serialized).not.toContain("UNBOUNDED-OLD");
    expect(fallbackBody).not.toHaveProperty("previous_response_id");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
  }
});

test("exact official attachment bytes terminalize durably before fetch", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-bounded-attachment-"));
  const dbPath = join(root, "app.sqlite");
  const imagePath = join(root, "large.png");
  await Bun.write(imagePath, Buffer.alloc(160_000, 7));
  const prior = {
    flag: process.env.BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT,
    max: process.env.BUTLER_M1_V2_CONTINUATION_MAX_MODEL_FACING_BYTES,
    base: process.env.OPENAI_BASE_URL,
  };
  const originalFetch = globalThis.fetch;
  process.env.BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT = "on";
  process.env.BUTLER_M1_V2_CONTINUATION_MAX_MODEL_FACING_BYTES = "10000";
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return Response.json({ id: "unexpected", model: "gpt-5.6-sol", output: [] });
  }) as unknown as typeof fetch;
  const bindings = new SessionBindingStore(join(root, "sessions.sqlite"), "ephemeral");
  bindings.upsert({
    sessionId: "session", role: "butler", workspacePath: root,
    runtimeAdapterId: "native", modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol", transportBindings: [],
    metadata: { accessMode: "read_only", runtimePolicy: { trackingMode: "none" } },
  });
  const composition = createProductionBtccComposition({
    butlerHome: root, butlerData: root, appMessageDbPath: dbPath,
    ownerId: "attachment-cap", sessionBindings: bindings,
    modelRound: { runRound: (request) => runOpenAIModelRound(request, {
      authorization: "Bearer test", mode: "api_key",
    }) },
  });
  try {
    await composition.btcc.runTurn({
      turnId: "turn-cap", sessionId: "session", eventId: "event-cap",
      transport: "app", accountId: "local", peer: { kind: "dm", id: "session" },
      sender: { id: "user" }, message: {
        id: "message-cap", content: "inspect image", timestamp: new Date(1_000).toISOString(),
        attachments: [{ id: "image", kind: "image", mimeType: "image/png", localPath: imagePath }],
      },
      trigger: { kind: "user_message" }, route: { role: "butler", workspacePath: root },
    });
    expect(fetches).toBe(0);
    const evidence = new Database(dbPath, { readonly: true });
    const persisted = evidence.query<{ continuation_budget_json: string }, [string]>(
      "SELECT continuation_budget_json FROM btcc_turns WHERE turn_id = ?",
    ).get("turn-cap");
    evidence.close();
    expect(JSON.parse(persisted!.continuation_budget_json)).toMatchObject({
      terminal: { reason: "model_facing_bytes" },
    });
  } finally {
    await composition.host.close();
    bindings.close();
    globalThis.fetch = originalFetch;
    restoreEnv("BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT", prior.flag);
    restoreEnv("BUTLER_M1_V2_CONTINUATION_MAX_MODEL_FACING_BYTES", prior.max);
    restoreEnv("OPENAI_BASE_URL", prior.base);
    rmSync(root, { recursive: true, force: true });
  }
});

test("output accounting excludes provider raw payload and providerData", () => {
  expect(modelRoundOutputBytes({
    text: "visible", toolCalls: [{
      id: "call", name: "read_file", arguments: {}, rawArguments: "{}",
    }],
    assistantMessage: {
      role: "assistant", content: "visible", toolCalls: [{
        id: "call", name: "read_file", arguments: {}, rawArguments: "{}",
      }], providerData: { hidden: "H".repeat(50_000) },
    },
    raw: { hidden: "R".repeat(50_000) },
  })).toBeLessThan(500);
});

test("provider-neutral bounded route fails closed before an unsupported serializer", async () => {
  await expect(createProviderModelRoundPort().runRound({
    roundId: "round", model: "google/gemini-2.5-pro",
    messages: [{ role: "user", content: "CURRENT" }], tools: [],
    boundedContinuation: {
      schemaVersion: "butler.turn-context-envelope.v1",
      modelFacingBytes: 100, requestDigest: "c".repeat(64),
      responseItemId: "response-item-unsupported",
      admitProviderBody: async () => {
        throw new Error("unsupported provider must not attempt admission");
      },
    },
  })).rejects.toThrow("bounded_provider_serializer_unsupported:google");
});

test("bounded identity overflow fails before official provider dispatch", async () => {
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return Response.json({ id: "unexpected", model: "gpt-5.6-sol", output: [] });
  }) as unknown as typeof fetch;
  try {
    await expect(runOpenAIModelRound({
      roundId: "overflow", model: "openai/gpt-5.6-sol", tools: [],
      messages: [
        { role: "user", content: "CURRENT" },
        ...Array.from({ length: 193 }, (_, index) => ({
          role: "user" as const,
          content: `bounded-${index}`,
          continuationItemId: `turn-item-${index}`,
        })),
      ],
      boundedContinuation: {
        schemaVersion: "butler.turn-context-envelope.v1",
        modelFacingBytes: 10_000,
        requestDigest: "d".repeat(64),
        responseItemId: "response-item-overflow",
        admitProviderBody: async () => {},
      },
    }, { authorization: "Bearer test", mode: "api_key" }))
      .rejects.toThrow("bounded_continuation_item_identity_invalid");
    expect(fetches).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
  }
});

test("bounded continuation identities stay finite structural and privacy safe for 100 rounds", async () => {
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  let responseIndex = 0;
  globalThis.fetch = (async () => Response.json({
    id: `response-${responseIndex}`,
    model: "gpt-5.6-sol",
    output: [{
      type: "function_call", call_id: `call-${responseIndex}`,
      name: "read_file", arguments: "{}",
    }],
  })) as unknown as typeof fetch;
  const envelope = {
    schemaVersion: "butler.turn-context-envelope.v1" as const,
    modelFacingBytes: 2_000, requestDigest: "9".repeat(64),
    responseItemId: "response-item-long",
    admitProviderBody: async () => {},
  };
  let continuation: unknown;
  try {
    for (responseIndex = 0; responseIndex < 100; responseIndex += 1) {
      const prior = Math.max(0, responseIndex - 1);
      const secret = `PRIVATE-CONTENT-${responseIndex}-${"S".repeat(80)}`;
      const result = await runOpenAIModelRound({
        roundId: `round-${responseIndex}`, model: "openai/gpt-5.6-sol",
        continuation,
        messages: responseIndex === 0
          ? [{ role: "user", content: "CURRENT-SECRET" }]
          : [
              { role: "user", content: "CURRENT-SECRET" },
              { role: "assistant", content: secret,
                continuationItemId: `response-item-${prior}`, toolCalls: [{
                id: `call-${prior}`, name: "read_file", arguments: {}, rawArguments: "{}",
              }] },
              { role: "tool", name: "read_file", toolCallId: `call-${prior}`, content: secret },
            ],
        tools: [], boundedContinuation: {
          ...envelope, responseItemId: `response-item-${responseIndex}`,
        },
      }, { authorization: "Bearer test", mode: "api_key" });
      const accepted = normalizeAcceptedModelRound(result);
      continuation = hydrateAcceptedModelRound(JSON.stringify(accepted), null).continuation;
      const serialized = JSON.stringify(continuation);
      const keys = (continuation as { boundedItemKeys: string[] }).boundedItemKeys;
      expect(keys.length).toBeLessThanOrEqual(5);
      expect(serialized).not.toContain("PRIVATE-CONTENT");
      expect(serialized).not.toMatch(/[a-f0-9]{64}/);
      expect(serialized.length).toBeLessThan(1_000);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
  }
});

test("SQLite acceptance allowlists bounded continuation and rejects private injection", () => {
  const normalized = normalizeAcceptedModelRound({
    text: "visible", toolCalls: [], assistantMessage: {
      role: "assistant", content: "visible", providerData: { secret: "SECRET-PROVIDER" },
    },
    continuation: {
      provider: "openai", responseId: "response", boundedItemKeys: ["current-user:0"],
    }, raw: { secret: "SECRET-RAW-RESPONSE" },
  });
  expect(normalized.continuation).toEqual({
    provider: "openai", responseId: "response", boundedItemKeys: ["current-user:0"],
  });
  expect(JSON.stringify(normalized)).not.toContain("SECRET");
  expect(hydrateAcceptedModelRound(JSON.stringify(normalized), null).continuation)
    .toEqual(normalized.continuation);
  expect(() => normalizeAcceptedModelRound({
    toolCalls: [], continuation: {
      provider: "openai", responseId: "response", boundedItemKeys: ["current-user:0"],
      statelessInput: [{ secret: "SECRET-TRANSCRIPT" }],
      statelessManifest: [{ secret: "SECRET-MANIFEST" }],
      providerPrivate: { raw: "SECRET-RAW" }, sent: { toolMessages: 999, userMessages: 999 },
    },
  })).toThrow("BTCC bounded continuation has unknown private fields");
  expect(() => normalizeAcceptedModelRound({
    toolCalls: [], continuation: {
      provider: "openai", responseId: "response",
      boundedItemKeys: Array.from({ length: 257 }, (_, index) => `current-user:${index}`),
    },
  })).toThrow("bounded_continuation_item_identity_invalid");
});

test("flag-off actual OpenAI serializer body is byte-identical to the legacy contract", async () => {
  const absent = await captureFlagOffSerializer(undefined);
  const explicitOff = await captureFlagOffSerializer("off");
  expect(Buffer.from(JSON.stringify(explicitOff))).toEqual(Buffer.from(JSON.stringify(absent)));
  expect(explicitOff).not.toHaveProperty("boundedContinuation");
});

test("flag-off does not create private identity state and control does not import telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-bounded-flag-off-key-"));
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  globalThis.fetch = (async () => Response.json({
    id: "response", model: "gpt-5.6-sol", output: [],
  })) as unknown as typeof fetch;
  try {
    await runOpenAIModelRound({
      roundId: "round", model: "openai/gpt-5.6-sol", butlerData: root,
      messages: [{ role: "user", content: "flag off" }], tools: [],
    }, { authorization: "Bearer test", mode: "api_key" });
    expect(existsSync(join(root, "metrics", ".m1-v2-attribution.key"))).toBe(false);
    const source = readFileSync(join(
      process.cwd(),
      "packages/butler-agent/src/integrations/providers/openai/conversation-items.ts",
    ), "utf8");
    expect(source).not.toContain("private-installation-identity.ts");
    expect(source).not.toContain("m1-segment-attribution.ts");
    const attributionSource = readFileSync(join(
      process.cwd(),
      "packages/butler-agent/src/integrations/providers/shared/m1-segment-attribution.ts",
    ), "utf8");
    expect(attributionSource).toContain("private-installation-identity.ts");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENAI_BASE_URL", priorBase);
    rmSync(root, { recursive: true, force: true });
  }
});

function sqliteOwner(db: Database, ownerId: string): SqliteRuntimeOwnerRegistry {
  return new SqliteRuntimeOwnerRegistry(db, {
    ownerId, hostId: "test-host", processId: 100, processStartedAtMs: 1,
  }, { isAlive: () => false });
}

function insertBudgetTurn(db: Database, state: ReturnType<typeof createTurnContinuationBudgetState>): void {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_budget_json, semantic_state, active_checkpoint_id,
      revision, execution_fence
    ) VALUES ('turn', 'session', 'inbox', 'trigger', 'message', 'request',
      'snapshot', ?, ?, ?, 'admitted', 'checkpoint', 0, 0)
  `).run(JSON.stringify({
    provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium",
    controls: {}, controlsHash: "controls",
  }), JSON.stringify({
    userRef: "user", profileRefs: [], recentFeedbackRefs: [], mandatoryHotCacheRefs: [],
    optionalHotCacheRefs: [], baselineObservationScopeRefs: [],
  }), JSON.stringify(state));
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, is_active
    ) VALUES ('checkpoint', 'turn', 0, 'admitted', 'runtime', 1, 1)
  `).run();
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function captureFlagOffSerializer(flag: string | undefined): Promise<Record<string, unknown>> {
  const priorFlag = process.env.BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT;
  const priorBase = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  restoreEnv("BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT", flag);
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      id: "response", model: "gpt-5.6-sol",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
    });
  }) as typeof fetch;
  try {
    await runOpenAIModelRound({
      roundId: "round", model: "openai/gpt-5.6-sol",
      messages: [{ role: "user", content: "legacy exact input" }], tools: [],
    }, { authorization: "Bearer test", mode: "api_key" });
    return body;
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT", priorFlag);
    restoreEnv("OPENAI_BASE_URL", priorBase);
  }
}
