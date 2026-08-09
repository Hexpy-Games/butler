import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRoundPort } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import {
  buildModelRoute,
  classifyModelRouteFailure,
  createModelRoutePort as createProductionModelRoutePort,
  MODEL_ROUTE_MAX_DISPATCHES,
} from "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { createTurnRuntime } from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import type { ImageCarrierTuple } from "../../packages/butler-agent/src/agent/image-attachment/index.ts";

function createModelRoutePort(
  input: Parameters<typeof createProductionModelRoutePort>[0],
) {
  return createProductionModelRoutePort({ ...input, retryDelayMs: () => 0 });
}

test("model route advances once after bounded provider exhaustion and preserves order", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: ["zai/glm-5.2", "zai-api/glm-5.2"],
    reasoningEffort: "xhigh",
    retryCeiling: 4,
    catalogGeneration: "catalog-1",
  });
  expect(route.candidates.map((candidate) => candidate.modelRef)).toEqual([
    "openai/gpt-5.5",
    "zai/glm-5.2",
  ]);
  const requests: Array<{
    model: string;
    retries?: number;
    reasoning?: string;
    attributedReasoning?: string;
  }> = [];
  const events: string[] = [];
  let calls = 0;
  const base: ModelRoundPort = {
    async runRound(request) {
      calls += 1;
      requests.push({
        model: String(request.model),
        retries: request.providerRetryAttempts,
        reasoning: request.reasoningEffort,
        attributedReasoning: request.usageAttribution?.reasoningEffort,
      });
      if (calls <= 4) {
        throw new ModelProviderRequestError({
          code: "provider_rate_limited",
          message: "rate limited",
          provider: "openai",
          retryable: true,
        });
      }
      return { text: "backup answer", toolCalls: [] };
    },
  };
  const routed = createModelRoutePort({
    base,
    turnId: "turn-route-1",
    route,
    onRouteEvent: (event) => {
      events.push(event.type);
    },
  });

  const result = await routed.runRound({
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
    usageAttribution: {
      turnId: "turn-route-1",
      reasoningEffort: "medium",
    },
  });

  expect(result.text).toBe("backup answer");
  expect(requests).toEqual([
    { model: "openai/gpt-5.5", retries: 1, reasoning: "xhigh", attributedReasoning: "xhigh" },
    { model: "openai/gpt-5.5", retries: 1, reasoning: "xhigh", attributedReasoning: "xhigh" },
    { model: "openai/gpt-5.5", retries: 1, reasoning: "xhigh", attributedReasoning: "xhigh" },
    { model: "openai/gpt-5.5", retries: 1, reasoning: "xhigh", attributedReasoning: "xhigh" },
    { model: "zai/glm-5.2", retries: 1, reasoning: "xhigh", attributedReasoning: "xhigh" },
  ]);
  expect(events).toEqual([
    "model.attempt.started",
    "model.attempt.failed",
    "model.attempt.started",
    "model.attempt.failed",
    "model.attempt.started",
    "model.attempt.failed",
    "model.attempt.started",
    "model.attempt.failed",
    "model.fallback.selected",
    "model.attempt.started",
    "model.attempt.succeeded",
  ]);
});

test("model route surfaces auth and admission failures without fallback", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: ["zai/glm-5.2"],
    reasoningEffort: "medium",
  });
  let calls = 0;
  const routed = createModelRoutePort({
    base: {
      async runRound() {
        calls += 1;
        throw new ModelProviderRequestError({
          code: "provider_auth_error",
          message: "auth failed",
          provider: "openai",
          retryable: false,
        });
      },
    },
    turnId: "turn-route-auth",
    route,
  });
  await expect(routed.runRound({ model: "openai/gpt-5.5", messages: [], tools: [] }))
    .rejects.toMatchObject({ code: "provider_auth_error" });
  expect(calls).toBe(1);
  expect(classifyModelRouteFailure(new Error("local invariant"))).toBe("surface");
});

