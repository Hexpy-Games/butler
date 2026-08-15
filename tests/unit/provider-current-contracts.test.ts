import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptText } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { registerHostedModelConfig } from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import { hostedProviderBaseUrlEnvKey } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-client.ts";

let butlerData = "";
let originalFetch: typeof fetch;

beforeEach(() => {
  butlerData = mkdtempSync(join(tmpdir(), "butler-provider-contract-"));
  originalFetch = globalThis.fetch;
  process.env.BUTLER_DATA = butlerData;
  delete process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS;
  delete process.env.BUTLER_MODEL_API_RETRY_DELAY_MS;
  delete process.env.BUTLER_XAI_BASE_URL;
  delete process.env.BUTLER_ANTHROPIC_BASE_URL;
  delete process.env.BUTLER_GOOGLE_BASE_URL;
  delete process.env.BUTLER_KIMI_BASE_URL;
  delete process.env.BUTLER_QWEN_BASE_URL;
  delete process.env.BUTLER_ZAI_BASE_URL;
  delete process.env.BUTLER_ZAI_API_BASE_URL;
  delete process.env.BUTLER_OPENCODE_GO_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(butlerData, { recursive: true, force: true });
  delete process.env.BUTLER_DATA;
});

function register(providerId: Parameters<typeof registerHostedModelConfig>[0]["providerId"], modelId: string): void {
  registerHostedModelConfig({
    providerId,
    modelId,
    authType: "api_key",
    apiKey: `${providerId}-contract-secret`,
  }, butlerData);
}

test("Claude 5 uses adaptive thinking and nested effort without serializing none", async () => {
  register("anthropic", "claude-fable-5");
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "fable" }] }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "anthropic/claude-fable-5",
    reasoningEffort: "high",
    prompt: "hi",
  })).resolves.toBe("fable");
  await expect(runPromptText({
    model: "anthropic/claude-fable-5",
    reasoningEffort: "none",
    prompt: "hi",
  })).resolves.toBe("fable");

  expect(bodies[0]).toMatchObject({
    model: "claude-fable-5",
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });
  expect(bodies[1]).toMatchObject({ model: "claude-fable-5", thinking: { type: "adaptive" } });
  expect((bodies[1] as { output_config?: unknown }).output_config).toBeUndefined();
});

test("Gemini 3.x serializes the official thinking level under generationConfig", async () => {
  register("google", "gemini-3.6-flash");
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "gemini" }] } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;
  await expect(runPromptText({
    model: "google/gemini-3.6-flash",
    reasoningEffort: "high",
    prompt: "hi",
  })).resolves.toBe("gemini");
  expect(body).toMatchObject({
    generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
  });
});

test("Kimi uses thinking controls and omits fixed temperature", async () => {
  register("kimi", "kimi-k3");
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "kimi" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  await expect(runPromptText({
    model: "kimi/kimi-k3",
    reasoningEffort: "high",
    prompt: "hi",
  })).resolves.toBe("kimi");
  expect(body).toMatchObject({ model: "kimi-k3", reasoning_effort: "high" });
  expect(body.temperature).toBeUndefined();
  expect(body.max_tokens).toBeUndefined();
});

test("Qwen uses top-level enable_thinking without a guessed sampling override", async () => {
  register("qwen", "qwen3.7-max");
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "qwen" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  await expect(runPromptText({
    model: "qwen/qwen3.7-max",
    reasoningEffort: "none",
    prompt: "hi",
  })).resolves.toBe("qwen");
  expect(body).toMatchObject({ model: "qwen3.7-max", enable_thinking: false });
  expect(body.temperature).toBeUndefined();
});

test("xAI and OpenCode Go Responses models use their explicit Responses endpoints", async () => {
  register("xai", "grok-4.5");
  register("opencode-go", "gpt-5.6-luna");
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({
      id: "resp_contract",
      model: calls.at(-1)?.body.model,
      output: [{ type: "message", content: [{ type: "output_text", text: "responses" }] }],
    }), { status: 200 });
  }) as unknown as typeof fetch;
  await expect(runPromptText({
    model: "xai/grok-4.5",
    reasoningEffort: "high",
    prompt: "hi",
  })).resolves.toBe("responses");
  await expect(runPromptText({
    model: "opencode-go/gpt-5.6-luna",
    reasoningEffort: "medium",
    prompt: "hi",
  })).resolves.toBe("responses");
  expect(calls.map((call) => call.url)).toEqual([
    "https://api.x.ai/v1/responses",
    "https://opencode.ai/zen/go/v1/responses",
  ]);
  expect(calls[0]?.body).toMatchObject({ reasoning: { effort: "high" } });
  expect(calls[1]?.body).toMatchObject({ reasoning: { effort: "medium" } });
});

test("Z.AI Coding Plan and general API keep independent credentials and endpoints", async () => {
  register("zai", "glm-5.3");
  register("zai-api", "glm-5.2");
  const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(input),
      authorization: String(new Headers(init?.headers).get("authorization")),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "zai" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "zai/glm-5.3",
    reasoningEffort: "max",
    prompt: "coding",
  })).resolves.toBe("zai");
  await expect(runPromptText({ model: "zai-api/glm-5.2", prompt: "platform" })).resolves.toBe("zai");

  expect(calls.map((call) => call.url)).toEqual([
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
    "https://api.z.ai/api/paas/v4/chat/completions",
  ]);
  expect(calls.map((call) => call.authorization)).toEqual([
    "Bearer zai-contract-secret",
    "Bearer zai-api-contract-secret",
  ]);
  expect(calls.map((call) => call.body.model)).toEqual(["glm-5.3", "glm-5.2"]);
  expect(calls[0]?.body.reasoning_effort).toBe("max");
});

test("Z.AI endpoint environment keys remain distinct", () => {
  expect(hostedProviderBaseUrlEnvKey("zai")).toBe("BUTLER_ZAI_BASE_URL");
  expect(hostedProviderBaseUrlEnvKey("zai-api")).toBe("BUTLER_ZAI_API_BASE_URL");
});

test("Z.AI API honors only its own explicit base URL", async () => {
  register("zai-api", "glm-5.2");
  process.env.BUTLER_ZAI_API_BASE_URL = "https://zai-api.example.test/v1";
  let seenUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    seenUrl = String(input);
    return new Response(JSON.stringify({ choices: [{ message: { content: "custom" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({ model: "zai-api/glm-5.2", prompt: "custom" })).resolves.toBe("custom");
  expect(seenUrl).toBe("https://zai-api.example.test/v1/chat/completions");
});
