import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelRoundMessage,
  PhaseContinuityPrivateDigester,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import {
  projectPhaseContinuity,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/phase-continuity-projection.ts";
import {
  openAIBoundedConversationSerializedBytes,
  openAIInitialRequestSerializedBytes,
} from "../../packages/butler-agent/src/integrations/providers/openai/conversation-items.ts";
import {
  buildModelRoute,
  createModelRoutePort,
} from "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { normalizeAcceptedModelRound } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-model-response-normalizer.ts";
import { prepareBoundedModelContext } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/bounded-turn-context.ts";
import { createTurnContinuationBudgetState } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { privateInstallationDigest } from
  "../../packages/butler-agent/src/integrations/providers/shared/private-installation-identity.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { agentBtccStoragePaths } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";

const digester: PhaseContinuityPrivateDigester = {
  digest(fieldDomain, exactUtf8Bytes) {
    return createHmac("sha256", Buffer.alloc(32, 7))
      .update(`${fieldDomain}\0${exactUtf8Bytes}`, "utf8")
      .digest("base64url")
      .slice(0, 43);
  },
};

const limits = {
  maxModelRequests: 60, maxToolRounds: 60,
  maxModelFacingBytes: 192 * 1024,
  maxCumulativeModelFacingBytes: 8 * 1024 * 1024,
  maxOutputBytes: 512 * 1024,
  maxElapsedMs: 2 * 60 * 60 * 1_000,
  maxIdleMs: 20 * 60 * 1_000,
};

function reference(callId: string) {
  return {
    version: "butler.operation-result-reference.v1" as const,
    kind: "operation_result" as const,
    identity: {
      kind: "direct" as const,
      result_ref: callId,
      tool_name: "read_file",
    },
    integrity: { sha256: callId.padEnd(64, "a").slice(0, 64), revision: null },
    outcome: {
      status: "completed" as const,
      success: true,
      verification: "stored_exact_available" as const,
    },
    availability: {
      status: "exact_read_available" as const,
      capability: "read_operation_results" as const,
      scope: "same_turn" as const,
    },
  };
}

function completedUnit(index: number, contentBytes = 1_000): ModelRoundMessage[] {
  const callId = `${index}`.repeat(64).slice(0, 64);
  return [{
    role: "assistant",
    content: `assistant-${index}-${"A".repeat(contentBytes)}`,
    continuationItemId: `turn-item-${index * 2 + 1}`,
    toolCalls: [{
      id: callId,
      name: "read_file",
      arguments: { index, private: "P".repeat(contentBytes) },
      rawArguments: JSON.stringify({ index, private: "P".repeat(contentBytes) }),
    }],
  }, {
    role: "tool",
    content: JSON.stringify(reference(callId)),
    toolCallId: callId,
    name: "read_file",
    continuationItemId: `turn-item-${index * 2 + 2}`,
    requestSegmentKind: "older_tool_result_projection",
    operationResultReference: reference(callId),
  }];
}

test("folds only acknowledged completed history and preserves user incomplete and newest units", () => {
  const first = completedUnit(0);
  const second = completedUnit(1);
  const newest = completedUnit(2);
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
    ...first,
    { role: "user", content: "preserved user", continuationItemId: "turn-item-3" },
    ...second.map((message) => ({ ...message,
      continuationItemId: message.role === "assistant" ? "turn-item-4" : "turn-item-5",
    })),
    ...newest.map((message) => ({ ...message,
      continuationItemId: message.role === "assistant" ? "turn-item-6" : "turn-item-7",
    })),
  ];

  const projected = projectPhaseContinuity({
    messages,
    digester,
    serializedBytes: (value) => openAIBoundedConversationSerializedBytes(value),
  });

  expect(projected.messages.map((message) => message.role)).toEqual([
    "user", "user", "user", "user", "assistant", "tool",
  ]);
  expect(projected.messages[1]).toMatchObject({
    role: "user",
    requestSegmentKind: "phase_continuity",
    continuationItemId: "turn-item-2",
  });
  expect(projected.messages[3]).toMatchObject({
    role: "user",
    requestSegmentKind: "phase_continuity",
    continuationItemId: "turn-item-5",
  });
  expect(projected.messages[2]?.content).toBe("preserved user");
  expect(projected.messages.at(-2)?.content).toContain("assistant-2-");
  expect(projected.identity).toMatchObject({
    schemaVersion: "butler.context-projection-rebase.v1",
    projectionRevision: "butler.phase-continuity-projection.v1",
    projectedThroughOrdinal: 5,
  });
  const synthetic = projected.messages
    .filter((message) => message.requestSegmentKind === "phase_continuity")
    .map((message) => message.content)
    .join("");
  expect(synthetic).not.toContain("assistant-0-");
  expect(synthetic).not.toContain('"private":"PPP');
  expect(synthetic).toContain("butler.phase-continuity-projection.v1");
});