test("visual provider failures never advance to a different model", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.6-sol",
    backupModelRefs: ["zai/glm-5.2"],
    reasoningEffort: "medium",
    retryCeiling: 1,
  });
  const imageCarrier: ImageCarrierTuple = {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    carrierProtocol: "openai_responses",
    endpointProfileId: "openai-responses-v1",
    catalogCapabilityRevision: "openai-image-input-v1",
    catalogCapabilityDigest: "openai-image-fixture",
  };
  const requests: string[] = [];
  const events: string[] = [];
  const routed = createModelRoutePort({
    base: {
      async runRound(request) {
        requests.push(String(request.model));
        throw new ModelProviderRequestError({
          code: "provider_rate_limited",
          message: "rate limited",
          provider: "openai",
          statusCode: 429,
          retryable: true,
        });
      },
    },
    turnId: "turn-route-visual-no-fallback",
    route,
    onRouteEvent: (event) => {
      events.push(event.type);
    },
  });

  await expect(routed.runRound({
    model: "openai/gpt-5.6-sol",
    messages: [],
    tools: [],
    imageCarrier,
  })).rejects.toMatchObject({ code: "provider_rate_limited" });
  expect(requests).toEqual(["openai/gpt-5.6-sol"]);
  expect(events).not.toContain("model.fallback.selected");
});

test("persisted surface failure is recovered without redispatch or fallback", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: ["zai/glm-5.2"],
    reasoningEffort: "medium",
    retryCeiling: 3,
  });
  const persisted: Array<{ type: string; failureDisposition?: string }> = [];
  const first = createModelRoutePort({
    base: {
      async runRound() {
        throw new ModelProviderRequestError({
          code: "provider_auth_error",
          message: "auth failed",
          provider: "openai",
          retryable: false,
        });
      },
    },
    turnId: "turn-route-crash-surface",
    route,
    onRouteEvent: (event) => {
      persisted.push(event);
      if (event.type === "model.attempt.failed") {
        throw new Error("simulated crash after failure journal");
      }
    },
  });
  await expect(first.runRound({
    roundId: "crash-surface-round",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  })).rejects.toThrow("simulated crash after failure journal");
  expect(persisted.at(-1)).toMatchObject({
    type: "model.attempt.failed",
    failureDisposition: "surface",
  });

  let redispatches = 0;
  const recovered = createModelRoutePort({
    base: {
      async runRound() {
        redispatches += 1;
        return { text: "must not dispatch", toolCalls: [] };
      },
    },
    turnId: "turn-route-crash-surface",
    route,
    loadAttemptHistory: async () => ({
      started: [1],
      failed: [1],
      failedDetails: [{
        transportAttempt: 1,
        errorCode: "provider_auth_error",
        disposition: "surface" as const,
      }],
      succeeded: [],
      abandoned: [],
    }),
  });
  await expect(recovered.runRound({
    roundId: "crash-surface-round",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  })).rejects.toMatchObject({
    code: "model_route_recovered_failure",
    failureCode: "provider_auth_error",
    disposition: "surface",
  });
  expect(redispatches).toBe(0);
});

test("persisted advance and retry dispositions preserve restart policy", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: ["zai/glm-5.2"],
    reasoningEffort: "medium",
    retryCeiling: 3,
  });
  const advanceRequests: string[] = [];
  const advanceEvents: string[] = [];
  const advance = createModelRoutePort({
    base: {
      async runRound(request) {
        advanceRequests.push(String(request.model));
        return { text: "backup", toolCalls: [] };
      },
    },
    turnId: "turn-route-crash-advance",
    route,
    loadAttemptHistory: async ({ modelRef }) => modelRef === "openai/gpt-5.5"
      ? {
          started: [1],
          failed: [1],
          failedDetails: [{
            transportAttempt: 1,
            errorCode: "provider_quota_exhausted",
            disposition: "advance" as const,
          }],
          succeeded: [],
          abandoned: [],
        }
      : { started: [], failed: [], succeeded: [], abandoned: [] },
    onRouteEvent: (event) => {
      advanceEvents.push(`${event.type}:${event.modelRef}`);
    },
  });
  await expect(advance.runRound({
    roundId: "crash-advance-round",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  })).resolves.toMatchObject({ text: "backup" });
  expect(advanceRequests).toEqual(["zai/glm-5.2"]);
  expect(advanceEvents).toEqual([
    "model.fallback.selected:zai/glm-5.2",
    "model.attempt.started:zai/glm-5.2",
    "model.attempt.succeeded:zai/glm-5.2",
  ]);

  const retryAttempts: number[] = [];
  const retry = createModelRoutePort({
    base: {
      async runRound(request) {
        retryAttempts.push(Number(request.providerRetryAttempts));
        return { text: "retry recovered", toolCalls: [] };
      },
    },
    turnId: "turn-route-crash-retry",
    route,
    loadAttemptHistory: async () => ({
      started: [1],
      failed: [1],
      failedDetails: [{
        transportAttempt: 1,
        errorCode: "provider_rate_limited",
        disposition: "retry" as const,
      }],
      succeeded: [],
      abandoned: [],
    }),
  });
  await expect(retry.runRound({
    roundId: "crash-retry-round",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  })).resolves.toMatchObject({ text: "retry recovered" });
  expect(retryAttempts).toEqual([1]);
});

