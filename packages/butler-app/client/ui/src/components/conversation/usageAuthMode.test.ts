// test-category: race
import { describe, expect, test } from "bun:test";
import type { AppModelSummary, ContextDetailsView } from "@/app/types.ts";
import { contextModel, usageAuthMode } from "./usageAuthMode";

function model(fields: Partial<AppModelSummary> = {}): AppModelSummary {
  return {
    provider_id: "openai", provider_label: "OpenAI", model_id: "m", model_ref: "openai/m",
    display_name: "M", status: "available", default_reasoning_effort: "medium",
    reasoning_efforts: ["medium"], token_estimator: "tiktoken", runtime_supported: true, ...fields,
  };
}

const context = (fields: Partial<ContextDetailsView> = {}): ContextDetailsView => ({
  used_tokens: 1, budget_tokens: 10, ratio: 0.1, categories: [], ...fields,
});

describe("usageAuthMode", () => {
  test("codex OAuth is a subscription, an API key is api_key", () => {
    expect(usageAuthMode(model({ auth_type: "codex_oauth" }), context())).toBe("subscription");
    expect(usageAuthMode(model({ auth_type: "api_key" }), context())).toBe("api_key");
  });

  test("the local provider or a local platform is local, whatever the auth", () => {
    expect(usageAuthMode(model({ provider_id: "local" }), context())).toBe("local");
    expect(usageAuthMode(model({ platform: "ollama", auth_type: "api_key" }), context())).toBe("local");
    expect(usageAuthMode(null, context({ provider_id: "local" }))).toBe("local");
  });

  test("no model or no auth type is unknown", () => {
    expect(usageAuthMode(null, context())).toBe("unknown");
    expect(usageAuthMode(undefined, null)).toBe("unknown");
    expect(usageAuthMode(model(), context())).toBe("unknown");
  });
});

describe("contextModel", () => {
  const models = [model({ model_ref: "openai/a" }), model({ model_ref: "openai/b", auth_type: "api_key" })];

  test("matches the context's model_ref first", () => {
    expect(contextModel(models, context({ model_ref: "openai/b" }), models[0]!)?.model_ref).toBe("openai/b");
  });

  test("falls back to the active model when the context names none or an unknown one", () => {
    expect(contextModel(models, context(), models[0]!)?.model_ref).toBe("openai/a");
    expect(contextModel(models, context({ model_ref: "gone/x" }), null)).toBeNull();
  });
});
