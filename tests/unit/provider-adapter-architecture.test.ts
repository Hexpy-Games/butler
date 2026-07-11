import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/anthropic/adapter.ts";
import { GOOGLE_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/google/adapter.ts";
import { KIMI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/kimi/adapter.ts";
import { LOCAL_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/local/adapter.ts";
import { OPENAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/openai/adapter.ts";
import { OPENCODE_GO_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/opencode-go/adapter.ts";
import { QWEN_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/qwen/adapter.ts";
import {
  providerCapabilitiesForModel,
  resolveProviderAdapterDefinition,
} from "../../packages/butler-agent/src/integrations/providers/registry.ts";
import { XAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/xai/adapter.ts";
import { ZAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/zai/adapter.ts";

const providersRoot = join(
  import.meta.dir,
  "../../packages/butler-agent/src/integrations/providers",
);
const adapters = [
  OPENAI_PROVIDER_ADAPTER,
  ANTHROPIC_PROVIDER_ADAPTER,
  GOOGLE_PROVIDER_ADAPTER,
  XAI_PROVIDER_ADAPTER,
  QWEN_PROVIDER_ADAPTER,
  KIMI_PROVIDER_ADAPTER,
  ZAI_PROVIDER_ADAPTER,
  OPENCODE_GO_PROVIDER_ADAPTER,
  LOCAL_PROVIDER_ADAPTER,
];

test("provider registry resolves one adapter that owns catalog capabilities and invocation", () => {
  for (const adapter of adapters) {
    expect(resolveProviderAdapterDefinition(`${adapter.providerId}/test-model`)).toBe(adapter);
    expect(typeof adapter.capabilitiesFor).toBe("function");
    expect(typeof adapter.runPrompt).toBe("function");
    expect(typeof adapter.runFunctionToolPrompt).toBe("function");
  }
  expect(providerCapabilitiesForModel("openai/gpt-5.5").structuredDecisionTransport).toBe(
    "json_schema",
  );
  expect(providerCapabilitiesForModel("zai/glm-5.2").structuredDecisionTransport).toBe(
    "function_tool",
  );
});
test("provider directories own adapter catalog and runtime entrypoints", () => {
  for (const adapter of adapters) {
    const providerDir = join(providersRoot, adapter.providerId);
    expect(existsSync(join(providerDir, "adapter.ts"))).toBe(true);
    expect(existsSync(join(providerDir, "catalog.ts"))).toBe(true);
    expect(existsSync(join(providerDir, "runtime.ts"))).toBe(true);
  }
});

test("central provider facade and runtime contain no provider-specific dispatch", () => {
  const facade = readFileSync(join(providersRoot, "provider.ts"), "utf8");
  const runtime = readFileSync(join(providersRoot, "runtime.ts"), "utf8");
  const central = `${facade}\n${runtime}`;
  expect(facade.split("\n").length).toBeLessThan(30);
  expect(runtime.split("\n").length).toBeLessThan(80);
  for (const providerId of [
    "openai",
    "anthropic",
    "google",
    "xai",
    "qwen",
    "kimi",
    "zai",
    "opencode-go",
    "local",
  ]) {
    expect(central).not.toContain(`providerId === "${providerId}"`);
    expect(central).not.toContain(`case "${providerId}"`);
  }
});