test("route dispatch bound is per runRound and does not cap a continuing turn", async () => {
  expect(MODEL_ROUTE_MAX_DISPATCHES).toBe(30);
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: [
      "zai/glm-5.2",
      "openai/gpt-5.4",
      "anthropic/claude-3-7-sonnet",
      "google/gemini-2.5-pro",
      "local/model",
    ],
    reasoningEffort: "medium",
    retryCeiling: 5,
  });
  expect(route.candidates).toHaveLength(6);
  let calls = 0;
  const routed = createModelRoutePort({
    base: {
      async runRound() {
        calls += 1;
        return { text: "bounded", toolCalls: [] };
      },
    },
    turnId: "turn-route-bound",
    route,
  });
  const runRoundCount = MODEL_ROUTE_MAX_DISPATCHES * 11 + 1;
  for (let index = 0; index < runRoundCount; index += 1) {
    await routed.runRound({
      roundId: `bound-round-${index}`,
      model: "openai/gpt-5.5",
      messages: [],
      tools: [],
    });
  }
  expect(calls).toBe(runRoundCount);
});

test("one runRound bounds retry and fallback dispatches to the route maximum", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: [
      "zai/glm-5.2",
      "openai/gpt-5.4",
      "anthropic/claude-3-7-sonnet",
      "google/gemini-2.5-pro",
      "local/model",
    ],
    reasoningEffort: "medium",
    retryCeiling: 5,
  });
  let calls = 0;
  let fallbackCount = 0;
  const routed = createModelRoutePort({
    base: {
      async runRound() {
        calls += 1;
        throw new ModelProviderRequestError({
          code: "provider_rate_limited",
          message: "rate limited",
          provider: "openai",
          retryable: true,
        });
      },
    },
    turnId: "turn-route-dispatch-bound",
    route,
    onRouteEvent: (event) => {
      if (event.type === "model.fallback.selected") fallbackCount += 1;
    },
  });

  await expect(routed.runRound({
    roundId: "bound-round-fallbacks",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  })).rejects.toMatchObject({ code: "provider_rate_limited" });
  expect(calls).toBe(MODEL_ROUTE_MAX_DISPATCHES);
  expect(fallbackCount).toBe(route.candidates.length - 1);
});

test("one runRound guard rejects malformed retry dispatches at the route maximum", async () => {
  const builtRoute = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: [
      "zai/glm-5.2",
      "openai/gpt-5.4",
      "anthropic/claude-3-7-sonnet",
      "google/gemini-2.5-pro",
      "local/model",
    ],
    reasoningEffort: "medium",
    retryCeiling: 5,
  });
  const route = { ...builtRoute, retryCeiling: 99 };
  let calls = 0;
  const routed = createModelRoutePort({
    base: {
      async runRound() {
        calls += 1;
        throw new ModelProviderRequestError({
          code: "provider_rate_limited",
          message: "rate limited",
          provider: "openai",
          retryable: true,
        });
      },
    },
    turnId: "turn-route-dispatch-bound",
    route,
  });

  await expect(routed.runRound({
    roundId: "bound-round-overflow",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  })).rejects.toMatchObject({ code: "model_route_dispatch_limit_exceeded" });
  expect(calls).toBe(MODEL_ROUTE_MAX_DISPATCHES);
});

