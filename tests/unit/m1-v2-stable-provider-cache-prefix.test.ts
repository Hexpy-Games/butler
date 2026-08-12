import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import {
  buildModelRoute,
  createModelRoutePort,
} from "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import type { ModelRoundRequest } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { hydrateAcceptedModelRound, normalizeAcceptedModelRound } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-model-response-normalizer.ts";
import { selectGuidedTurnPhasePolicy } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-phase-policy.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { StableProviderPrefixInvariantError } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { classifyModelRouteFailure } from
  "../../packages/butler-agent/src/agent/btcc/model-route/failure-policy.ts";

const stablePrefix = {
  schemaVersion: "butler.stable-provider-cache-prefix.v1" as const,
  stablePrefixRevision: "butler.btcc-stable-provider-prefix.v1",
  toolProfileRevision: "butler.btcc-tool-instruction-policy.v1",
  instructionPrefix: [
    "You are Butler. Preserve safety and role.",
    "Follow the BTCC protocol and the selected typed tool profile.",
  ].join("\n"),
};

const routeContext = {
  schemaVersion: "butler.model-route-request.v1" as const,
  routeDigest: "a".repeat(64),
  cursor: 0,
  modelRef: "openai/gpt-5.6-sol",
};

function request(dynamic: string, continuation?: unknown): ModelRoundRequest {
  return {
    roundId: `round-${dynamic}`,
    model: "openai/gpt-5.6-sol",
    instructions: `${stablePrefix.instructionPrefix}\nDYNAMIC-${dynamic}`,
    messages: [{ role: "user", content: dynamic }],
    tools: [{
      name: "read_file",
      description: "Read one admitted file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
    boundedContinuation: {
      schemaVersion: "butler.turn-context-envelope.v1",
      modelFacingBytes: 2_000,
      requestDigest: createHash("sha256").update(dynamic).digest("hex"),
      responseItemId: continuation === undefined ? "turn-item-1" : "turn-item-2",
      admitProviderBody: async () => {},
    },
    stableProviderCachePrefix: stablePrefix,
    routeContext,
    ...(continuation === undefined ? {} : { continuation }),
  };
}

function commonPrefix(left: string, right: string): string {
  let index = 0;
  while (index < left.length && left[index] === right[index]) index += 1;
  return left.slice(0, index);
}

function fakeJwt(): string {
  const body = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
  })).toString("base64url");
  return `header.${body}.signature`;
}

for (const transport of ["official", "codex"] as const) {
  test(`${transport} production serializer keeps a byte-identical stable prefix while only the suffix changes`, async () => {
    const originalFetch = globalThis.fetch;
    const prior = {
      official: process.env.OPENAI_BASE_URL,
      codex: process.env.BUTLER_CODEX_RESPONSES_URL,
    };
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.BUTLER_CODEX_RESPONSES_URL = "https://example.test/codex";
    const bodies: string[] = [];
    let index = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const response = {
        id: `response-${index++}`,
        model: "gpt-5.6-sol",
        output: [],
      };
      return transport === "official"
        ? Response.json(response)
        : new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
    }) as typeof fetch;
    const auth = transport === "official"
      ? { mode: "api_key" as const, authorization: "Bearer test" }
      : { mode: "codex_subscription" as const, authorization: `Bearer ${fakeJwt()}` };
    try {
      const first = await runOpenAIModelRound(request("USER-ONE WORK-PRIVATE /private/a"), auth);
      await runOpenAIModelRound(request(
        "USER-TWO TOOL-RESULT-PRIVATE /private/b",
        first.continuation,
      ), auth);
      expect(bodies).toHaveLength(2);
      const identity = (first.continuation as {
        providerRouteIdentity: { serializedStablePrefixBytes: number };
      }).providerRouteIdentity;
      const prefix = Buffer.from(bodies[0]!).subarray(
        0,
        identity.serializedStablePrefixBytes,
      ).toString("utf8");
      const secondPrefix = commonPrefix(bodies[0]!, bodies[1]!);
      expect(bodies[0]!.startsWith(prefix)).toBe(true);
      expect(bodies[1]!.startsWith(prefix)).toBe(true);
      expect(secondPrefix.startsWith(prefix)).toBe(true);
      expect(Buffer.byteLength(prefix)).toBeGreaterThan(100);
      expect(prefix).toContain("Preserve safety and role");
      expect(prefix).toContain("read_file");
      expect(prefix).not.toMatch(/USER-|WORK-PRIVATE|TOOL-RESULT-PRIVATE|\/private\//);
      expect(bodies[0]!.slice(prefix.length)).toContain("USER-ONE");
      expect(bodies[1]!.slice(prefix.length)).toContain("USER-TWO");
      expect((first.continuation as { providerRouteIdentity: unknown }).providerRouteIdentity)
        .toMatchObject({
          providerId: transport === "official" ? "openai" : "openai-codex",
          authMode: auth.mode,
          serializerContract: transport === "official"
            ? "butler.openai-responses-final-json.v1"
            : "butler.openai-codex-final-json.v1",
          toolProfileRevision: stablePrefix.toolProfileRevision,
          stablePrefixRevision: stablePrefix.stablePrefixRevision,
        });
    } finally {
      globalThis.fetch = originalFetch;
      restore("OPENAI_BASE_URL", prior.official);
      restore("BUTLER_CODEX_RESPONSES_URL", prior.codex);
    }
  });
}

