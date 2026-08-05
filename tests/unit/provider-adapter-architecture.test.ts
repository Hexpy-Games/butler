import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getRegisteredProviderAdapterDefinitions,
  providerCapabilitiesForModel,
  resolveProviderAdapterDefinition,
} from "../../packages/butler-agent/src/integrations/providers/registry.ts";

const providersRoot = join(
  import.meta.dir,
  "../../packages/butler-agent/src/integrations/providers",
);
test("provider registry resolves one adapter that owns catalog capabilities and invocation", () => {
  for (const adapter of getRegisteredProviderAdapterDefinitions()) {
    expect(resolveProviderAdapterDefinition(`${adapter.providerId}/test-model`)).toBe(adapter);
    expect(typeof adapter.capabilitiesFor).toBe("function");
    expect(typeof adapter.runPrompt).toBe("function");
    expect(typeof adapter.runRound).toBe("function");
    expect("runFunctionToolPrompt" in adapter).toBe(false);
  }
  expect(providerCapabilitiesForModel("openai/gpt-5.5").structuredDecisionTransport).toBe(
    "json_schema",
  );
  expect(providerCapabilitiesForModel("zai/glm-5.2").structuredDecisionTransport).toBe(
    "function_tool",
  );
  expect(providerCapabilitiesForModel("zai-api/glm-5.2").structuredDecisionTransport).toBe(
    "function_tool",
  );
});
test("provider directories own adapter catalog and runtime entrypoints", () => {
  for (const adapter of getRegisteredProviderAdapterDefinitions()) {
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
  expect(runtime.split("\n").length).toBeLessThan(120);
  for (const { providerId } of getRegisteredProviderAdapterDefinitions()) {
    expect(central).not.toContain(`providerId === "${providerId}"`);
    expect(central).not.toContain(`case "${providerId}"`);
  }
});
