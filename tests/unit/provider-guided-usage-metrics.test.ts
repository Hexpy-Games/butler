import { localModelConfigToMetadata } from "../../packages/butler-agent/src/integrations/providers/local/catalog.ts";
import { runLocalPromptTextWithConfig } from "../../packages/butler-agent/src/integrations/providers/local/execution.ts";
import { localReasoningRequestParams } from "../../packages/butler-agent/src/integrations/providers/local/text-protocol.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnthropicModelRound } from "../../packages/butler-agent/src/integrations/providers/anthropic/model-round.ts";
import { runGeminiModelRound } from "../../packages/butler-agent/src/integrations/providers/google/model-round.ts";
import { runLocalModelRound } from "../../packages/butler-agent/src/integrations/providers/local/model-round.ts";
import { runOpenAIModelRound } from "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { codexRequestBody } from "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";
import { runHostedOpenAICompatibleModelRound } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-tool-runtime.ts";
import { runHostedResponsesModelRound } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-responses-client.ts";
import { readPromptCacheMetrics } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import type { OpenAIAuthOverride } from "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";
import type { HostedRuntimeConfig } from "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";
import { discoverLocalModels, readLocalModelConfigs, upsertLocalModelConfig, type LocalModelConfig } from "../../packages/butler-agent/src/integrations/providers/local/models.ts";
import type { ModelRoundRequest } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real OpenAI guided model-round persists exactly one sample before usage callback", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      id: "response-guided-openai",
      output: [
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
      ],
      usage: {
        input_tokens: 64,
        output_tokens: 4,
        total_tokens: 68,
        input_tokens_details: { cached_tokens: 8 },
      },
    })) as unknown as typeof fetch;
  const butlerData = temporaryButlerData();
  const observations: number[] = [];
  const request = modelRoundRequest(butlerData, {
    afterModelResponseUsage: () => {
      observations.push(readPromptCacheMetrics({ butlerData }).length);
    },
  });

  await runOpenAIModelRound(request, openAiAuth());

  expect(observations).toEqual([1]);
  expect(readPromptCacheMetrics({ butlerData })).toEqual([
    expect.objectContaining({
      scope: "btcc-guided:butler/app-general",
      turnId: "turn-guided",
      promptTokens: 64,
      cachedTokens: 8,
    }),
  ]);
});

test("real Gemini, Anthropic, and local guided model-rounds persist normalized usage", async () => {
  const cases = [
    {
      name: "google",
      run: (request: ModelRoundRequest) =>
        runGeminiModelRound(googleConfig(), request),
      response: {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {
          promptTokenCount: 32,
          candidatesTokenCount: 5,
          totalTokenCount: 37,
          cachedContentTokenCount: 6,
        },
      },
      expected: { promptTokens: 32, cachedTokens: 6 },
    },
    {
      name: "anthropic",
      run: (request: ModelRoundRequest) =>
        runAnthropicModelRound(anthropicConfig(), request),
      response: {
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 40,
          output_tokens: 5,
          cache_read_input_tokens: 10,
        },
      },
      expected: { promptTokens: 50, cachedTokens: 10 },
    },
    {
      name: "local",
      run: (request: ModelRoundRequest) =>
        runLocalModelRound(localConfig(), request),
      response: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 48, completion_tokens: 5, total_tokens: 53 },
      },
      expected: { promptTokens: 48, cachedTokens: 0 },
    },
  ] as const;

  for (const providerCase of cases) {
    const butlerData = temporaryButlerData();
    let admittedBytes = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(admittedBytes).toBe(Buffer.byteLength(String(init?.body), "utf8"));
      return Response.json(providerCase.response);
    }) as unknown as typeof fetch;
    const observations: number[] = [];
    const request = modelRoundRequest(butlerData, {
      afterModelResponseUsage: () => {
        observations.push(readPromptCacheMetrics({ butlerData }).length);
      },
    });
    request.boundedContinuation = { schemaVersion: "butler.turn-context-envelope.v1",
      modelFacingBytes: 0, requestDigest: "test", responseItemId: "turn-item-1",
      admitProviderBody: async (bytes) => { admittedBytes = bytes; } };

    await providerCase.run(request);

    expect(observations, providerCase.name).toEqual([1]);
    expect(readPromptCacheMetrics({ butlerData }), providerCase.name).toEqual([
      expect.objectContaining({
        scope: "btcc-guided:butler/app-general",
        turnId: "turn-guided",
        ...providerCase.expected,
      }),
    ]);
  }
});

