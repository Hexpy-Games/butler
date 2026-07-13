import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnthropicFunctionToolPromptText } from "../../packages/butler-agent/src/integrations/providers/anthropic/runtime.ts";
import { runGeminiFunctionToolPromptText } from "../../packages/butler-agent/src/integrations/providers/google/runtime.ts";
import { runLocalFunctionToolPromptTextWithConfig } from "../../packages/butler-agent/src/integrations/providers/local/execution.ts";
import type { LocalModelConfig } from "../../packages/butler-agent/src/integrations/providers/local/models.ts";
import { runOpenAIFunctionToolPromptText } from "../../packages/butler-agent/src/integrations/providers/openai/tool-runtime.ts";
import type {
  FunctionToolPromptOptions,
  PromptUsageReport,
} from "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";
import { runHostedOpenAICompatibleFunctionToolPromptText } from "../../packages/butler-agent/src/integrations/providers/shared/hosted-chat-tool-runtime.ts";
import type { HostedRuntimeConfig } from "../../packages/butler-agent/src/integrations/providers/shared/model-routing.ts";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

type ProviderFamily = "openai" | "hosted-chat" | "anthropic" | "google" | "local";

interface ProviderHarness {
  family: ProviderFamily;
  run(options: FunctionToolPromptOptions): Promise<string>;
  response(round: number): Record<string, unknown>;
}

test("every provider family preserves decisions results and usage across native tool rounds", async () => {
  for (const harness of providerHarnesses()) {
    const operations: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const requestRounds: number[] = [];
    const admittedRequests: Array<{
      roundIndex: number;
      admittedPromptTokens: number;
      requestedOutputTokens: number;
      requestHash: string;
    }> = [];
    const usageReports: Array<PromptUsageReport & { outputTokens: number; roundIndex: number }> = [];
    let responseRound = 0;
    globalThis.fetch = (async (_url, init) => {
      responseRound += 1;
      operations.push(`model:${responseRound}`);
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json(harness.response(responseRound));
    }) as typeof fetch;

    const result = await harness.run({
      prompt: "Complete two evidence steps and report.",
      instructions: "Use the probe tool and keep each decision explicit.",
      model: modelForFamily(harness.family),
      maxToolRounds: 4,
      butlerData: makeTempDir(harness.family),
      tools: [{
        type: "function",
        name: "probe",
        description: "Produce deterministic evidence for one step.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { step: { type: "number" } },
          required: ["step"],
        },
      }],
      usageAttribution: {
        turnId: `turn-conformance-${harness.family}`,
        requestedOutputTokens: 1024,
        beforeModelRequest: ({ roundIndex }) => requestRounds.push(roundIndex),
        beforeAdmittedModelRequest: (request) => admittedRequests.push(request),
        afterModelResponseUsage: (usage) => usageReports.push(usage),
      },
      onAssistantTextBeforeTools: async ({ text, toolCalls }) => {
        const step = Number(toolCalls[0]?.args.step);
        expect(text).toContain(`title: Evidence step ${step}`);
        operations.push(`decision:${step}`);
      },
      executeTool: async (call) => {
        const step = Number(call.args.step);
        operations.push(`tool:${step}`);
        return { evidence: `evidence-step-${step}` };
      },
    });

    expect(result, harness.family).toBe("Provider loop complete.");
    expect(requestRounds, harness.family).toEqual([0, 1, 2]);
    expect(usageReports.map((usage) => usage.roundIndex), harness.family).toEqual([0, 1, 2]);
    expect(admittedRequests.map((request) => request.roundIndex), harness.family).toEqual([0, 1, 2]);
    expect(admittedRequests.every((request) =>
      request.admittedPromptTokens > 0 &&
      request.requestedOutputTokens === 1024 &&
      /^[a-f0-9]{64}$/u.test(request.requestHash),
    ), harness.family).toBe(true);
    expect(usageReports.every((usage) =>
      (usage.promptTokens ?? 0) > 0 && usage.cachedTokens <= (usage.promptTokens ?? 0),
    ), harness.family).toBe(true);
    expect(operations, harness.family).toEqual([
      "model:1",
      "decision:1",
      "tool:1",
      "model:2",
      "decision:2",
      "tool:2",
      "model:3",
    ]);
    expect(JSON.stringify(bodies[1]), harness.family).toContain("butler.completed-tool-evidence.v1");
    expect(JSON.stringify(bodies[2]), harness.family).toContain("butler.completed-tool-evidence.v1");
    expect(JSON.stringify(bodies[1]), harness.family).toContain("butler.evidence-packet.v1");
    expect(JSON.stringify(bodies[2]), harness.family).toContain("butler.evidence-packet.v1");
  }
});

