import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyShortCueRhythmGuard,
  applyShortUtteranceCorrectionGuard,
  NativeToolLoopRuntime,
} from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";

const fakeProvider: ModelProviderAdapter = {
  id: "fake-openai",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "unused" };
  },
};

type FixtureToolCall = {
  name: string;
  args: Record<string, unknown>;
  rawArguments: string;
};

type FixturePublicDecision = {
  text: string;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-conversation-quality-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function runRuntimeFixture(input: {
  userText: string;
  answer: string | ((input: {
    prompt: string;
    executeTool: (call: FixtureToolCall) => Promise<unknown>;
    onAssistantTextBeforeTools?: (message: FixturePublicDecision) => Promise<void> | void;
  }) => string | Promise<string>);
  executeTool?: (call: { name: string; args: Record<string, unknown> }) => Promise<unknown>;
}): Promise<{ text: string; prompts: string[]; tools: string[] }> {
  const prompts: string[] = [];
  const tools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    messageLanguage: "ko",
    disableAutomaticRecall: true,
    executeButlerTool: async (call) => {
      tools.push(call.name);
      if (input.executeTool) return input.executeTool(call);
      throw new Error(`unexpected tool ${call.name}`);
    },
    runFunctionToolPromptText: async (toolInput) => {
      prompts.push(toolInput.prompt);
      if (typeof input.answer === "function") {
        return input.answer({
          prompt: toolInput.prompt,
          executeTool: toolInput.executeTool,
          onAssistantTextBeforeTools: toolInput.onAssistantTextBeforeTools,
        });
      }
      return input.answer;
    },
  });
  const handle = await runtime.createSession({
    sessionId: `butler/quality-${Math.random().toString(36).slice(2)}`,
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });
  const result = await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: input.userText },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });
  return { text: result.text, prompts, tools };
}

test("runtime does not inject language-specific semantic policy dictionaries", async () => {
  const multilingualPolicyLikeRequests = [
    "내일 서울 날씨 어때?",
    "What is the latest price for the sample index?",
    "¿Cuál es el clima de Madrid mañana?",
    "Quali sono le notizie principali di oggi?",
    "今日の東京の天気を教えて",
  ];

  for (const userText of multilingualPolicyLikeRequests) {
    const result = await runRuntimeFixture({
      userText,
      answer: ({ prompt }) => {
        expect(prompt).not.toContain("Runtime Evidence Policy");
        expect(prompt).not.toContain("Freshness evidence required");
        expect(prompt).not.toContain("Correction challenge policy");
        expect(prompt).not.toContain("Short utterance intent policy");
        expect(prompt).not.toContain("Conversation context may be under-specified");
        return "모델의 의미 판단과 tool schema 계약에 따라 답합니다.";
      },
    });

    expect(result.tools).toEqual([]);
    expect(result.text).toContain("tool schema");
  }
});

test("model-selected multilingual tool calls execute without runtime semantic lexicons", async () => {
  const result = await runRuntimeFixture({
    userText: "¿Cuál es el clima de Madrid mañana?",
    executeTool: async (call) => {
      if (call.name === "web_search") {
        return {
          results: [{ title: "Madrid weather", url: "https://example.com/madrid-weather" }],
          source_urls: ["https://example.com/madrid-weather"],
        };
      }
      if (call.name === "web_read") {
        return {
          source_url: "https://example.com/madrid-weather",
          title: "Madrid weather",
          text: "Tomorrow in Madrid will be mild.",
        };
      }
      throw new Error(`unexpected tool ${call.name}`);
    },
    answer: async ({ prompt, executeTool, onAssistantTextBeforeTools }) => {
      expect(prompt).not.toContain("Freshness evidence required");
      await onAssistantTextBeforeTools?.({
        text: [
          "summary: Search for Madrid weather because the user asked for tomorrow's forecast.",
          "rationale: A current weather answer needs an external source selected by the model.",
          "next_step: Read the most relevant result before answering.",
        ].join("\n"),
        toolCalls: [{
          name: "web_search",
          args: { query: "Madrid weather tomorrow" },
        }],
      });
      await executeTool({
        name: "web_search",
        args: { query: "Madrid weather tomorrow" },
        rawArguments: "{\"query\":\"Madrid weather tomorrow\"}",
      });
      await onAssistantTextBeforeTools?.({
        text: [
          "summary: Read the selected Madrid weather source.",
          "rationale: The final answer should cite the checked source, not runtime keyword rules.",
          "next_step: Use the source text to answer with citations.",
        ].join("\n"),
        toolCalls: [{
          name: "web_read",
          args: { url: "https://example.com/madrid-weather" },
        }],
      });
      await executeTool({
        name: "web_read",
        args: { url: "https://example.com/madrid-weather" },
        rawArguments: "{\"url\":\"https://example.com/madrid-weather\"}",
      });
      return "Madrid tomorrow looks mild based on the checked source.";
    },
  });

  expect(result.tools).toEqual(["web_search", "web_read"]);
  expect(result.text).toContain("Madrid tomorrow");
  expect(result.text).toContain("Sources:");
  expect(result.text).toContain("https://example.com/madrid-weather");
});

test("short-cue helpers do not rewrite semantic content through phrase dictionaries", () => {
  const response = "맞습니다. 제가 틀렸습니다. 앞선 답변을 정정하겠습니다.";

  expect(applyShortUtteranceCorrectionGuard({
    userText: "유파",
    responseText: response,
    language: "ko",
  })).toBe(response);

  expect(applyShortCueRhythmGuard({
    userText: "짧은 호출!",
    responseText: "짧은 호출.\n\n테스트 사용자님, 호출하셨습니까?",
    language: "ko",
  })).toBe("짧은 호출.\n\n테스트 사용자님, 호출하셨습니까?");
});
