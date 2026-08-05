import { expect, test } from "bun:test";
import { HOSTED_PROVIDER_MODELS } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-models.ts";
import {
  DEFAULT_MODEL_FALLBACK_SETTINGS,
  normalizeModelFallbackSettings,
} from "../../packages/butler-agent/src/gateways/app/domain/settings/settings-models.ts";
import type { ProviderModelMetadata } from "../../packages/butler-agent/src/integrations/providers/model-catalog.ts";

function registeredModel(
  modelRef: string,
  overrides: Partial<ProviderModelMetadata> = {},
): ProviderModelMetadata {
  const model = HOSTED_PROVIDER_MODELS.find(
    (candidate) => candidate.model_ref === modelRef,
  );
  if (!model) throw new Error(`Missing model fixture: ${modelRef}`);
  return { ...model, registered: true, ...overrides };
}

test("normalizes backup refs by registered runtime identity, family, primary, and cap", () => {
  const registered = [
    registeredModel("zai/glm-5.2"),
    registeredModel("zai-api/glm-5.2"),
    registeredModel("zai-api/glm-5.1"),
    registeredModel("zai-api/glm-5"),
    registeredModel("openai/gpt-5.5"),
    registeredModel("openai/gpt-5.6-sol"),
    registeredModel("anthropic/claude-opus-5"),
    registeredModel("zai/glm-4.7", { runtime_supported: false }),
    registeredModel("qwen/qwen3.7-max", { registered: false }),
  ];

  const normalized = normalizeModelFallbackSettings(
    {
      enabled: true,
      models: [
        "zai-api/glm-5.2",
        "zai-api/glm-5.1",
        "zai-api/glm-5",
        "openai/gpt-5.5",
        "openai/gpt-5.6-sol",
        "anthropic/claude-opus-5",
        "zai/glm-4.7",
        "qwen/qwen3.7-max",
        "not-a-model",
      ],
    },
    "zai/glm-5.2",
    registered,
  );

  expect(normalized).toEqual({
    enabled: true,
    models: [
      "zai-api/glm-5.1",
      "zai-api/glm-5",
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5",
    ],
  });
});

test("normalization uses the final primary identity and preserves the disabled default", () => {
  const registered = [
    registeredModel("openai/gpt-5.5"),
    registeredModel("openai/gpt-5.6-sol"),
  ];

  expect(
    normalizeModelFallbackSettings(
      { enabled: true, models: ["openai/gpt-5.5", "openai/gpt-5.6-sol"] },
      "openai/gpt-5.6-sol",
      registered,
    ),
  ).toEqual({ enabled: true, models: ["openai/gpt-5.5"] });
  expect(
    normalizeModelFallbackSettings(undefined, "openai/gpt-5.5", registered),
  ).toEqual(DEFAULT_MODEL_FALLBACK_SETTINGS);
});