test("accepted-response persistence failure does not become a provider failure", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: ["zai/glm-5.2"],
    reasoningEffort: "medium",
  });
  const events: string[] = [];
  let calls = 0;
  const routed = createModelRoutePort({
    base: {
      async runRound() {
        calls += 1;
        return { text: "accepted", toolCalls: [] };
      },
    },
    turnId: "turn-route-acceptance-failure",
    route,
    onRouteEvent: (event) => {
      events.push(event.type);
    },
    recordAcceptedResponse: async () => {
      throw new Error("acceptance storage unavailable");
    },
  });

  await expect(routed.runRound({
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  })).rejects.toThrow("acceptance storage unavailable");
  expect(calls).toBe(1);
  expect(events).toEqual(["model.attempt.started"]);
});

test("restart abandons a lone started slot before dispatching the next transport attempt", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: ["zai/glm-5.2"],
    reasoningEffort: "medium",
    retryCeiling: 3,
  });
  const requests: number[] = [];
  const events: string[] = [];
  const routed = createModelRoutePort({
    base: {
      async runRound(request) {
        requests.push(request.providerRetryAttempts ?? 0);
        return { text: "recovered", toolCalls: [] };
      },
    },
    turnId: "turn-route-restart",
    route,
    loadAttemptHistory: async () => ({
      started: [1],
      failed: [],
      succeeded: [],
      abandoned: [],
    }),
    onRouteEvent: (event) => {
      events.push(`${event.type}:${event.transportAttempt ?? 0}`);
    },
  });

  const result = await routed.runRound({
    roundId: "restart-round",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  });

  expect(result.text).toBe("recovered");
  expect(requests).toEqual([1]);
  expect(events).toEqual([
    "model.attempt.abandoned_after_restart:1",
    "model.attempt.started:2",
    "model.attempt.succeeded:2",
  ]);
});

test("a terminal-slot race reloads history and never redispatches the closed slot", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    reasoningEffort: "medium",
    retryCeiling: 3,
  });
  let startedCallbacks = 0;
  let slotClosed = false;
  const requests: number[] = [];
  const routed = createModelRoutePort({
    base: {
      async runRound(request) {
        requests.push(request.providerRetryAttempts ?? 0);
        return { text: "after race", toolCalls: [] };
      },
    },
    turnId: "turn-route-terminal-race",
    route,
    loadAttemptHistory: async () => slotClosed
      ? { started: [1], failed: [1], succeeded: [], abandoned: [] }
      : { started: [], failed: [], succeeded: [], abandoned: [] },
    onRouteEvent: (event) => {
      if (event.type !== "model.attempt.started") return;
      startedCallbacks += 1;
      if (startedCallbacks === 1) {
        slotClosed = true;
        return { status: "already_terminal" as const };
      }
      return { status: "recorded" as const };
    },
  });

  const result = await routed.runRound({
    roundId: "terminal-race-round",
    model: "openai/gpt-5.5",
    messages: [],
    tools: [],
  });

  expect(result.text).toBe("after race");
  expect(startedCallbacks).toBe(2);
  expect(requests).toEqual([1]);
});

