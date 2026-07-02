import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { compactTranscript } from "../../packages/butler-agent/src/agent/context/compaction.ts";
import { MockTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/mock/adapter.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import { appendTranscriptEvent, createTranscriptEvent } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import { runFunctionToolPromptText, type FunctionToolPromptOptions } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const butlerHome = process.env.BUTLER_HOME || process.cwd();
const previousButlerData = process.env.BUTLER_DATA;
const previousRuntime = process.env.BUTLER_RUNTIME;
const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  previousButlerData ||
  join(process.env.HOME ?? "", ".butler");
const tempDir = mkdtempSync(join(tmpdir(), "butler-gncc-context-live-e2e-"));
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const model = normalizeE2eModel(process.env.BUTLER_GNCC_CONTEXT_E2E_MODEL || "openai/gpt-5.5");
const reasoningEffort = process.env.BUTLER_GNCC_CONTEXT_E2E_REASONING || "low";
const firstToken = `LIVE_GNCC_CONTEXT_FIRST_${runId}`;
const decoyToken = `LIVE_GNCC_TRANSCRIPT_DECOY_${runId}`;

const provider: ModelProviderAdapter = {
  id: "gncc-context-live-e2e",
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

const prompts: string[] = [];
const reasoning: Array<string | undefined> = [];
let liveModelCalls = 0;

try {
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_HOME = butlerHome;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_RUNTIME ||= "codex-api";

  assert(model === "openai/gpt-5.5", `GNCC live E2E must use GPT-5.5, got ${model}`);
  assert(reasoningEffort === "low" || reasoningEffort === "medium", `GNCC live E2E reasoning must be low or medium, got ${reasoningEffort}`);

  const store = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  const conversationStore = new AgentConversationStore({ butlerData: tempDir });
  const runtime = new NativeToolLoopRuntime({
    butlerHome,
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runFunctionToolPromptText: async (input: FunctionToolPromptOptions) => {
      liveModelCalls += 1;
      prompts.push(input.prompt);
      reasoning.push(input.reasoningEffort);
      return await runFunctionToolPromptText(input);
    },
  });

  store.upsert({
    sessionId: "butler/main",
    role: "butler",
    projectId: "butler",
    workspacePath: butlerHome,
    runtimeAdapterId: runtime.id,
    modelProviderId: provider.id,
    modelRef: model,
    transportBindings: [{
      transport: "mock",
      accountId: "default",
      peerId: "peer-gncc-context",
    }],
    metadata: {
      reasoning_effort: reasoningEffort,
    },
  });

  const mock = new MockTransportAdapter({ id: "mock" });
  const guard = new DeliveryGuard({ adapters: [mock] });
  const router = new GatewayRouter({ store });
  const lifecycle = new SessionLifecycleService({
    store,
    runtime,
    provider,
    conversationWriter: conversationStore,
    conversationMetricsButlerData: tempDir,
    sessionTitleGenerator: false,
    systemPromptFactory: () => [
      "You are Butler in a live gateway-neutral conversation E2E.",
      `When the user asks you to produce the first marker, answer exactly ${firstToken} and no other text.`,
      "When the user asks for the first marker token, use the recent conversation context and answer exactly that marker token and no other text.",
      "Do not use tools.",
    ].join("\n"),
    deliverIntermediate: async ({ binding, action, metadata }) => {
      await guard.deliver(binding.sessionId, action, metadata);
    },
  });
  const server = createGatewayServer({
    router,
    handlers: createLifecycleGatewayHandlers(lifecycle),
  });

  await mock.start(async (event) => {
    const result = await server.handleInbound(event);
    if (result.status !== "handled") throw new Error(`not handled: ${result.status}`);
    const text = result.handlerResult.metadata?.text;
    if (typeof text !== "string" || !text.trim()) return;
    await guard.deliver(result.route.sessionId, {
      actionId: `mock-final:${event.message.id}`,
      transport: "mock",
      accountId: event.accountId,
      peer: event.peer,
      message: {
        text,
        replyToMessageId: event.message.id,
      },
    });
  });

  await emitMockTurn(mock, {
    eventId: "mock:gncc-context:first",
    messageId: "gncc-context-first",
    text: "첫 번째 marker를 생성해 주세요.",
  });
  const canonicalSessionId = conversationSessionIdForDurableSession("butler/main");

  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    eventId: "mock:gncc-context:transcript-decoy",
    kind: "outbound",
    payload: {
      message: {
        text: decoyToken,
      },
    },
  }));
  seedCanonicalNoise(conversationStore, canonicalSessionId);
  const compaction = await compactTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
    trigger: "manual",
    preserveLastMessages: 2,
  });
  assert(compaction.status === "ok", `canonical compaction failed: ${JSON.stringify(compaction)}`);

  await emitMockTurn(mock, {
    eventId: "mock:gncc-context:second",
    messageId: "gncc-context-second",
    text: "첫 번째 marker token만 그대로 답해 주세요.",
  });

  const sentTexts = mock.sentActions.map((action) => action.message.text || "").filter(Boolean);
  const semanticTexts = conversationStore.readMessages({
    sessionId: canonicalSessionId,
    includeCompacted: true,
    limit: 20,
  }).map((message) => JSON.stringify(message.parts.map((part) => part.content_json)));
  conversationStore.close();

  assert(liveModelCalls >= 2, `expected at least 2 real model calls, observed ${liveModelCalls}`);
  assert(reasoning.every((value) => value === reasoningEffort), `unexpected reasoning efforts: ${reasoning.join(",")}`);
  assert(sentTexts.some((text) => text.trim() === firstToken), `first token was not delivered: ${JSON.stringify(sentTexts)}`);
  assert(sentTexts.at(-1)?.trim() === firstToken, `second turn did not answer prior canonical token: ${JSON.stringify(sentTexts)}`);
  assert(prompts[1]?.includes(firstToken), "second prompt did not include the canonical first assistant token");
  assert(prompts[1]?.includes("summary "), "second prompt did not use canonical compact summary material");
  assert(!prompts[1]?.includes("## Compaction Summary"), "second prompt included legacy compaction snapshot context");
  assert(!prompts[1]?.includes(decoyToken), "second prompt included transcript-only decoy token");
  assert(semanticTexts.some((text) => text.includes(firstToken)), "canonical conversation store did not retain first assistant token");
  assert(transcriptContains(decoyToken), "audit transcript decoy was not written; E2E did not prove transcript exclusion");

  console.log(JSON.stringify({
    ok: true,
    service: "gateway-neutral-conversation-context-live-e2e",
    model,
    reasoningEffort,
    liveModelCalls,
    firstToken,
    transcriptDecoyExcludedFromSecondPrompt: !prompts[1]?.includes(decoyToken),
    secondPromptIncludedCanonicalToken: prompts[1]?.includes(firstToken) === true,
    secondPromptUsedCanonicalSummary: prompts[1]?.includes("summary ") === true,
    finalTexts: sentTexts,
  }, null, 2));
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  if (previousRuntime === undefined) delete process.env.BUTLER_RUNTIME;
  else process.env.BUTLER_RUNTIME = previousRuntime;
  rmSync(tempDir, { recursive: true, force: true });
}