test("every provider family continues a rejected final candidate in the same native conversation", async () => {
  for (const harness of providerHarnesses()) {
    const operations: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    let responseRound = 0;
    globalThis.fetch = (async (_url, init) => {
      responseRound += 1;
      operations.push(`model:${responseRound}`);
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const response = responseRound === 1
        ? harness.response(1)
        : responseRound === 2
        ? prematureFinalResponse(harness.family)
        : responseRound === 3
        ? harness.response(2)
        : harness.response(3);
      return Response.json(response);
    }) as typeof fetch;

    const result = await harness.run({
      prompt: "Complete two evidence steps and report.",
      instructions: "Use the probe tool and keep the same provider conversation until complete.",
      model: modelForFamily(harness.family),
      maxToolRounds: 5,
      butlerData: makeTempDir(`${harness.family}-candidate-review`),
      tools: [{
        type: "function",
        name: "probe",
        description: "Produce deterministic evidence for one step.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { step: { type: "number" } },
          required: ["step"],
        },
      }],
      reviewFinalCandidate: ({ text }) => {
        operations.push(`review:${text.startsWith("Premature") ? "continue" : "accept"}`);
        return text.startsWith("Premature")
          ? { status: "continue", observation: "Structured completion observation: evidence step 2 is still required." }
          : { status: "accepted" };
      },
      onAssistantTextBeforeTools: ({ toolCalls }) => {
        operations.push(`decision:${Number(toolCalls[0]?.args.step)}`);
      },
      executeTool: async (call) => {
        const step = Number(call.args.step);
        operations.push(`tool:${step}`);
        return { evidence: `evidence-step-${step}` };
      },
    });

    expect(result, harness.family).toBe("Provider loop complete.");
    expect(responseRound, harness.family).toBe(4);
    expect(operations, harness.family).toEqual([
      "model:1",
      "decision:1",
      "tool:1",
      "model:2",
      "review:continue",
      "model:3",
      "decision:2",
      "tool:2",
      "model:4",
      "review:accept",
    ]);
    expect(JSON.stringify(bodies[2]), harness.family).toContain("Structured completion observation");
  }
});

function providerHarnesses(): ProviderHarness[] {
  return [
    {
      family: "openai",
      run: async (options) => await runOpenAIFunctionToolPromptText(
        options,
        { authorization: "Bearer test", mode: "api_key" },
        "gpt-5.5",
      ),
      response: openAIResponse,
    },
    {
      family: "hosted-chat",
      run: async (options) => await runHostedOpenAICompatibleFunctionToolPromptText(
        hostedConfig("zai", "glm-5.2"),
        options,
      ),
      response: openAICompatibleResponse,
    },
    {
      family: "anthropic",
      run: async (options) => await runAnthropicFunctionToolPromptText(
        hostedConfig("anthropic", "claude-sonnet-4-6"),
        options,
      ),
      response: anthropicResponse,
    },
    {
      family: "google",
      run: async (options) => await runGeminiFunctionToolPromptText(
        hostedConfig("google", "gemini-3.1-pro"),
        options,
      ),
      response: geminiResponse,
    },
    {
      family: "local",
      run: async (options) => await runLocalFunctionToolPromptTextWithConfig(
        localConfig(),
        options,
      ),
      response: localResponse,
    },
  ];
}

function decisionText(step: number): string {
  return [
    `title: Evidence step ${step}`,
    `summary: Verify evidence step ${step}.`,
    "rationale: The next action depends on the exact observed result.",
    "next_step: Return this result before choosing the following step.",
  ].join("\n");
}

