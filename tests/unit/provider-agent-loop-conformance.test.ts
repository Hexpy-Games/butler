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
  response(round: number, toolName?: string): Record<string, unknown>;
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
        concurrencySafe: true,
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
        return { message: `evidence-step-${step}` };
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
    expect(JSON.stringify(bodies[1]), harness.family).toContain("evidence-step-1");
    expect(JSON.stringify(bodies[2]), harness.family).toContain("evidence-step-2");
    expect(JSON.stringify(bodies[1]), harness.family).not.toContain("completed-tool-evidence");
    expect(JSON.stringify(bodies[2]), harness.family).not.toContain("completed-tool-evidence");
    expect(JSON.stringify(bodies[1]), harness.family).not.toContain("evidence_packet");
    expect(JSON.stringify(bodies[2]), harness.family).not.toContain("evidence_packet");
    expect(JSON.stringify(bodies), harness.family).not.toContain("concurrencySafe");
  }
});

test("every provider family executes all tool calls from one model response", async () => {
  for (const harness of providerHarnesses()) {
    const executedSteps: number[] = [];
    const visibleSteps: number[][] = [];
    let responseRound = 0;
    globalThis.fetch = (async () => {
      responseRound += 1;
      return Response.json(
        responseRound === 1
          ? providerBatchResponse(harness.family, 7)
          : harness.response(3),
      );
    }) as unknown as typeof fetch;

    const result = await harness.run({
      prompt: "Inspect all seven requested targets and report.",
      model: modelForFamily(harness.family),
      maxToolRounds: 2,
      butlerData: makeTempDir(`${harness.family}-full-tool-batch`),
      tools: [{
        type: "function",
        name: "probe",
        description: "Inspect one requested target.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { step: { type: "number" } },
          required: ["step"],
        },
      }],
      onAssistantTextBeforeTools: ({ toolCalls }) => {
        visibleSteps.push(toolCalls.map((call) => Number(call.args.step)));
      },
      executeTool: async (call) => {
        executedSteps.push(Number(call.args.step));
        return { observed: call.args.step };
      },
    });

    expect(result, harness.family).toBe("Provider loop complete.");
    expect(responseRound, harness.family).toBe(2);
    expect(visibleSteps, harness.family).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
    expect(executedSteps, harness.family).toEqual([1, 2, 3, 4, 5, 6, 7]);
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

test("every provider family retries one contentless response with a visible continuation observation", async () => {
  for (const harness of providerHarnesses()) {
    const bodies: Array<Record<string, unknown>> = [];
    let responseRound = 0;
    globalThis.fetch = (async (_url, init) => {
      responseRound += 1;
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json(
        responseRound === 1
          ? contentlessResponse(harness.family)
          : harness.response(3),
      );
    }) as typeof fetch;

    const result = await harness.run({
      prompt: "Recover from one contentless provider response.",
      model: modelForFamily(harness.family),
      maxToolRounds: 3,
      butlerData: makeTempDir(`${harness.family}-contentless-recovery`),
      tools: [],
      executeTool: async () => ({ unreachable: true }),
    });

    expect(result, harness.family).toBe("Provider loop complete.");
    expect(responseRound, harness.family).toBe(2);
    expect(JSON.stringify(bodies[1]), harness.family)
      .toContain("The previous response contained no text or tool call");
  }
});

test("every provider family returns unknown structured tools as correctable feedback", async () => {
  for (const harness of providerHarnesses()) {
    const bodies: Array<Record<string, unknown>> = [];
    let responseRound = 0;
    let executorCalls = 0;
    globalThis.fetch = (async (_url, init) => {
      responseRound += 1;
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json(
        responseRound === 1
          ? harness.response(1, "hallucinated_tool")
          : harness.response(3),
      );
    }) as typeof fetch;

    const result = await harness.run({
      prompt: "Recover from one unavailable tool and answer.",
      model: modelForFamily(harness.family),
      maxToolRounds: 3,
      butlerData: makeTempDir(`${harness.family}-unknown-tool`),
      tools: [{
        type: "function",
        name: "probe",
        description: "The only available tool.",
        parameters: { type: "object", properties: {} },
      }],
      executeTool: async () => {
        executorCalls += 1;
        return { unreachable: true };
      },
    });

    expect(result, harness.family).toBe("Provider loop complete.");
    expect(executorCalls, harness.family).toBe(0);
    expect(responseRound, harness.family).toBe(2);
    expect(JSON.stringify(bodies[1]), harness.family).toContain("tool_unavailable");
    expect(JSON.stringify(bodies[1]), harness.family).toContain("hallucinated_tool");
  }
});

test("every provider family receives bounded conversation context inline on the next request", async () => {
  for (const harness of providerHarnesses()) {
    const bodies: Array<Record<string, unknown>> = [];
    let responseRound = 0;
    globalThis.fetch = (async (_url, init) => {
      responseRound += 1;
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json(harness.response(
        responseRound === 1 ? 1 : 3,
        "read_conversation_context",
      ));
    }) as typeof fetch;

    const marker = `CONVERSATION_CONTEXT_${harness.family}`;
    const result = await harness.run({
      prompt: "Read the bounded conversation context once and report.",
      instructions: "Use read_conversation_context exactly once.",
      model: modelForFamily(harness.family),
      maxToolRounds: 2,
      butlerData: makeTempDir(`${harness.family}-conversation-context`),
      tools: [{
        type: "function",
        name: "read_conversation_context",
        description: "Return bounded canonical conversation context.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
        },
      }],
      onAssistantTextBeforeTools: async () => {},
      executeTool: async () => ({
        ok: true,
        session_id: "conversation-session",
        runtime_session_id: "private-runtime-session",
        query: null,
        anchor_message_id: null,
        anchor_event_id: null,
        direction: "around",
        returned: 1,
        truncated: false,
        messages: [{ text: marker, speaker: "user", role: "user", parts: [] }],
        summaries: [],
      }),
    });

    expect(result, harness.family).toBe("Provider loop complete.");
    expect(JSON.stringify(bodies[1]), harness.family).toContain(marker);
    expect(JSON.stringify(bodies[1]), harness.family).toContain("private-runtime-session");
  }
});

test("every provider family returns malformed and schema-invalid arguments for model correction", async () => {
  const invalidArguments: unknown[] = [
    "{malformed",
    ["not-an-object"],
    { mode: "unsupported", items: ["one", "two"] },
    { mode: "brief", items: ["one"] },
    { mode: "brief", items: ["one", "two"], extra_one: true, extra_two: true },
  ];
  for (const harness of providerHarnesses()) {
    const bodies: Array<Record<string, unknown>> = [];
    let responseRound = 0;
    let executorCalls = 0;
    globalThis.fetch = (async (_url, init) => {
      responseRound += 1;
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (responseRound <= invalidArguments.length) {
        return Response.json(providerArgumentResponse(
          harness.family,
          responseRound,
          invalidArguments[responseRound - 1],
        ));
      }
      if (responseRound === invalidArguments.length + 1) {
        return Response.json(providerArgumentResponse(
          harness.family,
          responseRound,
          { mode: "brief", items: ["one", "two"] },
        ));
      }
      return Response.json(harness.response(3));
    }) as typeof fetch;

    const result = await harness.run({
      prompt: "Correct invalid tool arguments, collect once, and report.",
      model: modelForFamily(harness.family),
      maxToolRounds: 8,
      butlerData: makeTempDir(`${harness.family}-invalid-tool-arguments`),
      tools: [{
        type: "function",
        name: "collect",
        description: "Collect typed values.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "items"],
          properties: {
            mode: { type: "string", enum: ["brief", "full"] },
            items: {
              type: "array",
              minItems: 2,
              items: { type: "string" },
            },
          },
        },
      }],
      executeTool: async () => {
        executorCalls += 1;
        return { collected: true };
      },
    });

    expect(result, harness.family).toBe("Provider loop complete.");
    expect(executorCalls, harness.family).toBe(1);
    expect(responseRound, harness.family).toBe(7);
    expect(JSON.stringify(bodies[1]), harness.family).toContain("malformed JSON arguments");
    expect(JSON.stringify(bodies[1]), harness.family).toContain("{malformed");
    expect(JSON.stringify(bodies[2]), harness.family).toContain("JSON object");
    expect(JSON.stringify(bodies[3]), harness.family).toContain("Invalid enum value at $.mode");
    expect(JSON.stringify(bodies[4]), harness.family).toContain("Expected at least 2 items at $.items");
    expect(JSON.stringify(bodies[5]), harness.family).toContain("extra_one, extra_two");
    expect(JSON.stringify(bodies[5]).match(/tool_invalid_arguments/gu)?.length ?? 0, harness.family)
      .toBeGreaterThan(0);
    expect(JSON.stringify(bodies[6]), harness.family).toContain("collected");
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

function providerBatchResponse(
  family: ProviderFamily,
  count: number,
): Record<string, unknown> {
  const steps = Array.from({ length: count }, (_, index) => index + 1);
  const text = "Inspect all requested targets before reporting.";
  if (family === "openai") {
    return {
      id: "response-batch",
      output: [
        { type: "message", content: [{ type: "output_text", text }] },
        ...steps.map((step) => ({
          type: "function_call",
          call_id: `call-${step}`,
          name: "probe",
          arguments: JSON.stringify({ step }),
        })),
      ],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
  }
  if (family === "anthropic") {
    return {
      content: [
        { type: "text", text },
        ...steps.map((step) => ({
          type: "tool_use",
          id: `call-${step}`,
          name: "probe",
          input: { step },
        })),
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  }
  if (family === "google") {
    return {
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text },
            ...steps.map((step) => ({
              functionCall: { name: "probe", args: { step } },
            })),
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        totalTokenCount: 12,
      },
    };
  }
  return {
    choices: [{
      message: {
        role: "assistant",
        content: text,
        tool_calls: steps.map((step) => ({
          id: `call-${step}`,
          type: "function",
          function: { name: "probe", arguments: JSON.stringify({ step }) },
        })),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

function providerArgumentResponse(
  family: ProviderFamily,
  round: number,
  rawArguments: unknown,
): Record<string, unknown> {
  const text = `Correct tool arguments round ${round}.`;
  const stringArguments = typeof rawArguments === "string"
    ? rawArguments
    : JSON.stringify(rawArguments);
  if (family === "openai") {
    return {
      id: `response-arguments-${round}`,
      output: [
        { type: "message", content: [{ type: "output_text", text }] },
        {
          type: "function_call",
          call_id: `call-arguments-${round}`,
          name: "collect",
          arguments: stringArguments,
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
  }
  if (family === "anthropic") {
    return {
      content: [
        { type: "text", text },
        {
          type: "tool_use",
          id: `call-arguments-${round}`,
          name: "collect",
          input: rawArguments,
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  }
  if (family === "google") {
    return {
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text },
            { functionCall: { name: "collect", args: rawArguments } },
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        totalTokenCount: 12,
      },
    };
  }
  return {
    choices: [{
      message: {
        role: "assistant",
        content: text,
        tool_calls: [{
          id: `call-arguments-${round}`,
          type: "function",
          function: { name: "collect", arguments: stringArguments },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

function openAIResponse(round: number, toolName = "probe"): Record<string, unknown> {
  const output = round <= 2
    ? [
      { type: "message", content: [{ type: "output_text", text: decisionText(round) }] },
      {
        type: "function_call",
        call_id: `call-${round}`,
        name: toolName,
        arguments: JSON.stringify(toolArguments(round, toolName)),
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

function openAICompatibleResponse(round: number, toolName = "probe"): Record<string, unknown> {
  const message = round <= 2
    ? {
      role: "assistant",
      content: decisionText(round),
      tool_calls: [{
        id: `call-${round}`,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(toolArguments(round, toolName)) },
      }],
    }
    : { role: "assistant", content: "Provider loop complete." };
  return {
    choices: [{ message }],
    usage: { prompt_tokens: 10 + round, completion_tokens: 2, total_tokens: 12 + round },
  };
}

function anthropicResponse(round: number, toolName = "probe"): Record<string, unknown> {
  const content = round <= 2
    ? [
      { type: "text", text: decisionText(round) },
      { type: "tool_use", id: `call-${round}`, name: toolName, input: toolArguments(round, toolName) },
    ]
    : [{ type: "text", text: "Provider loop complete." }];
  return {
    content,
    usage: { input_tokens: 10 + round, output_tokens: 2, cache_read_input_tokens: round },
  };
}

function geminiResponse(round: number, toolName = "probe"): Record<string, unknown> {
  const parts = round <= 2
    ? [
      { text: decisionText(round) },
      { functionCall: { name: toolName, args: toolArguments(round, toolName) } },
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

function localResponse(round: number, toolName = "probe"): Record<string, unknown> {
  if (round <= 2) return openAICompatibleResponse(round, toolName);
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

function toolArguments(round: number, toolName: string): Record<string, unknown> {
  return toolName === "read_conversation_context"
    ? { query: "deployment" }
    : { step: round };
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

function contentlessResponse(family: ProviderFamily): Record<string, unknown> {
  if (family === "openai") {
    return {
      id: "response-contentless",
      output: [],
      usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
    };
  }
  if (family === "anthropic") {
    return {
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    };
  }
  if (family === "google") {
    return {
      candidates: [{ content: { role: "model", parts: [] } }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 0,
        totalTokenCount: 10,
      },
    };
  }
  return {
    choices: [{ message: { role: "assistant", content: "" } }],
    usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
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