test("projection is deterministic bounded and downgrades oldest detailed entries first", () => {
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
  ];
  for (let index = 0; index < 25; index += 1) {
    messages.push(...completedUnit(index, 4_000).map((message) => ({
      ...message,
      continuationItemId: message.role === "assistant"
        ? `turn-item-${index * 2 + 1}`
        : `turn-item-${index * 2 + 2}`,
    })));
  }
  messages.push({ role: "assistant", content: "newest", continuationItemId: "turn-item-51" });

  const first = projectPhaseContinuity({
    messages,
    digester,
    serializedBytes: (value) => openAIBoundedConversationSerializedBytes(value),
  });
  const second = projectPhaseContinuity({
    messages,
    digester,
    serializedBytes: (value) => openAIBoundedConversationSerializedBytes(value),
  });
  expect(first).toEqual(second);
  const syntheticBytes = first.messages
    .filter((message) => message.requestSegmentKind === "phase_continuity")
    .reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);
  expect(syntheticBytes).toBeLessThanOrEqual(16 * 1024);
  const payload = JSON.parse(first.messages[1]!.content) as { entries: Array<{ kind: string }> };
  expect(payload.entries[0]?.kind).toBe("reference");
  expect(payload.entries.at(-1)?.kind).toBe("detailed");
});

test("16 KiB ceiling measures all separated synthetic ranges in one final serialization", () => {
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
  ];
  let ordinal = 1;
  for (let index = 0; index < 18; index += 1) {
    messages.push(...completedUnit(index, 4_000).map((message) => ({
      ...message,
      continuationItemId: `turn-item-${ordinal++}`,
    })));
    if (index % 5 === 4 && index < 17) {
      messages.push({
        role: "user", content: `preserved-${index}`,
        continuationItemId: `turn-item-${ordinal++}`,
      });
    }
  }
  messages.push({
    role: "assistant", content: "newest", continuationItemId: `turn-item-${ordinal}`,
  });

  const projected = projectPhaseContinuity({
    messages, digester, serializedBytes: openAIBoundedConversationSerializedBytes,
  });
  const synthetic = projected.messages.filter((message) =>
    message.requestSegmentKind === "phase_continuity",
  );
  expect(synthetic).toHaveLength(4);
  expect(openAIBoundedConversationSerializedBytes(synthetic)).toBeLessThanOrEqual(16 * 1024);
  expect(JSON.parse(synthetic[0]!.content).entries[0].kind).toBe("reference");
});

test("does not fold when exact provider stateless serialization is not smaller", () => {
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
    ...completedUnit(0, 0),
    { role: "assistant", content: "newest", continuationItemId: "turn-item-3" },
  ];
  const projected = projectPhaseContinuity({
    messages,
    digester,
    serializedBytes: () => 100,
  });
  expect(projected.messages).toEqual(messages);
  expect(projected.identity).toBeUndefined();
});

