import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnthropicModelRound } from "../../packages/butler-agent/src/integrations/providers/anthropic/model-round.ts";
import { runGeminiModelRound } from "../../packages/butler-agent/src/integrations/providers/google/model-round.ts";
import { runLocalModelRound } from "../../packages/butler-agent/src/integrations/providers/local/model-round.ts";
import { runOpenAIModelRound } from "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { readPromptCacheMetrics } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import type { OpenAIAuthOverride } from "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";
import type { HostedRuntimeConfig } from "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";
import type { LocalModelConfig } from "../../packages/butler-agent/src/integrations/providers/local/models.ts";
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
    globalThis.fetch = (async () =>
      Response.json(providerCase.response)) as unknown as typeof fetch;
    const observations: number[] = [];
    const request = modelRoundRequest(butlerData, {
      afterModelResponseUsage: () => {
        observations.push(readPromptCacheMetrics({ butlerData }).length);
      },
    });

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
