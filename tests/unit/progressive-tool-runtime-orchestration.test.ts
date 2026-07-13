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

async function authorPublicDecisionForTool(
  input: {
    onAssistantTextBeforeTools?: (message: {
      text: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
    }) => Promise<void> | void;
  },
  call: { name: string; args: Record<string, unknown> },
  text: {
    title?: string;
    summary: string;
    rationale: string;
    nextStep: string;
  },
): Promise<void> {
  await input.onAssistantTextBeforeTools?.({
    text: [
      `title: ${text.title ?? `Use ${call.name.replaceAll("_", " ")}`}`,
      `summary: ${text.summary}`,
      `rationale: ${text.rationale}`,
      `next_step: ${text.nextStep}`,
    ].join("\n"),
    toolCalls: [call],
  });
}

test("native runtime executes tool_search tool_describe and tool_call in one model turn", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const observedToolResults: Record<string, unknown> = {};
  let initialToolNames: string[] = [];
  let initialToolSchemaJson = "";
  let grantedToolRounds: number | undefined;
  let budgetAtPromptStart: { status: string; requestCount: number; maxRequests: number } | undefined;
  let budgetAfterModelRequest: { status: string; requestCount: number; maxRequests: number } | undefined;
  let budgetAfterBridgeCalls: { status: string; requestCount: number; maxRequests: number } | undefined;
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: fakeWebSearchProvider,
    runFunctionToolPromptText: async (input) => {
      initialToolNames = input.tools.map((tool) => tool.name);
      initialToolSchemaJson = JSON.stringify(input.tools);
      grantedToolRounds = input.maxToolRounds;
      budgetAtPromptStart = input.usageAttribution?.getBudgetState?.();
      input.usageAttribution?.beforeModelRequest?.({ roundIndex: 0 });
      input.usageAttribution?.beforeAdmittedModelRequest?.({
        roundIndex: 0,
        phase: input.usageAttribution.phase,
        admittedPromptTokens: 100,
        requestedOutputTokens: input.usageAttribution.requestedOutputTokens ?? 0,
        requestHash: "progressive-tool-runtime-0",
      });
      budgetAfterModelRequest = input.usageAttribution?.getBudgetState?.();
      await authorPublicDecisionForTool(
        input,
        { name: "tool_search", args: { provider: "native", query: "web search", limit: 5 } },
        {
          summary: "Search the native tool catalog for web search.",
          rationale: "The orchestration test needs model-selected discovery before describing a concrete tool.",
          nextStep: "Use the search result to decide which native tool to describe.",
        },
      );
      observedToolResults.search = await input.executeTool({
        name: "tool_search",
        args: { provider: "native", query: "web search", limit: 5 },
        rawArguments: JSON.stringify({ provider: "native", query: "web search", limit: 5 }),
      });
      await authorPublicDecisionForTool(
        input,
        { name: "tool_call", args: { id: "native:web_search", arguments: { query: "butler release" } } },
        {
          summary: "Attempt the discovered native web search call before description.",
          rationale: "The test verifies that undescribed bridge calls remain recoverable.",
          nextStep: "Confirm the recoverable error before describing the tool.",
        },
      );
      observedToolResults.callBeforeDescribe = await input.executeTool({
        name: "tool_call",
        args: { id: "native:web_search", arguments: { query: "butler release" } },
        rawArguments: JSON.stringify({ id: "native:web_search", arguments: { query: "butler release" } }),
      });
      await authorPublicDecisionForTool(
        input,
        { name: "tool_describe", args: { ids: ["native:web_search"] } },
        {
          summary: "Describe the selected native web search tool.",
          rationale: "The model needs the promoted schema before a valid bridge invocation.",
          nextStep: "Use the described schema to call the native web search tool.",
        },
      );
      observedToolResults.describe = await input.executeTool({
        name: "tool_describe",
        args: { ids: ["native:web_search"] },
        rawArguments: JSON.stringify({ ids: ["native:web_search"] }),
      });
      await authorPublicDecisionForTool(
        input,
        { name: "tool_call", args: { id: "native:web_search", arguments: { query: "butler release", max_results: 1 } } },
        {
          summary: "Call the described native web search tool.",
          rationale: "The test verifies bridge audit and transcript records for a successful promoted call.",
          nextStep: "Use the search result to finish the orchestration turn.",
        },
      );
      observedToolResults.call = await input.executeTool({
        name: "tool_call",
        args: { id: "native:web_search", arguments: { query: "butler release", max_results: 1 } },
        rawArguments: JSON.stringify({ id: "native:web_search", arguments: { query: "butler release", max_results: 1 } }),
      });
      await authorPublicDecisionForTool(
        input,
        { name: "tool_call", args: { id: "native:tool_call", arguments: { id: "native:web_search", arguments: { query: "butler release" } } } },
        {
          summary: "Attempt a recursive bridge tool call.",
          rationale: "The bridge audit test must prove recursive tool_call is denied safely.",
          nextStep: "Record the denial without executing the nested call.",
        },
      );
      observedToolResults.recursion = await input.executeTool({
        name: "tool_call",
        args: { id: "native:tool_call", arguments: { id: "native:web_search", arguments: { query: "butler release" } } },
        rawArguments: JSON.stringify({
          id: "native:tool_call",
          arguments: { id: "native:web_search", arguments: { query: "butler release" } },
        }),
      });
      budgetAfterBridgeCalls = input.usageAttribution?.getBudgetState?.();
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
  expect(initialToolSchemaJson).not.toContain("\"web_search\"");
  expect(initialToolSchemaJson).not.toContain("Fixture source");
  expect(grantedToolRounds).toBe(60);
  expect(budgetAtPromptStart).toMatchObject({ status: "ok", requestCount: 0, maxRequests: 24 });
  expect(budgetAfterModelRequest).toMatchObject({ status: "ok", requestCount: 1, maxRequests: 24 });
  expect(budgetAfterBridgeCalls).toMatchObject({ status: "ok", requestCount: 1, maxRequests: 24 });
  expect(observedToolResults.search).toEqual(expect.objectContaining({
    ok: true,
    results: expect.arrayContaining([expect.objectContaining({ id: "native:web_search" })]),
  }));
  expect(observedToolResults.callBeforeDescribe).toEqual(expect.objectContaining({
    ok: false,
    observation_kind: "tool_unavailable",
    observation: expect.objectContaining({ kind: "tool_unavailable" }),
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
    observation_kind: "tool_unavailable",
    observation: expect.objectContaining({ kind: "tool_unavailable" }),
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
  expect(transcript.some((event) =>
    event.kind === "tool_call" &&
    event.payload.name === "tool_call" &&
    event.metadata?.tool_surface_transition === "invoke",
  )).toBe(true);
  expect(transcript.some((event) =>
    event.kind === "tool_result" &&
    event.payload.name === "tool_call" &&
    event.payload.ok === true &&
    event.metadata?.tool_surface_transition === "invoked",
  )).toBe(true);
  expect(transcript.some((event) =>
    event.kind === "tool_result" &&
    event.payload.name === "tool_call" &&
    event.payload.ok === false &&
    event.metadata?.tool_surface_transition === "denied",
  )).toBe(true);

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
  expect(events.findIndex((event) => event.kind === "tool.started")).toBeGreaterThanOrEqual(0);
  expect(events.findIndex((event) => event.kind === "tool.started")).toBeLessThan(
    events.findIndex((event) => event.kind === "message.final.started"),
  );
  const bridgeStarts = events.filter((event) =>
    event.kind === "tool.started" && event.payload?.toolName === "Tool Call",
  );
  const bridgeFinishes = events.filter((event) =>
    (event.kind === "tool.completed" || event.kind === "tool.failed") &&
    event.payload?.toolName === "Tool Call",
  );
  expect(bridgeStarts).toHaveLength(0);
  expect(bridgeFinishes).toHaveLength(0);
});

test("native runtime exposes promoted dynamic schemas only for capable providers", async () => {
  let initialToolNames: string[] = [];
  let toolsBeforeDescribe: string[] = [];
  let toolsAfterDescribe: string[] = [];
  let initialDynamicToolSchemaJson = "";
  let promotedDynamicToolSchemaJson = "";
  const runtime = new NativeToolLoopRuntime({
    disableAutomaticRecall: true,
    butlerHome: tempDir,
    butlerData: tempDir,
    webSearchProvider: fakeWebSearchProvider,
    runFunctionToolPromptText: async (input) => {
      initialToolNames = input.tools.map((tool) => tool.name);
      const dynamicBeforeDescribe = input.dynamicTools?.() ?? [];
      toolsBeforeDescribe = dynamicBeforeDescribe.map((tool) => tool.name);
      initialDynamicToolSchemaJson = JSON.stringify(dynamicBeforeDescribe);
      await authorPublicDecisionForTool(
        input,
        { name: "tool_search", args: { provider: "native", query: "web search", limit: 5 } },
        {
          summary: "Search the native tool catalog for web search.",
          rationale: "The schema promotion test starts with progressive discovery only.",
          nextStep: "Describe the discovered tool to promote its schema.",
        },
      );
      await input.executeTool({
        name: "tool_search",
        args: { provider: "native", query: "web search", limit: 5 },
        rawArguments: JSON.stringify({ provider: "native", query: "web search", limit: 5 }),
      });
      await authorPublicDecisionForTool(
        input,
        { name: "tool_describe", args: { ids: ["native:web_search"] } },
        {
          summary: "Describe the native web search tool for schema promotion.",
          rationale: "Capable providers should see the promoted dynamic schema after description.",
          nextStep: "Call web_search directly after promotion.",
        },
      );
      await input.executeTool({
        name: "tool_describe",
        args: { ids: ["native:web_search"] },
        rawArguments: JSON.stringify({ ids: ["native:web_search"] }),
      });
      const dynamicAfterDescribe = input.dynamicTools?.() ?? [];
      toolsAfterDescribe = dynamicAfterDescribe.map((tool) => tool.name);
      promotedDynamicToolSchemaJson = JSON.stringify(dynamicAfterDescribe);
      await authorPublicDecisionForTool(
        input,
        { name: "web_search", args: { query: "butler release", max_results: 1 } },
        {
          summary: "Search public web sources for Butler release information.",
          rationale: "A current public answer needs a directly available search source.",
          nextStep: "Use the fixture search result to finish the turn.",
        },
      );
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
  expect(initialDynamicToolSchemaJson).not.toContain("\"web_search\"");
  expect(initialDynamicToolSchemaJson).not.toContain("Fixture source");
  expect(toolsAfterDescribe).toEqual(expect.arrayContaining(["tool_search", "tool_describe", "tool_call", "web_search"]));
  expect(promotedDynamicToolSchemaJson).toContain("\"web_search\"");

  const transcript = readTranscript("butler/main/progressive-promotion");
  expect(transcript.some((event) => event.kind === "tool_call" && event.payload.name === "web_search")).toBe(true);
  expect(transcript.some((event) => event.kind === "tool_call" && event.payload.name === "tool_call")).toBe(false);
});