test("hosted chat and Responses admit the final serialized body before sending", async () => {
  for (const providerId of ["zai", "xai"] as const) {
    const config: HostedRuntimeConfig = { providerId, modelId: providerId === "zai" ? "glm-5.2" : "grok-4.5",
      modelRef: providerId === "zai" ? "zai/glm-5.2" : "xai/grok-4.5", authType: "api_key", apiKey: "test", apiBaseUrl: "https://example.test/v1" };
    let admittedBytes = 0;
    globalThis.fetch = (async (_url, init) => {
      expect(admittedBytes).toBe(Buffer.byteLength(String(init?.body), "utf8"));
      return Response.json(providerId === "zai" ? { choices: [{ message: { role: "assistant", content: "ready" } }] }
        : { id: "r", output: [{ type: "message", content: [{ type: "output_text", text: "ready" }] }] });
    }) as typeof fetch;
    const run = providerId === "zai" ? runHostedOpenAICompatibleModelRound : runHostedResponsesModelRound;
    await run(config, { model: config.modelRef, tools: [], messages: [{ role: "user", content: "hello" }],
      boundedContinuation: { schemaVersion: "butler.turn-context-envelope.v1", modelFacingBytes: 0,
        requestDigest: "test", responseItemId: "turn-item-1", admitProviderBody: async (bytes) => { admittedBytes = bytes; } } });
    expect(admittedBytes).toBeGreaterThan(0);
  }
});

test("Codex summary requests omit the unsupported official output limit", () => {
  const official = { model: "gpt-5.6-luna", input: [], max_output_tokens: 16384 };
  expect(codexRequestBody(official)).not.toHaveProperty("max_output_tokens");
  expect(official.max_output_tokens).toBe(16384);
});

test("local model requests omit tool_choice without tools and preserve enabled choices", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if ("tool_choice" in body && !body.tools) {
      return Response.json({ error: { message: "When using tool_choice, tools must be set." } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  }) as typeof fetch;
  const config = localConfig();
  const base = { ...modelRoundRequest(temporaryButlerData()), model: config.model_ref };
  const tools = [{ name: "lookup", description: "Look up a value",
    parameters: { type: "object", properties: {} } }];
  for (const toolChoice of [undefined, "auto", "required"] as const) {
    expect((await runLocalModelRound(config, { ...base, toolChoice, tools: [] })).text).toBe("ok");
    const empty = bodies.at(-1)!;
    expect(empty).not.toHaveProperty("tools");
    expect(empty).not.toHaveProperty("tool_choice");
    await runLocalModelRound(config, { ...base, toolChoice, tools });
    expect(bodies.at(-1)).toMatchObject({ tool_choice: toolChoice ?? "auto",
      tools: [{ type: "function", function: { name: "lookup" } }] });
  }
});

function modelRoundRequest(
  butlerData: string,
  usageAttribution: ModelRoundRequest["usageAttribution"] = {},
): ModelRoundRequest {
  return {
    model: "openai/gpt-5.6-sol",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    butlerData,
    cacheScope: "btcc-guided:butler/app-general",
    usageAttribution: {
      turnId: "turn-guided",
      phase: "guided",
      ...usageAttribution,
    },
  };
}

function openAiAuth(): OpenAIAuthOverride {
  return { mode: "api_key", authorization: "Bearer test" };
}

function googleConfig(): HostedRuntimeConfig {
  return {
    providerId: "google",
    modelId: "gemini-3.1-pro-preview",
    modelRef: "google/gemini-3.1-pro-preview",
    authType: "api_key",
    apiKey: "test",
  };
}

function anthropicConfig(): HostedRuntimeConfig {
  return {
    providerId: "anthropic",
    modelId: "claude-haiku-4-5",
    modelRef: "anthropic/claude-haiku-4-5",
    authType: "api_key",
    apiKey: "test",
  };
}

