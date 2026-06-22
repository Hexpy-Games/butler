import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import type { WebSearchProvider } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import type { RuntimeTurnEventInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";

let tempDir = "";
let originalButlerData: string | undefined;

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

const promotionProvider: ModelProviderAdapter = {
  ...fakeProvider,
  capabilities: {
    ...fakeProvider.capabilities,
    supportsSameTurnToolSchemaPromotion: true,
  },
};

const fakeWebSearchProvider: WebSearchProvider = {
  id: "fixture-search",
  async search(input) {
    return {
      query: input.query,
      results: [{
        title: "Fixture source",
        url: "https://example.com/source",
        snippet: "Fixture search result.",
        source: "example.com",
      }],
      duration_ms: 1,
      provider: "fixture-search",
      usage: { search_requests: 1 },
    };
  },
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-progressive-runtime-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("native runtime executes tool_search tool_describe and tool_call in one model turn", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const observedToolResults: Record<string, unknown> = {};
  let initialToolNames: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: fakeWebSearchProvider,
    runFunctionToolPromptText: async (input) => {
      initialToolNames = input.tools.map((tool) => tool.name);
      observedToolResults.search = await input.executeTool({
        name: "tool_search",
        args: { provider: "native", query: "web search", limit: 5 },
        rawArguments: JSON.stringify({ provider: "native", query: "web search", limit: 5 }),
      });
      observedToolResults.callBeforeDescribe = await input.executeTool({
        name: "tool_call",
        args: { id: "native:web_search", arguments: { query: "butler release" } },
        rawArguments: JSON.stringify({ id: "native:web_search", arguments: { query: "butler release" } }),
      });
      observedToolResults.describe = await input.executeTool({
        name: "tool_describe",
        args: { ids: ["native:web_search"] },
        rawArguments: JSON.stringify({ ids: ["native:web_search"] }),
      });
      observedToolResults.call = await input.executeTool({
        name: "tool_call",
        args: { id: "native:web_search", arguments: { query: "butler release", max_results: 1 } },
        rawArguments: JSON.stringify({ id: "native:web_search", arguments: { query: "butler release", max_results: 1 } }),
      });
      observedToolResults.recursion = await input.executeTool({
        name: "tool_call",
        args: { id: "native:tool_call", arguments: { id: "native:web_search", arguments: { query: "butler release" } } },
        rawArguments: JSON.stringify({
          id: "native:tool_call",
          arguments: { id: "native:web_search", arguments: { query: "butler release" } },
        }),
      });
      return "웹 검색 도구를 같은 턴에서 찾아 설명하고 호출했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/progressive-same-turn",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: fakeProvider,
    model: "openai/auto:codex-latest",
    input: { text: "현재 공개 정보를 확인해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  expect(initialToolNames).toEqual(expect.arrayContaining(["tool_search", "tool_describe", "tool_call"]));
  expect(initialToolNames).not.toContain("web_search");
  expect(observedToolResults.search).toEqual(expect.objectContaining({
    ok: true,
    results: expect.arrayContaining([expect.objectContaining({ id: "native:web_search" })]),
  }));
  expect(observedToolResults.callBeforeDescribe).toEqual(expect.objectContaining({
    ok: false,
    error: expect.objectContaining({ code: "tool_not_described", recoverable: true }),
  }));
  expect(observedToolResults.describe).toEqual(expect.objectContaining({
    ok: true,
    descriptions: [expect.objectContaining({
      id: "native:web_search",
      schema: expect.objectContaining({ type: "object" }),
      call_affordance: { type: "native_tool", tool_name: "web_search" },
    })],
  }));
  expect(observedToolResults.call).toEqual(expect.objectContaining({
    ok: true,
    provider: "fixture-search",
    bridge_invocation: { id: "native:web_search", provider: "native", affordance: "native_tool" },
  }));
  expect(observedToolResults.recursion).toEqual(expect.objectContaining({
    ok: false,
    error: expect.objectContaining({
      code: "disabled_tool",
      id: "native:tool_call",
      recoverable: true,
    }),
  }));

  const transcript = readTranscript("butler/main/progressive-same-turn");
  expect(transcript.some((event) => event.kind === "tool_result" && event.payload.name === "tool_search")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_result" && event.payload.name === "tool_describe")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_result" && event.payload.name === "tool_call")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_call" && event.payload.name === "web_search")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_result" && event.payload.name === "web_search")).toBe(true);
  expect(transcript.some((event) => {
    const bridgeAudit = event.metadata?.bridge_audit as { error?: { code?: string } } | undefined;
    return event.kind === "tool_result" &&
      event.payload.name === "tool_call" &&
      bridgeAudit?.error?.code === "disabled_tool";
  })).toBe(true);

  const startedIds = events
    .filter((event) => event.kind === "tool.started")
    .map((event) => event.payload?.toolCallId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const completedIds = new Set(events
    .filter((event) => event.kind === "tool.completed" || event.kind === "tool.failed")
    .map((event) => event.payload?.toolCallId)
    .filter((id): id is string => typeof id === "string" && id.length > 0));
  expect(startedIds.length).toBeGreaterThanOrEqual(3);
  expect(startedIds.every((id) => completedIds.has(id))).toBe(true);
});

test("native runtime exposes promoted dynamic schemas only for capable providers", async () => {
  let initialToolNames: string[] = [];
  let toolsBeforeDescribe: string[] = [];
  let toolsAfterDescribe: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: fakeWebSearchProvider,
    runFunctionToolPromptText: async (input) => {
      initialToolNames = input.tools.map((tool) => tool.name);
      toolsBeforeDescribe = input.dynamicTools?.().map((tool) => tool.name) ?? [];
      await input.executeTool({
        name: "tool_search",
        args: { provider: "native", query: "web search", limit: 5 },
        rawArguments: JSON.stringify({ provider: "native", query: "web search", limit: 5 }),
      });
      await input.executeTool({
        name: "tool_describe",
        args: { ids: ["native:web_search"] },
        rawArguments: JSON.stringify({ ids: ["native:web_search"] }),
      });
      toolsAfterDescribe = input.dynamicTools?.().map((tool) => tool.name) ?? [];
      const result = await input.executeTool({
        name: "web_search",
        args: { query: "butler release", max_results: 1 },
        rawArguments: JSON.stringify({ query: "butler release", max_results: 1 }),
      }) as { ok?: boolean; provider?: string };
      expect(result).toEqual(expect.objectContaining({ ok: true, provider: "fixture-search" }));
      return "웹 검색 도구를 provider-native schema promotion으로 호출했습니다.";
    },
  });
  const handle = await runtime.createSession({
    sessionId: "butler/main/progressive-promotion",
    role: "butler",
    workspacePath: tempDir,
    systemPrompt: "You are Butler.",
  });

  await runtime.runTurn({
    handle,
    provider: promotionProvider,
    model: "openai/auto:codex-latest",
    input: { text: "현재 공개 정보를 확인해줘" },
    metadata: { runtimePolicy: { completionReview: "disabled" } },
  });

  expect(initialToolNames).toEqual(expect.arrayContaining(["tool_search", "tool_describe", "tool_call"]));
  expect(initialToolNames).not.toContain("web_search");
  expect(toolsBeforeDescribe).not.toContain("web_search");
  expect(toolsAfterDescribe).toEqual(expect.arrayContaining(["tool_search", "tool_describe", "tool_call", "web_search"]));

  const transcript = readTranscript("butler/main/progressive-promotion");
  expect(transcript.some((event) => event.kind === "tool_call" && event.payload.name === "web_search")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_call" && event.payload.name === "tool_call")).toBe(false);
});