test("route cursor transition atomically clears provider continuation and establishes a new identity", async () => {
  const seen: ModelRoundRequest[] = [];
  const routed = createModelRoutePort({
    turnId: "turn",
    route: buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol",
      backupModelRefs: ["openai/gpt-5.6-luna"],
      reasoningEffort: "medium",
      catalogGeneration: "catalog-v1",
      retryCeiling: 1,
    }),
    onRouteEvent: async () => ({ status: "recorded" }),
    base: { async runRound(input) {
      seen.push(input);
      if (seen.length === 1) throw new ModelProviderRequestError({
        provider: "openai", api: "responses", code: "provider_unavailable",
        message: "advance", retryable: false, statusCode: 503,
      });
      return { toolCalls: [], continuation: { new: true } };
    } },
  });
  await routed.runRound(request("CURRENT", {
    provider: "openai", responseId: "old", providerRouteIdentity: { stale: true },
  }));
  expect(seen).toHaveLength(2);
  expect(seen[0]!.routeContext?.cursor).toBe(0);
  expect(seen[0]!.continuation).toBeDefined();
  expect(seen[1]!.routeContext?.cursor).toBe(1);
  expect(seen[1]!.continuation).toBeUndefined();
});

test("every route compatibility axis rejects a stale continuation before dispatch", async () => {
  const originalFetch = globalThis.fetch;
  const prior = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return Response.json({ id: `identity-${fetches}`, model: "gpt-5.6-sol", output: [] });
  }) as unknown as typeof fetch;
  const auth = { mode: "api_key" as const, authorization: "Bearer test" };
  try {
    const first = await runOpenAIModelRound(request("FIRST"), auth);
    const restart = hydrateAcceptedModelRound(JSON.stringify(
      normalizeAcceptedModelRound(first),
    ), null);
    await runOpenAIModelRound(request("RESTART", restart.continuation), auth);
    expect(fetches).toBe(2);

    const incompatible: ModelRoundRequest[] = [
      { ...request("CURSOR", first.continuation), routeContext: { ...routeContext, cursor: 1 } },
      { ...request("DIGEST", first.continuation), routeContext: { ...routeContext, routeDigest: "b".repeat(64) } },
      {
        ...request("MODEL", first.continuation), model: "openai/gpt-5.6-luna",
        routeContext: { ...routeContext, modelRef: "openai/gpt-5.6-luna" },
      },
      { ...request("CAPABILITY", first.continuation), tools: [] },
      {
        ...request("TOOL-REV", first.continuation),
        stableProviderCachePrefix: { ...stablePrefix, toolProfileRevision: "tool-v2" },
      },
      {
        ...request("PREFIX-REV", first.continuation),
        stableProviderCachePrefix: { ...stablePrefix, stablePrefixRevision: "prefix-v2" },
      },
    ];
    for (const stale of incompatible) {
      try {
        await runOpenAIModelRound(stale, auth);
        throw new Error("expected typed stable prefix rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(StableProviderPrefixInvariantError);
        expect((error as StableProviderPrefixInvariantError).code)
          .toBe("stable_provider_prefix_route_identity_mismatch");
        expect(classifyModelRouteFailure(error)).toBe("surface");
      }
    }
    expect(fetches).toBe(2);
    await expect(runOpenAIModelRound(
      request("AUTH-SERIALIZER", first.continuation),
      { mode: "codex_subscription", authorization: `Bearer ${fakeJwt()}` },
    )).rejects.toThrow("stable_provider_prefix_route_identity_mismatch");
    expect(fetches).toBe(2);
    await expect(runOpenAIModelRound({
      ...request("MISSING", { provider: "openai", responseId: "legacy", deliveredThroughOrdinal: 1 }),
    }, auth)).rejects.toThrow("stable_provider_prefix_previous_identity_missing");
    expect(fetches).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENAI_BASE_URL", prior);
  }
});