function localConfig(): LocalModelConfig {
  return {
    provider_id: "local",
    provider_label: "Local",
    model_id: "test-model",
    model_ref: "local/test-model",
    display_name: "Test model",
    api_type: "openai_compatible",
    platform: "custom",
    server_url: "http://127.0.0.1:1234",
    api_base_url: "http://127.0.0.1:1234/v1",
    context_window_tokens: 16_384,
    max_output_tokens: 512,
    token_estimator: "character_estimate",
    source: "manual",
    source_url: "test",
    runtime_supported: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function temporaryButlerData(): string {
  const directory = mkdtempSync(join(tmpdir(), "butler-guided-usage-"));
  temporaryDirectories.push(directory);
  return directory;
}


test("local discovery and persisted registration leave an unspecified output limit absent", async () => {
  const discovered = await discoverLocalModels({ serverUrl: "http://localhost:1234",
    fetchImpl: (async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test-model", max_model_len: 32768 }] })
      : new Response("", { status: 404 })) as typeof fetch });
  expect(discovered.models[0]).not.toHaveProperty("max_output_tokens");
  const data = temporaryButlerData();
  const input = { serverUrl: "http://localhost:1234", modelId: "test-model", contextWindowTokens: 32768 };
  upsertLocalModelConfig(input, data);
  expect(readLocalModelConfigs(data)[0]!.max_output_tokens).toBeUndefined();
  upsertLocalModelConfig({ ...input, maxOutputTokens: 4096 }, data);
  expect(readLocalModelConfigs(data)[0]!.max_output_tokens).toBe(4096);
  upsertLocalModelConfig(input, data);
  expect(readLocalModelConfigs(data)[0]!.max_output_tokens).toBeUndefined();
});

test("local outbound requests omit unspecified limits and preserve explicit config and request limits", async () => {
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  }) as typeof fetch;
  const config = localConfig();
  delete config.max_output_tokens;
  const request = { ...modelRoundRequest(temporaryButlerData()), model: config.model_ref };
  await runLocalModelRound(config, request);
  expect(body).not.toHaveProperty("max_tokens");
  expect(body).not.toHaveProperty("max_completion_tokens");
  await runLocalModelRound(config, { ...request, maxOutputTokens: 256 });
  expect(body.max_tokens).toBe(256);
  config.max_output_tokens = 4096;
  await runLocalModelRound(config, request);
  expect(body.max_tokens).toBe(4096);
  await runLocalModelRound(config, { ...request, maxOutputTokens: 256 });
  expect(body.max_tokens).toBe(256);
});


test("Qwen native effort catalog maps each selection to both actual request paths", async () => {
  const config: LocalModelConfig = { ...localConfig(), model_id: "qwen3.8-27b",
    model_ref: "local/qwen3.8-27b", platform: "llama_cpp", max_output_tokens: undefined,
    reasoning_budget_ratio: 0.25 };
  const metadata = localModelConfigToMetadata(config);
  expect(metadata.reasoning_efforts).toEqual(["none", "low", "medium", "xhigh"]);
  expect(metadata.default_reasoning_effort).toBe("xhigh");
  expect(metadata.local_reasoning_budget_ratio).toBeUndefined();
  expect(metadata.reasoning_budget_tokens).toBeUndefined();
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  }) as typeof fetch;
  const data = temporaryButlerData();
  for (const effort of metadata.reasoning_efforts) {
    await runLocalModelRound(config, { ...modelRoundRequest(data), model: config.model_ref,
      reasoningEffort: effort, tools: [] });
    await runLocalPromptTextWithConfig(config, { model: config.model_ref, prompt: "hello",
      reasoningEffort: effort, butlerData: data });
    for (const body of bodies.slice(-2)) {
      expect(body.reasoning_effort).toBe(effort);
      expect(body).not.toHaveProperty("thinking_budget_tokens");
      expect(body).not.toHaveProperty("max_tokens");
    }
  }
  expect(localReasoningRequestParams(config)).toEqual({});
  expect(() => localReasoningRequestParams(config, "high")).toThrow("Unsupported local reasoning effort");
  expect(localModelConfigToMetadata({ ...config, model_id: "Qwen/Qwen3.8-27B-FP8" }).reasoning_efforts)
    .toEqual(metadata.reasoning_efforts);
  expect(localModelConfigToMetadata(localConfig()).reasoning_efforts).toEqual(["none"]);
  expect(localReasoningRequestParams({ ...localConfig(), platform: "llama_cpp",
    reasoning_budget_ratio: 0.25 }, "high")).toEqual({ thinking_budget_tokens: 128 });
  expect(localReasoningRequestParams(localConfig(), "low")).toEqual({});
});
