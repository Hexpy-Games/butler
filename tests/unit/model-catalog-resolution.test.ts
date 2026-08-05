import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import {
  findModelMetadata,
  resolveModelMetadata,
  resolveRegisteredRuntimeModelMetadata,
  resolveRuntimeModelMetadata,
  type ProviderModelMetadata,
} from "../../packages/butler-agent/src/integrations/providers/model-catalog.ts";
import {
  normalizeKnownModelRef,
  normalizeModelFallbackSettings,
} from "../../packages/butler-agent/src/gateways/app/domain/settings/settings-models.ts";
import { sanitizeSettingsUpdate } from "../../packages/butler-agent/src/gateways/app/domain/settings/settings-preferences.ts";
import {
  readRegisteredHostedModelConfigs,
  registeredHostedModelMetadata,
} from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import { buildModelRoute } from "../../packages/butler-agent/src/agent/btcc/model-route/identity.ts";

function registered(modelRef: string): ProviderModelMetadata {
  return {
    ...resolveModelMetadata(modelRef),
    registered: true,
  };
}

test("retired and missing persisted refs stay identifiable instead of falling back", () => {
  const retired = resolveRuntimeModelMetadata("anthropic/claude-opus-4-7");
  expect(retired).toMatchObject({
    model_ref: "anthropic/claude-opus-4-7",
    runtime_supported: false,
    status: "deprecated",
  });
  expect(retired.context_window_tokens).toBe(1_000_000);

  const missing = resolveRuntimeModelMetadata("openai/not-registered");
  expect(missing).toMatchObject({
    model_ref: "openai/not-registered",
    model_id: "not-registered",
    runtime_supported: false,
  });
  expect(missing.provider_id).toBe("openai");

  const registeredModels = [registered("openai/gpt-5.5")];
  expect(
    resolveRegisteredRuntimeModelMetadata(
      "anthropic/claude-opus-4-7",
      registeredModels,
    ).model_ref,
  ).toBe("anthropic/claude-opus-4-7");
  expect(
    resolveRegisteredRuntimeModelMetadata(
      "openai/not-registered",
      registeredModels,
    ).model_ref,
  ).toBe("openai/not-registered");
});

test("the declared auto Codex alias resolves to the current catalog target", () => {
  const metadata = resolveRuntimeModelMetadata("openai/auto:codex-latest");
  expect(metadata).toMatchObject({
    model_ref: "openai/gpt-5.6-sol",
    runtime_supported: true,
    status: "latest",
    context_window_tokens: 1_050_000,
  });
  expect(resolveModelMetadata("auto:codex-latest").model_ref).toBe(
    "openai/gpt-5.6-sol",
  );
});

test("only catalog-declared aliases resolve and ambiguous raw ids stay unavailable", () => {
  expect(resolveModelMetadata("openai/gpt-5.5-codex").model_ref).toBe(
    "openai/gpt-5.5",
  );
  expect(resolveModelMetadata("gpt-5.5-codex").model_ref).toBe(
    "openai/gpt-5.5",
  );

  const duplicateRawId = resolveModelMetadata("glm-5.2");
  expect(duplicateRawId).toMatchObject({
    model_ref: "custom/glm-5.2",
    runtime_supported: false,
  });

  const aliasTarget = registered("openai/gpt-5.5");
  const customAlias: ProviderModelMetadata = {
    ...aliasTarget,
    model_id: "gpt-legacy",
    model_ref: "openai/gpt-current",
    aliases: ["gpt-legacy", "openai/gpt-legacy"],
  };
  expect(findModelMetadata("gpt-legacy", [customAlias])?.model_ref).toBe(
    "openai/gpt-current",
  );
  expect(findModelMetadata("openai/gpt-legacy", [customAlias])?.model_ref).toBe(
    "openai/gpt-current",
  );
});

test("settings model selection accepts selectable refs and rejects stale refs", () => {
  const registeredModels = [
    registered("openai/gpt-5.5"),
    registered("zai/glm-5.2"),
    registered("zai-api/glm-5.2"),
  ];
  expect(normalizeKnownModelRef("openai/gpt-5.5-codex", registeredModels)).toBe(
    "openai/gpt-5.5",
  );
  expect(normalizeKnownModelRef("anthropic/claude-opus-4-7", registeredModels)).toBe(
    undefined,
  );
  expect(normalizeKnownModelRef("glm-5.2", registeredModels)).toBe(undefined);

  expect(
    sanitizeSettingsUpdate({ model: "anthropic/claude-opus-4-7" }, registeredModels),
  ).not.toHaveProperty("model");
  expect(
    sanitizeSettingsUpdate({ model: "openai/gpt-5.5-codex" }, registeredModels),
  ).toMatchObject({ model: "openai/gpt-5.5" });

  expect(
    normalizeModelFallbackSettings(
      {
        enabled: true,
        models: [
          "zai/glm-5.2",
          "anthropic/claude-opus-4-7",
          "openai/not-registered",
        ],
      },
      "openai/gpt-5.5",
      registeredModels,
    ),
  ).toEqual({ enabled: true, models: ["zai/glm-5.2"] });
});

test("runtime route preserves unavailable candidate refs for admission to surface", () => {
  const route = buildModelRoute({
    primaryModelRef: "openai/not-registered",
    backupModelRefs: ["openai/gpt-5.5"],
    reasoningEffort: "medium",
  });
  expect(route.candidates.map((candidate) => candidate.modelRef)).toEqual([
    "openai/not-registered",
    "openai/gpt-5.5",
  ]);
});

test("registered hosted model projection filters retired registrations without substitution", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-model-registration-"));
  try {
    const configPath = join(butlerData, "butler.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          registered: [
            {
              provider_id: "anthropic",
              model_ref: "anthropic/claude-opus-4-7",
              auth_type: "api_key",
              credential_id: "stale-credential",
            },
            {
              provider_id: "openai",
              model_id: "gpt-5.5",
              auth_type: "api_key",
              credential_id: "active-credential",
            },
          ],
        },
      }),
      "utf8",
    );

    expect(readRegisteredHostedModelConfigs(butlerData).map((model) => model.model_ref)).toEqual([
      "openai/gpt-5.5",
    ]);
    expect(registeredHostedModelMetadata(butlerData).map((model) => model.model_ref)).toEqual([
      "openai/gpt-5.5",
    ]);
    expect(JSON.parse(readFileSync(configPath, "utf8")).models.registered).toHaveLength(2);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
