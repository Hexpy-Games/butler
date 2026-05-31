import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getModelProviderControlStatus,
  renderModelProviderControlStatus,
} from "../../packages/butler-agent/src/integrations/providers/control-plane.ts";
import { appendPromptCacheMetric } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-model-provider-"));
  process.env.BUTLER_DATA = tempDir;
  delete process.env.OPENAI_API_KEY;
  delete process.env.BUTLER_CODEX_AUTH_PROFILE;
  delete process.env.BUTLER_OPENAI_AUTH_PROFILE;
  process.env.CODEX_AUTH_JSON = join(tempDir, "missing-codex-auth.json");
  delete process.env.BUTLER_OPENAI_MODEL;
  delete process.env.CODEX_AUTH_JSON;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.BUTLER_DATA;
  delete process.env.OPENAI_API_KEY;
  delete process.env.BUTLER_OPENAI_MODEL;
});

test("model provider control status separates runtime provider model auth and cache", () => {
  process.env.OPENAI_API_KEY = "secret";
  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    system: {
      runtime: "codex-api",
      openaiModel: "gpt-5.5-codex",
      openaiPromptCacheKeyPrefix: "butler-test",
      openaiPromptCacheRetention: "24h",
    },
  }), "utf8");
  appendPromptCacheMetric({
    ts: Date.now(),
    model: "gpt-5.5-codex",
    scope: "unit",
    promptTokens: 100,
    cachedTokens: 40,
    totalTokens: 140,
    promptCacheKey: "butler-test:unit",
    promptCacheRetention: "24h",
  });

  const status = getModelProviderControlStatus({
    cacheScope: "unit",
    sinceTs: Date.now() - 60_000,
  });

  expect(status).toMatchObject({
    runtime: "codex-api",
    provider: "openai",
    model: "gpt-5.5-codex",
    modelRef: "openai/gpt-5.5-codex",
    auth: {
      configured: true,
      mode: "api_key",
      source: "OPENAI_API_KEY",
    },
    promptCache: {
      supported: true,
      configured: true,
      retention: "24h",
      effectiveKey: "butler-test:unit",
      telemetry: {
        requestCount: 1,
        promptTokens: 100,
        cachedTokens: 40,
      },
    },
  });
  expect(renderModelProviderControlStatus(status)).toContain("Provider: openai");
  expect(renderModelProviderControlStatus(status)).toContain("Prompt cache telemetry: requests=1 cached=40/100 hit=40.0%");
});

test("model provider control status reports missing auth without leaking secrets", () => {
  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    system: {
      openaiModel: "openai/gpt-5.5",
    },
  }), "utf8");

  const rendered = renderModelProviderControlStatus(getModelProviderControlStatus({
    authOverride: null,
  }));

  expect(rendered).toContain("Runtime: codex-api");
  expect(rendered).toContain("Provider: openai");
  expect(rendered).toContain("Model: gpt-5.5");
  expect(rendered).toContain("Auth: missing");
  expect(rendered).not.toContain("secret");
});
