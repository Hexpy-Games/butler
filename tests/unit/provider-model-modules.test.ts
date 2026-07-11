import { test, expect } from "bun:test";
import {
  listModelMetadata,
  modelSupportsJsonSchemaResponseFormat,
  modelStructuredDecisionTransport,
  resolveModelMetadata,
  type ModelProviderId,
  type ProviderModelMetadata,
} from "../../packages/butler-agent/src/integrations/providers/model-catalog.ts";
import { ANTHROPIC_MODELS } from "../../packages/butler-agent/src/integrations/providers/anthropic/catalog.ts";
import { GOOGLE_MODELS } from "../../packages/butler-agent/src/integrations/providers/google/catalog.ts";
import { KIMI_MODELS } from "../../packages/butler-agent/src/integrations/providers/kimi/catalog.ts";
import { OPENCODE_GO_MODELS } from "../../packages/butler-agent/src/integrations/providers/opencode-go/catalog.ts";
import { OPENAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/openai/catalog.ts";
import { QWEN_MODELS } from "../../packages/butler-agent/src/integrations/providers/qwen/catalog.ts";
import { XAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/xai/catalog.ts";
import { ZAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/zai/catalog.ts";
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

test("namespaced hosted model metadata resolves duplicate model ids by provider", () => {
  const zaiGlm = resolveModelMetadata("zai/glm-5.2");
  const openCodeGoGlm = resolveModelMetadata("opencode-go/glm-5.2");

  expect(zaiGlm.provider_id).toBe("zai");
  expect(zaiGlm.hosted_api_shape).toBeUndefined();
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
