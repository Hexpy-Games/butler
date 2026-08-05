import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModelRound, runPromptText } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { registerHostedModelConfig } from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";

let butlerData = "";
let originalFetch: typeof fetch;

beforeEach(() => {
  butlerData = mkdtempSync(join(tmpdir(), "butler-provider-retry-carrier-"));
  originalFetch = globalThis.fetch;
  process.env.BUTLER_DATA = butlerData;
  delete process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS;
  delete process.env.BUTLER_MODEL_API_RETRY_DELAY_MS;
  delete process.env.BUTLER_XAI_BASE_URL;
  delete process.env.BUTLER_OPENCODE_GO_BASE_URL;
  delete process.env.BUTLER_ANTHROPIC_BASE_URL;
  delete process.env.BUTLER_GOOGLE_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(butlerData, { recursive: true, force: true });
  delete process.env.BUTLER_DATA;
  delete process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS;
  delete process.env.BUTLER_MODEL_API_RETRY_DELAY_MS;
});

function registerHosted(providerId: "anthropic" | "google" | "xai" | "opencode-go", modelId: string): void {
  registerHostedModelConfig({
    providerId,
    modelId,
    authType: "api_key",
    apiKey: `${providerId}-test-key`,
  }, butlerData);
}

function registerLocal(): void {
  writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
    models: {
      local: [{
        provider_id: "local",
        provider_label: "Local",
        model_id: "fixture-model",
        model_ref: "local/fixture-model",
        display_name: "Fixture model",
        api_type: "openai_compatible",
        platform: "custom",
        server_url: "http://127.0.0.1:43123",
        api_base_url: "http://127.0.0.1:43123/v1",
        context_window_tokens: 32_768,
        max_output_tokens: 4_096,
        token_estimator: "character_estimate",
        source: "manual",
        source_url: "test",
        runtime_supported: true,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      }],
    },
  }), "utf8");
}

function roundRequest(model: string, providerRetryAttempts?: number) {
  return {
    model,
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [],
    ...(providerRetryAttempts === undefined ? {} : { providerRetryAttempts }),
  };
}

test("a routed one-attempt override produces one physical send for Anthropic, Gemini, and local", async () => {
  registerLocal();
  registerHosted("anthropic", "claude-fable-5");
  registerHosted("google", "gemini-3.6-flash");
  let sends = 0;
  globalThis.fetch = (async () => {
    sends += 1;
    return new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
      status: 503,
    });
  }) as unknown as typeof fetch;

  await expect(runModelRound(roundRequest("anthropic/claude-fable-5", 1))).rejects.toThrow();
  await expect(runModelRound(roundRequest("google/gemini-3.6-flash", 1))).rejects.toThrow();
  await expect(runModelRound(roundRequest("local/fixture-model", 1))).rejects.toThrow();

  expect(sends).toBe(3);
});

test("a non-routed provider request retains the configured default retry behavior", async () => {
  registerHosted("anthropic", "claude-fable-5");
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "2";
  process.env.BUTLER_MODEL_API_RETRY_DELAY_MS = "0";
  let sends = 0;
  globalThis.fetch = (async () => {
    sends += 1;
    return new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
      status: 503,
    });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "anthropic/claude-fable-5",
    prompt: "hello",
  })).rejects.toThrow();

  expect(sends).toBe(2);
});

test("Responses carriers replay provider function-call items before tool output", async () => {
  for (const [providerId, modelId] of [
    ["xai", "grok-4.5"],
    ["opencode-go", "gpt-5.6-luna"],
  ] as const) {
    registerHosted(providerId, modelId);
    const bodies: Record<string, any>[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          id: `${providerId}-response-1`,
          model: modelId,
          output: [{
            type: "function_call",
            call_id: `${providerId}-call-1`,
            name: "lookup",
            arguments: '{"query":"status"}',
            status: "completed",
            carrier_marker: "preserve-me",
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: `${providerId}-response-2`,
        model: modelId,
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "done" }],
        }],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await runModelRound({
      ...roundRequest(`${providerId}/${modelId}`, 1),
      tools: [{
        name: "lookup",
        description: "look up a status",
        parameters: { type: "object", properties: {} },
      }],
    });
    const second = await runModelRound({
      model: `${providerId}/${modelId}`,
      messages: [
        { role: "user", content: "hello" },
        first.assistantMessage!,
        {
          role: "tool",
          content: '{"ok":true}',
          toolCallId: `${providerId}-call-1`,
          name: "lookup",
        },
      ],
      tools: [],
      providerRetryAttempts: 1,
    });

    expect(second.text).toBe("done");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: "hello" },
      {
        type: "function_call",
        call_id: `${providerId}-call-1`,
        name: "lookup",
        arguments: '{"query":"status"}',
        status: "completed",
        carrier_marker: "preserve-me",
      },
      {
        type: "function_call_output",
        call_id: `${providerId}-call-1`,
        output: '{"ok":true}',
      },
    ]);
  }
});