test("typed prefix invariant surfaces through the route with zero fetch and zero fallback", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let fallbacks = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  const routed = createModelRoutePort({
    turnId: "typed-failure-turn",
    route: buildModelRoute({
      primaryModelRef: "openai/gpt-5.6-sol",
      backupModelRefs: ["openai/gpt-5.6-luna"],
      reasoningEffort: "medium", catalogGeneration: "catalog-v1", retryCeiling: 3,
    }),
    onRouteEvent: async (event) => {
      if (event.type === "model.fallback.selected") fallbacks += 1;
      return { status: "recorded" };
    },
    base: { runRound: async (input) => await runOpenAIModelRound(
      { ...input, routeContext: undefined },
      { mode: "api_key", authorization: "Bearer test" },
    ) },
  });
  try {
    await routed.runRound(request("TYPED-FAILURE"));
    throw new Error("expected typed stable prefix rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(StableProviderPrefixInvariantError);
    expect((error as StableProviderPrefixInvariantError).code)
      .toBe("stable_provider_prefix_route_context_missing");
    expect(classifyModelRouteFailure(error)).toBe("surface");
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(fetches).toBe(0);
  expect(fallbacks).toBe(0);
});

test("provider-neutral route policy does not import the OpenAI prefix adapter", () => {
  const source = readFileSync(
    "packages/butler-agent/src/agent/btcc/model-route/failure-policy.ts",
    "utf8",
  );
  expect(source).not.toContain("integrations/providers/openai");
  expect(source).toContain('from "../ports/model-round.ts"');
});

test("same-cursor physical retry preserves the exact stable identity and full admitted body", async () => {
  const originalFetch = globalThis.fetch;
  const prior = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return Response.json({ error: { message: "retry" } }, { status: 503 });
    return Response.json({ id: "retry-ok", model: "gpt-5.6-sol", output: [] });
  }) as typeof fetch;
  try {
    const routed = createModelRoutePort({
      turnId: "retry-turn",
      route: buildModelRoute({
        primaryModelRef: "openai/gpt-5.6-sol", reasoningEffort: "medium",
        catalogGeneration: "catalog-v1", retryCeiling: 2,
      }),
      onRouteEvent: async () => ({ status: "recorded" }),
      base: { runRound: async (input) => await runOpenAIModelRound(
        input,
        { mode: "api_key", authorization: "Bearer test" },
      ) },
    });
    const result = await routed.runRound(request("RETRY-SAME-CONTEXT"));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect((result.continuation as { providerRouteIdentity: unknown }).providerRouteIdentity)
      .toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENAI_BASE_URL", prior);
  }
});