test("under-limit replay history stays exact without projection dependencies", async () => {
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
    ...completedUnit(0, 5_000),
    { role: "assistant", content: "newest exact", continuationItemId: "turn-item-3" },
  ];

  const bounded = await prepareBoundedModelContext({
    messages,
    tools: [],
    roundId: "under-limit",
    responseItemId: "turn-item-4",
    budget: {
      state: createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs: 1 }),
      admitRequest: async () => {},
    },
  });

  expect(bounded.messages).toEqual(messages);
  expect(bounded.contextProjection).toBeUndefined();
  expect(bounded.envelope?.contextProjection).toBeUndefined();
});

test("under-limit history does not call projection digester or stateless serializer", async () => {
  let digestCalls = 0;
  let statelessSerializerCalls = 0;
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
    ...completedUnit(0, 5_000),
    { role: "assistant", content: "newest exact", continuationItemId: "turn-item-3" },
  ];

  const bounded = await prepareBoundedModelContext({
    messages,
    tools: [],
    roundId: "under-limit-no-projection-work",
    responseItemId: "turn-item-4",
    phaseContinuityPrivateDigester: {
      digest() {
        digestCalls += 1;
        return "unused";
      },
    },
    statelessMessageBytes: () => {
      statelessSerializerCalls += 1;
      return 1;
    },
    budget: {
      state: createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs: 1 }),
      admitRequest: async () => {},
    },
  });

  expect(bounded.messages).toEqual(messages);
  expect(bounded.contextProjection).toBeUndefined();
  expect(digestCalls).toBe(0);
  expect(statelessSerializerCalls).toBe(0);
});

test("pressure rejects a non-smaller projection without identity or continuation reset", async () => {
  const older = completedUnit(0, 5_000);
  const newestToolUnit = completedUnit(1, 5_000);
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
    ...older,
    ...newestToolUnit,
    { role: "assistant", content: "newest exact", continuationItemId: "turn-item-5" },
  ];
  const bounded = await prepareBoundedModelContext({
    messages,
    tools: [],
    roundId: "pressure-non-shrink",
    responseItemId: "turn-item-6",
    phaseContinuityPrivateDigester: digester,
    statelessMessageBytes: () => 100,
    budget: {
      state: createTurnContinuationBudgetState({
        turnId: "turn",
        limits: { ...limits, maxModelFacingBytes: 20_000 },
        nowMs: 1,
      }),
      admitRequest: async () => {},
    },
  });
  expect(bounded.messages).toEqual([messages[0]!, ...newestToolUnit, messages.at(-1)!]);
  expect(bounded.contextProjection).toBeUndefined();
  expect(bounded.envelope?.contextProjection).toBeUndefined();

  const priorContinuation = {
    provider: "openai",
    responseId: "prior-response",
    deliveredThroughOrdinal: 3,
    contextProjection: {
      schemaVersion: "butler.context-projection-rebase.v1" as const,
      projectionRevision: "butler.phase-continuity-projection.v1" as const,
      projectionDigest: "a".repeat(64),
      projectedThroughOrdinal: 2,
    },
  };
  const seen: unknown[] = [];
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.6-sol",
    backupModelRefs: [],
    reasoningEffort: "medium",
    catalogGeneration: "pressure-non-shrink",
  });
  await createModelRoutePort({
    turnId: "turn",
    route,
    base: {
      async runRound(request) {
        seen.push(request.continuation);
        return { text: "ok", toolCalls: [] };
      },
    },
  }).runRound({
    roundId: "pressure-non-shrink",
    model: "openai/gpt-5.6-sol",
    messages: bounded.messages,
    tools: [],
    continuation: priorContinuation,
    boundedContinuation: bounded.envelope,
  });
  expect(seen).toEqual([priorContinuation]);
});

