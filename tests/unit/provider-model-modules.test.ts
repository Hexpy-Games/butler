import { test, expect } from "bun:test";
import {
  listModelMetadata,
  modelSupportsJsonSchemaResponseFormat,
  modelStructuredDecisionTransport,
  resolveModelMetadata,
  type ModelProviderId,
  type ProviderModelMetadata,
} from "../../packages/butler-agent/src/integrations/providers/model-catalog.ts";
import { ANTHROPIC_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/anthropic.ts";
import { GOOGLE_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/google.ts";
import { KIMI_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/kimi.ts";
import { OPENCODE_GO_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/opencode-go.ts";
import { OPENAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/openai.ts";
import { QWEN_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/qwen.ts";
import { XAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/xai.ts";
import { ZAI_MODELS } from "../../packages/butler-agent/src/integrations/providers/model-catalog/zai.ts";

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
  expect(modelSupportsJsonSchemaResponseFormat("openai/gpt-5.5")).toBe(true);
  expect(modelSupportsJsonSchemaResponseFormat("zai/glm-5.2")).toBe(false);
  expect(modelSupportsJsonSchemaResponseFormat("anthropic/claude-opus-4-6")).toBe(false);
  expect(modelSupportsJsonSchemaResponseFormat("google/gemini-3.1-pro-preview")).toBe(false);
  expect(modelSupportsJsonSchemaResponseFormat("opencode-go/glm-5.2")).toBe(false);
  expect(modelStructuredDecisionTransport("openai/gpt-5.5")).toBe("json_schema");
  expect(modelStructuredDecisionTransport("zai/glm-5.2")).toBe("function_tool");
  expect(modelStructuredDecisionTransport("anthropic/claude-opus-4-6")).toBe("function_tool");
  expect(modelStructuredDecisionTransport("google/gemini-3.1-pro-preview")).toBe("function_tool");
});