test("admitted model route is persisted and survives a fresh SQLite repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-model-route-persist-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({ dbPath, ownerId: "route-persist", storageProfile: "ephemeral" });
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    backupModelRefs: ["zai/glm-5.2"],
    reasoningEffort: "medium",
    catalogGeneration: "catalog-persist",
  });
  const command = {
    kind: "run" as const,
    turnId: "route-persist-turn",
    sessionId: "route-persist-session",
    triggerKey: "message:route-persist-turn",
    message: { messageId: "message:route-persist-turn", content: "hello" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.5",
      reasoningEffort: "medium" as const,
      controls: {},
      controlsHash: "route-persist-controls",
      modelRoute: route,
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
  };
  const runtime = createTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run({ loadModelRoundAcceptance, recordModelRouteEvent }) {
        // The acceptance probe runs before the first journal event/provider
        // dispatch. A freshly acquired claim must still own its checkpoint.
        await expect(loadModelRoundAcceptance?.({
          roundId: "route-persist-round",
          candidateIndex: 0,
          modelRef: "openai/gpt-5.5",
        })).resolves.toBeUndefined();
        await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "route-persist-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.5",
        });
        const duplicate = await recordModelRouteEvent?.({
          type: "model.attempt.started",
          roundId: "route-persist-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.5",
        });
        expect(duplicate).toEqual({ status: "abandoned_after_restart" });
        await expect(stores.turns.loadModelRouteAttemptHistory({
          turnId: command.turnId,
          roundId: "route-persist-round",
          routeDigest: route.routeDigest,
          candidateIndex: 0,
          modelRef: "openai/gpt-5.5",
        })).resolves.toEqual({
          started: [1],
          failed: [],
          succeeded: [],
          abandoned: [1],
        });
        await recordModelRouteEvent?.({
          type: "model.fallback.selected",
          roundId: "route-persist-round",
          candidateIndex: 1,
          modelRef: "zai/glm-5.2",
          route: { ...route, activeCursor: 1, consumedAttempts: ["consumed"] },
        });
        return { route: "direct" as const, content: "done" };
      },
    },
  });
  try {
    await runtime.runTurn(command);
    const stored = await stores.turns.findTurn(command.turnId);
    expect(stored?.modelRoute).toMatchObject({
      routeDigest: route.routeDigest,
      candidates: route.candidates,
      activeCursor: 1,
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ route_state_json: string | null }, [string]>(
        "SELECT route_state_json FROM btcc_turns WHERE turn_id = ?",
      ).get(command.turnId)?.route_state_json).toBe(JSON.stringify({
        ...route,
        activeCursor: 1,
        consumedAttempts: ["consumed"],
      }));
      expect(db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM btcc_model_route_events WHERE turn_id = ?",
      ).get(command.turnId)?.count).toBe(3);
    } finally {
      db.close();
    }
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted model response is linked to the active checkpoint and replays after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-model-acceptance-persist-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "acceptance-persist",
    storageProfile: "ephemeral",
  });
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.5",
    reasoningEffort: "medium",
    catalogGeneration: "catalog-acceptance",
  });
  const command = {
    kind: "run" as const,
    turnId: "acceptance-persist-turn",
    sessionId: "acceptance-persist-session",
    triggerKey: "message:acceptance-persist-turn",
    message: { messageId: "message:acceptance-persist-turn", content: "hello" },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.5",
      reasoningEffort: "medium" as const,
      controls: {},
      controlsHash: "acceptance-persist-controls",
      modelRoute: route,
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
  };
  const response = {
    text: "accepted answer",
    toolCalls: [{
      id: "call-1",
      name: "observe",
      arguments: { value: 1 },
      rawArguments: '{"value":1}',
      origin: "native" as const,
    }],
    assistantMessage: {
      role: "assistant" as const,
      content: "accepted answer",
      providerData: { responseId: "safe-response-id" },
    },
    continuation: { provider: "openai", responseId: "safe-response-id" },
    providerIdentity: {
      provider: "openai",
      configuredModel: "openai/gpt-5.5",
      reportedModel: "gpt-5.5-served",
    },
  };
  let replayed: unknown;
  const runtime = createTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run({ loadModelRoundAcceptance, recordModelRoundAcceptance }) {
        await recordModelRoundAcceptance?.({
          roundId: "acceptance-round",
          candidateIndex: 0,
          transportAttempt: 1,
          modelRef: "openai/gpt-5.5",
          result: response,
        });
        replayed = await loadModelRoundAcceptance?.({
          roundId: "acceptance-round",
          candidateIndex: 0,
          modelRef: "openai/gpt-5.5",
        });
        return { route: "direct" as const, content: "done" };
      },
    },
  });
  try {
    await runtime.runTurn(command);
    expect(replayed).toMatchObject({
      text: response.text,
      toolCalls: response.toolCalls,
      continuation: response.continuation,
      assistantMessage: { providerData: response.assistantMessage.providerData },
      providerIdentity: response.providerIdentity,
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{
        checkpoint_id: string;
        checkpoint_revision: number;
        active_checkpoint_id: string | null;
      }, [string]>(`
        SELECT acceptance.checkpoint_id, acceptance.checkpoint_revision,
          turn.active_checkpoint_id
        FROM btcc_model_round_acceptances AS acceptance
        JOIN btcc_turns AS turn ON turn.turn_id = acceptance.turn_id
        WHERE acceptance.turn_id = ?
      `).get(command.turnId)).toMatchObject({
        checkpoint_id: expect.any(String),
        checkpoint_revision: 1,
        active_checkpoint_id: null,
      });
    } finally {
      db.close();
    }
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});