test("raw and incomplete units remain exact and unrepresentable reference history fails closed", () => {
  const raw = completedUnit(0, 500).map((message) => message.role === "tool"
    ? { ...message, operationResultReference: undefined }
    : message,
  );
  const incomplete = completedUnit(1, 500).slice(0, 1);
  const messages: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
    ...raw,
    ...incomplete.map((message) => ({ ...message, continuationItemId: "turn-item-3" })),
  ];
  expect(projectPhaseContinuity({
    messages,
    digester,
    serializedBytes: openAIBoundedConversationSerializedBytes,
  }).messages).toEqual(messages);

  const oversized: ModelRoundMessage[] = [
    { role: "user", content: "current", continuationItemId: "turn-item-0" },
  ];
  for (let index = 0; index < 80; index += 1) {
    oversized.push(...completedUnit(index, 1_000).map((message) => ({
      ...message,
      continuationItemId: message.role === "assistant"
        ? `turn-item-${index * 2 + 1}`
        : `turn-item-${index * 2 + 2}`,
    })));
  }
  oversized.push({ role: "assistant", content: "newest", continuationItemId: "turn-item-161" });
  expect(() => projectPhaseContinuity({
    messages: oversized,
    digester,
    serializedBytes: openAIBoundedConversationSerializedBytes,
  })).toThrow("phase_continuity_projection_too_large");
});

test("route owner rebases changed projection once and keeps same-round retries exact", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.6-sol",
    backupModelRefs: [],
    reasoningEffort: "medium",
    retryCeiling: 2,
    catalogGeneration: "catalog",
  });
  const identity = {
    schemaVersion: "butler.context-projection-rebase.v1" as const,
    projectionRevision: "butler.phase-continuity-projection.v1" as const,
    projectionDigest: "b".repeat(64),
    projectedThroughOrdinal: 8,
  };
  const continuations: unknown[] = [];
  let calls = 0;
  const port = createModelRoutePort({
    turnId: "turn",
    route,
    base: {
      statelessMessageBytes: () => 1,
      async runRound(request) {
        calls += 1;
        continuations.push(request.continuation);
        if (calls === 1) {
          throw new ModelProviderRequestError({
            code: "provider_rate_limited",
            message: "retry",
            provider: "openai",
            retryable: true,
          });
        }
        return {
          text: "ok",
          toolCalls: [],
          continuation: {
            provider: "openai",
            responseId: "next",
            deliveredThroughOrdinal: 9,
            contextProjection: identity,
          },
        };
      },
    },
  });
  const result = await port.runRound({
    roundId: "round",
    model: "openai/gpt-5.6-sol",
    messages: [],
    tools: [],
    continuation: {
      provider: "openai",
      responseId: "old",
      deliveredThroughOrdinal: 7,
      contextProjection: { ...identity, projectionDigest: "a".repeat(64) },
    },
    boundedContinuation: {
      schemaVersion: "butler.turn-context-envelope.v1",
      modelFacingBytes: 100,
      requestDigest: "c".repeat(64),
      responseItemId: "turn-item-9",
      contextProjection: identity,
      admitProviderBody: async () => {},
    },
  });
  expect(continuations).toEqual([undefined, undefined]);
  expect(result.continuation).toMatchObject({ contextProjection: identity });
  expect(port.statelessMessageBytes?.([])).toBe(1);
});