function openAIResponse(round: number): Record<string, unknown> {
  const output = round <= 2
    ? [
      { type: "message", content: [{ type: "output_text", text: decisionText(round) }] },
      {
        type: "function_call",
        call_id: `call-${round}`,
        name: "probe",
        arguments: JSON.stringify({ step: round }),
      },
    ]
    : [{
      type: "message",
      content: [{ type: "output_text", text: "Provider loop complete." }],
    }];
  return {
    id: `response-${round}`,
    output,
    usage: { input_tokens: 10 + round, output_tokens: 2, total_tokens: 12 + round },
  };
}

function openAICompatibleResponse(round: number): Record<string, unknown> {
  const message = round <= 2
    ? {
      role: "assistant",
      content: decisionText(round),
      tool_calls: [{
        id: `call-${round}`,
        type: "function",
        function: { name: "probe", arguments: JSON.stringify({ step: round }) },
      }],
    }
    : { role: "assistant", content: "Provider loop complete." };
  return {
    choices: [{ message }],
    usage: { prompt_tokens: 10 + round, completion_tokens: 2, total_tokens: 12 + round },
  };
}

function anthropicResponse(round: number): Record<string, unknown> {
  const content = round <= 2
    ? [
      { type: "text", text: decisionText(round) },
      { type: "tool_use", id: `call-${round}`, name: "probe", input: { step: round } },
    ]
    : [{ type: "text", text: "Provider loop complete." }];
  return {
    content,
    usage: { input_tokens: 10 + round, output_tokens: 2, cache_read_input_tokens: round },
  };
}

function geminiResponse(round: number): Record<string, unknown> {
  const parts = round <= 2
    ? [
      { text: decisionText(round) },
      { functionCall: { name: "probe", args: { step: round } } },
    ]
    : [{ text: "Provider loop complete." }];
  return {
    candidates: [{ content: { role: "model", parts } }],
    usageMetadata: {
      promptTokenCount: 10 + round,
      candidatesTokenCount: 2,
      totalTokenCount: 12 + round,
      cachedContentTokenCount: round,
    },
  };
}

function localResponse(round: number): Record<string, unknown> {
  if (round <= 2) return openAICompatibleResponse(round);
  return {
    choices: [{
      message: {
        role: "assistant",
        content: "<butler_final_answer>Provider loop complete.</butler_final_answer>",
      },
    }],
    usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
  };
}

function prematureFinalResponse(family: ProviderFamily): Record<string, unknown> {
  if (family === "openai") {
    return {
      id: "response-premature",
      output: [{ type: "message", content: [{ type: "output_text", text: "Premature final." }] }],
      usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
    };
  }
  if (family === "anthropic") {
    return {
      content: [{ type: "text", text: "Premature final." }],
      usage: { input_tokens: 12, output_tokens: 2 },
    };
  }
  if (family === "google") {
    return {
      candidates: [{ content: { role: "model", parts: [{ text: "Premature final." }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 },
    };
  }
  const content = family === "local"
    ? "<butler_final_answer>Premature final.</butler_final_answer>"
    : "Premature final.";
  return {
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  };
}

function hostedConfig(
  providerId: "zai" | "anthropic" | "google",
  modelId: string,
): HostedRuntimeConfig {
  return {
    providerId,
    modelId,
    modelRef: `${providerId}/${modelId}`,
    authType: "api_key",
    apiKey: "test",
    apiBaseUrl: `https://${providerId}.example/v1`,
  };
}

function localConfig(): LocalModelConfig {
  return {
    provider_id: "local",
    provider_label: "Local",
    model_id: "conformance",
    model_ref: "local/conformance",
    display_name: "Conformance",
    api_type: "openai_compatible",
    platform: "custom",
    server_url: "http://local.example",
    api_base_url: "http://local.example/v1",
    context_window_tokens: 32_768,
    max_output_tokens: 4_096,
    token_estimator: "character_estimate",
    source: "manual",
    source_url: "https://local.example",
    runtime_supported: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function modelForFamily(family: ProviderFamily): string {
  if (family === "openai") return "openai/gpt-5.5";
  if (family === "hosted-chat") return "zai/glm-5.2";
  if (family === "anthropic") return "anthropic/claude-sonnet-4-6";
  if (family === "google") return "google/gemini-3.1-pro";
  return "local/conformance";
}

function makeTempDir(family: string): string {
  const path = join(tmpdir(), `butler-provider-conformance-${family}-${Date.now()}-${Math.random()}`);
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}