test("direct read-only and execution policy fixtures preserve final serializer prefix bytes", async () => {
  const originalFetch = globalThis.fetch;
  const prior = {
    official: process.env.OPENAI_BASE_URL,
    codex: process.env.BUTLER_CODEX_RESPONSES_URL,
  };
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  process.env.BUTLER_CODEX_RESPONSES_URL = "https://example.test/codex";
  const metrics: Array<Record<string, string | number>> = [];
  try {
    for (const transport of ["official", "codex"] as const) {
      for (const fixture of [
        { phase: "direct", accessMode: "read_only", trackingMode: "none" },
        { phase: "read_only", accessMode: "read_only", trackingMode: "ledger" },
        { phase: "execution", accessMode: "full_access", trackingMode: "ledger" },
      ] as const) {
        const selection = selectGuidedTurnPhasePolicy(
          phaseTurn(fixture.accessMode, fixture.trackingMode),
          { BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE: "on" },
        );
        expect(selection.phase).toBe(fixture.phase);
        const bodies: string[] = [];
        let response = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(String(init?.body));
          const payload = { id: `fixture-${response++}`, model: "gpt-5.6-sol", output: [] };
          return transport === "official"
            ? Response.json(payload)
            : new Response(
                `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              );
        }) as typeof fetch;
        const auth = transport === "official"
          ? { mode: "api_key" as const, authorization: "Bearer test" }
          : { mode: "codex_subscription" as const, authorization: `Bearer ${fakeJwt()}` };
        const run = async (dynamic: string) => await runOpenAIModelRound({
          ...request(dynamic),
          instructions: `${selection.stableInstructionPrefix}\nPRIVATE-${dynamic}`,
          tools: selection.providerTools,
          stableProviderCachePrefix: selection.stableProviderCachePrefix,
        }, auth);
        const first = await run("ROUND-A");
        await run("ROUND-B");
        const identity = (first.continuation as {
          providerRouteIdentity: { serializedStablePrefixBytes: number };
        }).providerRouteIdentity;
        const prefixBytes = identity.serializedStablePrefixBytes;
        const firstBytes = Buffer.byteLength(bodies[0]!, "utf8");
        const secondBytes = Buffer.byteLength(bodies[1]!, "utf8");
        const changedAt = Buffer.byteLength(commonPrefix(bodies[0]!, bodies[1]!), "utf8");
        expect(Buffer.from(bodies[0]!).subarray(0, prefixBytes))
          .toEqual(Buffer.from(bodies[1]!).subarray(0, prefixBytes));
        expect(Buffer.from(bodies[0]!).subarray(0, prefixBytes).toString("utf8"))
          .not.toContain("PRIVATE-");
        expect(changedAt).toBeGreaterThanOrEqual(prefixBytes);
        metrics.push({ transport, phase: fixture.phase, prefixBytes, firstBytes, secondBytes, changedAt });
      }
    }
    expect(metrics).toEqual([
      { transport: "official", phase: "direct", prefixBytes: 6321, firstBytes: 6518, secondBytes: 6518, changedAt: 6337 },
      { transport: "official", phase: "read_only", prefixBytes: 9454, firstBytes: 9651, secondBytes: 9651, changedAt: 9470 },
      { transport: "official", phase: "execution", prefixBytes: 17597, firstBytes: 17794, secondBytes: 17794, changedAt: 17613 },
      { transport: "codex", phase: "direct", prefixBytes: 6321, firstBytes: 6532, secondBytes: 6532, changedAt: 6337 },
      { transport: "codex", phase: "read_only", prefixBytes: 9454, firstBytes: 9665, secondBytes: 9665, changedAt: 9470 },
      { transport: "codex", phase: "execution", prefixBytes: 17597, firstBytes: 17808, secondBytes: 17808, changedAt: 17613 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENAI_BASE_URL", prior.official);
    restore("BUTLER_CODEX_RESPONSES_URL", prior.codex);
  }
});

function phaseTurn(
  accessMode: "read_only" | "full_access",
  trackingMode: "none" | "ledger",
): TurnRecord {
  return {
    turnId: "fixture-turn", sessionId: "fixture-session", inboxId: "fixture-inbox",
    triggerKey: "fixture-trigger", originalMessageId: "fixture-message",
    originalMessage: "PRIVATE USER REQUEST", revision: 0, executionFence: 0,
    semanticState: "admitted",
    modelSelection: {
      provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium",
      controls: { accessMode }, controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      ...(trackingMode === "ledger" ? { projectRef: "project" } : {}),
      profileRefs: [], recentFeedbackRefs: [], mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [], baselineObservationScopeRefs: [],
      executionPolicy: {
        role: "butler", accessMode, trackingMode, requiredNativeToolProfiles: [],
        requiredNativeTools: [], workspacePath: "/private/workspace",
        ...(trackingMode === "ledger" ? { projectId: "project" } : {}),
      },
    },
  };
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