test("official Responses rebases an admitted projection but preserves an absent projection", async () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.6-sol",
    backupModelRefs: [],
    reasoningEffort: "medium",
    catalogGeneration: "catalog",
  });
  const originalFetch = globalThis.fetch;
  const priorBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ id: `response-${bodies.length}`, model: "gpt-5.6-sol", output: [] });
  }) as typeof fetch;
  const identity = {
    schemaVersion: "butler.context-projection-rebase.v1" as const,
    projectionRevision: "butler.phase-continuity-projection.v1" as const,
    projectionDigest: "e".repeat(64),
    projectedThroughOrdinal: 2,
  };
  const port = createModelRoutePort({
    turnId: "turn",
    route,
    base: {
      statelessMessageBytes: openAIBoundedConversationSerializedBytes,
      runRound: (request) => runOpenAIModelRound(
        request,
        { mode: "api_key", authorization: "Bearer test" },
      ),
    },
  });
  try {
    await port.runRound({
      roundId: "appearance",
      model: "openai/gpt-5.6-sol",
      messages: [{
        role: "user",
        content: JSON.stringify({ schema: "butler.phase-continuity-projection.v1", entries: [] }),
        requestSegmentKind: "phase_continuity",
        continuationItemId: "turn-item-2",
      }],
      tools: [],
      continuation: {
        provider: "openai", responseId: "old", deliveredThroughOrdinal: 1,
      },
      boundedContinuation: {
        schemaVersion: "butler.turn-context-envelope.v1",
        modelFacingBytes: 100,
        requestDigest: "f".repeat(64),
        responseItemId: "turn-item-3",
        contextProjection: identity,
        admitProviderBody: async () => {},
      },
    });
    await port.runRound({
      roundId: "disappearance",
      model: "openai/gpt-5.6-sol",
      messages: [{ role: "user", content: "current", continuationItemId: "turn-item-0" }],
      tools: [],
      continuation: {
        provider: "openai", responseId: "projected", deliveredThroughOrdinal: 2,
        contextProjection: identity,
      },
      boundedContinuation: {
        schemaVersion: "butler.turn-context-envelope.v1",
        modelFacingBytes: 100,
        requestDigest: "a".repeat(64),
        responseItemId: "turn-item-3",
        admitProviderBody: async () => {},
      },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("previous_response_id");
    expect(bodies[1]?.previous_response_id).toBe("projected");
    expect(JSON.stringify(bodies[0])).toContain("butler.phase-continuity-projection.v1");
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENAI_BASE_URL", priorBase);
  }
});

test("accepted response restart retains only bounded projection identity", () => {
  const identity = {
    schemaVersion: "butler.context-projection-rebase.v1" as const,
    projectionRevision: "butler.phase-continuity-projection.v1" as const,
    projectionDigest: "d".repeat(64),
    projectedThroughOrdinal: 44,
  };
  const normalized = normalizeAcceptedModelRound({
    text: "ok",
    toolCalls: [],
    continuation: {
      provider: "openai",
      responseId: "response",
      deliveredThroughOrdinal: 45,
      contextProjection: identity,
    },
  });
  expect(normalized.continuation).toEqual({
    provider: "openai",
    responseId: "response",
    deliveredThroughOrdinal: 45,
    contextProjection: identity,
  });
  expect(JSON.stringify(normalized)).not.toContain("assistant_text");
  expect(JSON.stringify(normalized)).not.toContain("tool_arguments");
  expect(() => normalizeAcceptedModelRound({
    toolCalls: [],
    continuation: {
      provider: "openai",
      responseId: "response",
      deliveredThroughOrdinal: 45,
      contextProjection: { ...identity, rawPrompt: "forbidden" },
    },
  })).toThrow("invalid context projection");
});