async function emitMockTurn(
  mock: MockTransportAdapter,
  input: { eventId: string; messageId: string; text: string },
): Promise<void> {
  await mock.emit({
    eventId: input.eventId,
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "peer-gncc-context" },
    sender: { id: "user-gncc-context", displayName: "GNCC Live E2E" },
    message: {
      id: input.messageId,
      text: input.text,
      timestamp: new Date().toISOString(),
    },
  });
}

function seedCanonicalNoise(store: AgentConversationStore, sessionId: string): void {
  for (let index = 0; index < 6; index += 1) {
    store.appendUserMessage({
      sessionId,
      text: `canonical noise user ${index}`,
      sourceGateway: "mock",
      sourceRef: `gncc-noise-user-${index}`,
    });
    store.appendAssistantMessage({
      sessionId,
      text: `canonical noise assistant ${index}`,
      sourceGateway: "mock",
      sourceRef: `gncc-noise-assistant-${index}`,
    });
  }
}

function transcriptContains(token: string): boolean {
  const transcriptPath = join(tempDir, "transcripts", "butler_main.jsonl");
  return existsSync(transcriptPath) && readFileSync(transcriptPath, "utf8").includes(token);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeE2eModel(value: string): `${string}/${string}` {
  const trimmed = value.trim();
  if (trimmed === "gpt-5.5") return "openai/gpt-5.5";
  if (trimmed.includes("/")) return trimmed as `${string}/${string}`;
  throw new Error(`GNCC live E2E model must be provider/model, got ${value}`);
}
