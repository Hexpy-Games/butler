import { test, expect } from "bun:test";
import {
  listModelMetadata,
  modelCatalogGeneration,
  modelSupportsJsonSchemaResponseFormat,
  modelStructuredDecisionTransport,
  defaultHostedProviderApiEndpoint,
  resolveModelMetadata,
  type ModelProviderId,
  type ProviderModelMetadata,
  modelIdentityKey,
  modelProviderFamilyId,
} from "../../packages/butler-agent/src/integrations/providers/model-catalog.ts";
import { ANTHROPIC_MODELS } from "../../packages/butler-agent/src/integrations/providers/anthropic/catalog.ts";
import { GOOGLE_MODELS } from "../../packages/butler-agent/src/integrations/providers/google/catalog.ts";
import { KIMI_MODELS } from "../../packages/butler-agent/src/integrations/providers/kimi/catalog.ts";
import { OPENCODE_GO_MODELS } from "../../packages/butler-agent/src/integrations/providers/opencode-go/catalog.ts";
import { OPENAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/openai/catalog.ts";
import { QWEN_MODELS } from "../../packages/butler-agent/src/integrations/providers/qwen/catalog.ts";
import { XAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/xai/catalog.ts";
import { ZAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/zai/catalog.ts";
import { ZAI_API_MODELS } from "../../packages/butler-agent/src/integrations/providers/zai-api/catalog.ts";
import {
  providerCapabilitiesForModel,
  resolveProviderAdapterDefinition,
} from "../../packages/butler-agent/src/integrations/providers/registry.ts";

const providerModules: Array<{
  providerId: Exclude<ModelProviderId, "local">;
  models: readonly ProviderModelMetadata[];
}> = [
  { providerId: "openai", models: OPENAI_MODELS },
  { providerId: "anthropic", models: ANTHROPIC_MODELS },
  { providerId: "google", models: GOOGLE_MODELS },
  { providerId: "xai", models: XAI_MODELS },
  { providerId: "qwen", models: QWEN_MODELS },
  { providerId: "kimi", models: KIMI_MODELS },
  { providerId: "zai", models: ZAI_MODELS },
  { providerId: "zai-api", models: ZAI_API_MODELS },
  { providerId: "opencode-go", models: OPENCODE_GO_MODELS },
];

test("hosted provider registry aggregates provider model modules", () => {
  const catalogModels = listModelMetadata();
  for (const provider of providerModules) {
    const expectedRefs = provider.models.map((model) => model.model_ref);
    const catalogRefs = catalogModels
      .filter((model) => model.provider_id === provider.providerId)
      .map((model) => model.model_ref);
    expect(catalogRefs).toEqual(expectedRefs);
  }
});

test("model catalog generation is stable across timestamps and input order", () => {
  const models = listModelMetadata().slice(0, 4);
  expect(modelCatalogGeneration(models)).toBe(
    modelCatalogGeneration([...models].reverse()),
  );
  expect(modelCatalogGeneration(models)).not.toBe(
    modelCatalogGeneration(models.slice(0, 3)),
  );
});

test("namespaced hosted model metadata resolves duplicate model ids by provider", () => {
  const zaiGlm = resolveModelMetadata("zai/glm-5.2");
  const zaiApiGlm = resolveModelMetadata("zai-api/glm-5.2");
  const openCodeGoGlm = resolveModelMetadata("opencode-go/glm-5.2");

  expect(zaiGlm.provider_id).toBe("zai");
  expect(zaiGlm.hosted_api_shape).toBe("openai_chat_completions");
  expect(zaiGlm.provider_label).toBe("Z.AI Coding Plan");
  expect(zaiApiGlm.provider_id).toBe("zai-api");
  expect(zaiApiGlm.provider_label).toBe("Z.AI API");
  expect(zaiApiGlm.hosted_api_shape).toBe("openai_chat_completions");
  expect(modelProviderFamilyId(zaiGlm)).toBe("zai");
  expect(modelProviderFamilyId(zaiApiGlm)).toBe("zai");
  expect(modelIdentityKey(zaiGlm)).toBe(modelIdentityKey(zaiApiGlm));
  expect(openCodeGoGlm.provider_id).toBe("opencode-go");
  expect(openCodeGoGlm.hosted_api_shape).toBe("openai_chat_completions");
});

test("structured output capability follows the provider call shape", () => {
  expect(modelSupportsJsonSchemaResponseFormat("openai/gpt-5.6-sol")).toBe(true);
  expect(modelSupportsJsonSchemaResponseFormat("zai/glm-5.2")).toBe(false);
  expect(modelSupportsJsonSchemaResponseFormat("anthropic/claude-opus-4-6")).toBe(false);
  expect(modelSupportsJsonSchemaResponseFormat("google/gemini-3.1-pro-preview")).toBe(false);
  expect(modelSupportsJsonSchemaResponseFormat("opencode-go/glm-5.2")).toBe(false);
  expect(modelStructuredDecisionTransport("openai/gpt-5.6-sol")).toBe("json_schema");
  expect(modelStructuredDecisionTransport("zai/glm-5.2")).toBe("function_tool");
  expect(modelStructuredDecisionTransport("anthropic/claude-opus-4-6")).toBe("function_tool");
  expect(modelStructuredDecisionTransport("google/gemini-3.1-pro-preview")).toBe("function_tool");
});

test("provider registry binds capabilities and catalogs to one concrete model provider", () => {
  expect(resolveProviderAdapterDefinition("openai/gpt-5.6-sol").catalog).toBe(OPENAI_MODELS);
  expect(resolveProviderAdapterDefinition("zai/glm-5.2").catalog).toBe(ZAI_MODELS);
  expect(providerCapabilitiesForModel("openai/gpt-5.6-sol")).toMatchObject({
    supportsStructuredOutputs: true,
    structuredDecisionTransport: "json_schema",
  });
  expect(providerCapabilitiesForModel("zai/glm-5.2")).toMatchObject({
    supportsStructuredOutputs: true,
    structuredDecisionTransport: "function_tool",
  });
  expect(() => providerCapabilitiesForModel("unknown/example-model")).toThrow(
    "provider_adapter_not_registered:unknown",
  );
});

test("OpenAI catalog exposes GPT-5.6 family as the latest supported model set", () => {
  const refs = OPENAI_MODELS.map((model) => model.model_ref);
  expect(refs.slice(0, 3)).toEqual([
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
  ]);
  expect(OPENAI_MODELS[0]).toMatchObject({
    model_ref: "openai/gpt-5.6-sol",
    status: "latest",
    context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "xhigh",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  });
});

test("frozen hosted provider matrix exposes only current runtime-supported refs", () => {
  const expected = new Map<string, string[]>([
    ["anthropic", ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]],
    ["google", ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]],
    ["xai", ["grok-4.5"]],
    ["kimi", ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"]],
    ["qwen", ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"]],
    ["zai", ["glm-5.2", "glm-5.1", "glm-5"]],
    ["zai-api", ["glm-5.2", "glm-5.1", "glm-5"]],
    ["opencode-go", [
      "grok-4.5", "glm-5.2", "glm-5.1", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
      "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5", "mimo-v2.5-pro", "hy3",
      "gpt-5.6-luna", "minimax-m3", "minimax-m2.7", "qwen3.8-max", "qwen3.7-max",
      "qwen3.7-plus", "qwen3.6-plus",
    ]],
  ]);
  for (const [providerId, modelIds] of expected) {
    expect(
      listModelMetadata()
        .filter((model) => model.provider_id === providerId && model.runtime_supported)
        .map((model) => model.model_id),
    ).toEqual(modelIds);
  }
  expect(resolveModelMetadata("kimi/kimi-k2.7-code-highspeed").runtime_supported).toBe(false);
  expect(resolveModelMetadata("opencode-go/minimax-m2.5").runtime_supported).toBe(false);
});

test("provider matrix keeps carrier endpoints explicit", () => {
  expect(defaultHostedProviderApiEndpoint("anthropic")).toBe(
    "https://api.anthropic.com/v1/messages",
  );
  expect(defaultHostedProviderApiEndpoint("google")).toContain("generateContent");
  expect(defaultHostedProviderApiEndpoint("xai")).toBe("https://api.x.ai/v1/responses");
  expect(defaultHostedProviderApiEndpoint("kimi")).toBe(
    "https://api.moonshot.ai/v1/chat/completions",
  );
  expect(defaultHostedProviderApiEndpoint("zai")).toBe(
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
  );
  expect(defaultHostedProviderApiEndpoint("zai-api")).toBe(
    "https://api.z.ai/api/paas/v4/chat/completions",
  );
  expect(defaultHostedProviderApiEndpoint("opencode-go", "openai_responses")).toBe(
    "https://opencode.ai/zen/go/v1/responses",
  );
  expect(defaultHostedProviderApiEndpoint("opencode-go", "anthropic_messages")).toBe(
    "https://opencode.ai/zen/go/v1/messages",
  );
});

test("aggregator models do not invent unverified output ceilings", () => {
  for (const model of listModelMetadata().filter((item) =>
    item.provider_id === "xai" || item.provider_id === "kimi" || item.provider_id === "opencode-go",
  ).filter((item) => item.runtime_supported)) {
    expect(model.max_output_tokens).toBeUndefined();
  }
});