for (const transport of ["official", "codex"] as const) {
  test(`replay-projected bounded context reaches the ${transport} final serializer`, async () => {
    const messages: ModelRoundMessage[] = [
      { role: "user", content: "current", continuationItemId: "turn-item-0" },
      ...completedUnit(0, 5_000),
      ...completedUnit(1, 5_000),
      { role: "assistant", content: "newest exact", continuationItemId: "turn-item-5" },
    ];
    const bounded = await prepareBoundedModelContext({
      messages,
      tools: [],
      roundId: "round",
      responseItemId: "turn-item-6",
      phaseContinuityPrivateDigester: digester,
      statelessMessageBytes: openAIBoundedConversationSerializedBytes,
      budget: {
        state: createTurnContinuationBudgetState({
          turnId: "turn",
          limits: { ...limits, maxModelFacingBytes: 20_000 },
          nowMs: 1,
        }),
        admitRequest: async () => {},
      },
    });
    expect(bounded.contextProjection).toBeDefined();
    const originalFetch = globalThis.fetch;
    const priorOfficial = process.env.OPENAI_BASE_URL;
    const priorCodex = process.env.BUTLER_CODEX_RESPONSES_URL;
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.BUTLER_CODEX_RESPONSES_URL = "https://example.test/codex";
    let body = "";
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      const response = { id: "response", model: "gpt-5.6-sol", output: [] };
      return transport === "official"
        ? Response.json(response)
        : new Response(
            `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
    }) as typeof fetch;
    try {
      const result = await runOpenAIModelRound({
        roundId: "round",
        model: "openai/gpt-5.6-sol",
        messages: bounded.messages,
        tools: [],
        boundedContinuation: bounded.envelope!,
      }, transport === "official"
        ? { mode: "api_key", authorization: "Bearer test" }
        : { mode: "codex_subscription", authorization: `Bearer ${fakeJwt()}` });
      expect(body).toContain("butler.phase-continuity-projection.v1");
      expect(body).not.toContain("assistant-0-");
      expect(body).not.toContain('"private":"PPP');
      expect(result.continuation).toMatchObject({
        contextProjection: bounded.contextProjection,
      });
    } finally {
      globalThis.fetch = originalFetch;
      restore("OPENAI_BASE_URL", priorOfficial);
      restore("BUTLER_CODEX_RESPONSES_URL", priorCodex);
    }
  });
}

for (const transport of ["official", "codex"] as const) {
  test(`under-limit exact history preserves the ${transport} continuation`, async () => {
    const messages: ModelRoundMessage[] = [
      { role: "user", content: "current", continuationItemId: "turn-item-0" },
      ...completedUnit(0, 5_000),
      { role: "assistant", content: "newest exact", continuationItemId: "turn-item-3" },
    ];
    const bounded = await prepareBoundedModelContext({
      messages,
      tools: [],
      roundId: `under-limit-${transport}`,
      responseItemId: "turn-item-4",
      budget: {
        state: createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs: 1 }),
        admitRequest: async () => {},
      },
    });
    expect(bounded.messages).toEqual(messages);
    expect(bounded.contextProjection).toBeUndefined();

    const route = buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol",
      backupModelRefs: [],
      reasoningEffort: "medium",
      catalogGeneration: `under-limit-${transport}`,
    });
    const originalFetch = globalThis.fetch;
    const priorOfficial = process.env.OPENAI_BASE_URL;
    const priorCodex = process.env.BUTLER_CODEX_RESPONSES_URL;
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.BUTLER_CODEX_RESPONSES_URL = "https://example.test/codex";
    let body: Record<string, unknown> = {};
    const seenContinuations: unknown[] = [];
    const priorContinuation = {
      provider: "openai",
      responseId: "prior-response",
      deliveredThroughOrdinal: 3,
      contextProjection: {
        schemaVersion: "butler.context-projection-rebase.v1" as const,
        projectionRevision: "butler.phase-continuity-projection.v1" as const,
        projectionDigest: "a".repeat(64),
        projectedThroughOrdinal: 2,
      },
    };
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const response = { id: "next-response", model: "gpt-5.6-sol", output: [] };
      return transport === "official"
        ? Response.json(response)
        : new Response(
            `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
    }) as typeof fetch;
    try {
      await createModelRoutePort({
        turnId: "turn",
        route,
        base: {
          statelessMessageBytes: openAIBoundedConversationSerializedBytes,
          runRound(request) {
            seenContinuations.push(request.continuation);
            return runOpenAIModelRound(
              request,
              transport === "official"
                ? { mode: "api_key", authorization: "Bearer test" }
                : { mode: "codex_subscription", authorization: `Bearer ${fakeJwt()}` },
            );
          },
        },
      }).runRound({
        roundId: `under-limit-${transport}`,
        model: "openai/gpt-5.6-sol",
        messages: bounded.messages,
        tools: [],
        continuation: priorContinuation,
        boundedContinuation: bounded.envelope,
      });
      expect(seenContinuations).toEqual([priorContinuation]);
      if (transport === "official") {
        expect(body.previous_response_id).toBe("prior-response");
      } else {
        expect(body.previous_response_id).toBeUndefined();
        expect(JSON.stringify(body)).toContain("assistant-0-");
      }
      expect(JSON.stringify(body)).not.toContain("butler.phase-continuity-projection.v1");
    } finally {
      globalThis.fetch = originalFetch;
      restore("OPENAI_BASE_URL", priorOfficial);
      restore("BUTLER_CODEX_RESPONSES_URL", priorCodex);
    }
  });
}

test("private digest failure stops projection before serializer or provider admission", async () => {
  let serialized = 0;
  await expect(prepareBoundedModelContext({
    messages: [
      { role: "user", content: "current", continuationItemId: "turn-item-0" },
      ...completedUnit(0, 4_000),
      ...completedUnit(1, 4_000),
      { role: "assistant", content: "newest", continuationItemId: "turn-item-5" },
    ],
    tools: [],
    roundId: "round",
    responseItemId: "turn-item-6",
    phaseContinuityPrivateDigester: {
      digest() { throw new Error("invalid_feature_attribution_key"); },
    },
    statelessMessageBytes: () => { serialized += 1; return 1; },
    budget: {
      state: createTurnContinuationBudgetState({
        turnId: "turn",
        limits: { ...limits, maxModelFacingBytes: 20_000 },
        nowMs: 1,
      }),
      admitRequest: async () => {},
    },
  })).rejects.toMatchObject({
    name: "PhaseContinuityProjectionError",
    code: "phase_continuity_projection_private_digest_failed",
    cause: expect.objectContaining({ message: "invalid_feature_attribution_key" }),
  });
  expect(serialized).toBe(0);
});

test("production Turn preserves typed projection failure instead of delivering a final", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-phase-projection-terminal-"));
  writeFileSync(
    join(root, "eol.md"),
    "Act only from explicit evidence and preserve the exact reviewed objective.\n",
    "utf8",
  );
  const previous = {
    bounded: process.env.BUTLER_BOUNDED_STATELESS_CONTEXT,
    replay: process.env.BUTLER_OPERATION_RESULT_REPLAY,
  };
  process.env.BUTLER_BOUNDED_STATELESS_CONTEXT = "on";
  process.env.BUTLER_OPERATION_RESULT_REPLAY = "on";
  mkdirSync(join(root, "metrics"), { recursive: true });
  writeFileSync(join(root, "metrics", ".private-installation.key"), "invalid-key");
  writeFileSync(join(root, "large.txt"), "L".repeat(12_000));
  const bindings = new SessionBindingStore(join(root, "sessions.sqlite"), "ephemeral");
  bindings.upsert({
    sessionId: "session", role: "butler", workspacePath: root,
    runtimeAdapterId: "native", modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol", transportBindings: [],
    metadata: { accessMode: "read_only", runtimePolicy: { trackingMode: "none" } },
  });
  let modelRoundCalls = 0;
  let failedRoundProviderCalls = 0;
  const composition = createProductionBtccComposition({
    butlerHome: root, butlerData: root, ownerId: "projection-terminal",
    sessionBindings: bindings,
    modelRound: {
      initialRequestBytes: openAIInitialRequestSerializedBytes,
      statelessMessageBytes: openAIBoundedConversationSerializedBytes,
      async runRound() {
        modelRoundCalls += 1;
        if (modelRoundCalls > 2) failedRoundProviderCalls += 1;
        const callId = `read-${modelRoundCalls}`;
        const rawArguments = JSON.stringify({ requests: [{ path: "large.txt" }] });
        return {
          text: `private-analysis-${"A".repeat(100_000)}`,
          toolCalls: [{
            id: callId, name: "read_file", arguments: { requests: [{ path: "large.txt" }] }, rawArguments,
          }],
        };
      },
    },
  });
  try {
    await expect(composition.btcc.runTurn({
      turnId: "turn", sessionId: "session", eventId: "event",
      transport: "app", accountId: "local", peer: { kind: "dm", id: "session" },
      sender: { id: "user" },
      message: { id: "message", content: "Read the file twice.", timestamp: new Date(1_000).toISOString() },
      trigger: { kind: "user_message" }, route: { role: "butler", workspacePath: root },
    })).rejects.toMatchObject({
      name: "PhaseContinuityProjectionError",
      code: "phase_continuity_projection_private_digest_failed",
    });
    expect(modelRoundCalls).toBe(2);
    expect(failedRoundProviderCalls).toBe(0);
    const db = new Database(agentBtccStoragePaths(root).agentBtccDbPath, { readonly: true });
    try {
      expect(db.query<{
        semantic_state: string; final_payload_json: string | null;
        canonical_assistant_message_id: string | null;
      }, [string]>(`
        SELECT semantic_state, final_payload_json, canonical_assistant_message_id
        FROM btcc_turns WHERE turn_id = ?
      `).get("turn")).toEqual({
        semantic_state: "admitted",
        final_payload_json: null,
        canonical_assistant_message_id: null,
      });
    } finally {
      db.close();
    }
  } finally {
    await composition.host.close();
    bindings.close();
    restore("BUTLER_BOUNDED_STATELESS_CONTEXT", previous.bounded);
    restore("BUTLER_OPERATION_RESULT_REPLAY", previous.replay);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("bounded eviction cannot retain an identity for a projection it did not send", async () => {
  const bounded = await prepareBoundedModelContext({
    messages: [
      { role: "user", content: "current", continuationItemId: "turn-item-0" },
      ...completedUnit(0, 5_000),
      { role: "assistant", content: "newest exact", continuationItemId: "turn-item-3" },
    ],
    tools: [],
    roundId: "round",
    responseItemId: "turn-item-4",
    phaseContinuityPrivateDigester: digester,
    statelessMessageBytes: openAIBoundedConversationSerializedBytes,
    budget: {
      state: createTurnContinuationBudgetState({
        turnId: "turn",
        limits: { ...limits, maxModelFacingBytes: 250 },
        nowMs: 1,
      }),
      admitRequest: async () => {},
    },
  });
  expect(bounded.messages.some((message) =>
    message.content.includes("butler.phase-continuity-projection.v1"),
  )).toBe(false);
  expect(bounded.contextProjection).toBeUndefined();
  expect(bounded.envelope?.contextProjection).toBeUndefined();
});

test("production composition keeps the private installation key lazy while flag is off", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-phase-projection-off-"));
  writeFileSync(
    join(root, "eol.md"),
    "Act only from explicit evidence and preserve the exact reviewed objective.\n",
    "utf8",
  );
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "flag-off",
  });
  try {
    expect(existsSync(join(root, "metrics", ".feature-attribution.key"))).toBe(false);
  } finally {
    await composition.host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production digest purpose and field-domain preimage are exact", () => {
  const key = Buffer.alloc(32, 23);
  expect(privateInstallationDigest(
    key,
    "phase-continuity-projection-v1",
    "assistant_text\0exact utf8",
  )).toBe(createHmac("sha256", key)
    .update("phase-continuity-projection-v1\0assistant_text\0exact utf8", "utf8")
    .digest("base64url")
    .slice(0, 43));
});

function fakeJwt(): string {
  const body = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
  })).toString("base64url");
  return `header.${body}.signature`;
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
