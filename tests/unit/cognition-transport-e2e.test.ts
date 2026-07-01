import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { AppGatewayBridge } from "../support/app-gateway-bridge.ts";
import { listFeedbackEntries } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import type {
  AgentRuntimeAdapter,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

test("transport E2E does not regex-capture feedback through app-server gateway turns", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-cognition-transport-"));
  const runtime = new InspectingRuntime();
  const bridge = new AppGatewayBridge({
    butlerHome: process.cwd(),
    butlerData,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(butlerData, "app.sqlite"),
    butlerData,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const first = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "앞으로 말투는 간결하게만 써라.",
      client_message_id: "client-feedback-1",
    });
    expect(first.data.turn.state).toBe("thinking");
    const firstReply = await waitForAssistantMessage(
      server.url,
      "general",
      "feedback-missing",
    );
    expect(firstReply.text).toBe("feedback-missing");

    const feedback = listFeedbackEntries(butlerData);
    expect(feedback).toHaveLength(0);

    const second = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "내 답변 방식 기억하지?",
      client_message_id: "client-feedback-2",
    });
    expect(second.data.turn.state).toBe("thinking");
    const secondReply = await waitForAssistantMessage(
      server.url,
      "general",
      "feedback-missing",
      2,
    );
    expect(secondReply.text).toBe("feedback-missing");

    const messages = await getJson(`${server.url}messages?chat_id=general&cursor=0`);
    expect(messages.data.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    expect(turns.data.turns.map((turn: { state: string }) => turn.state)).toEqual(["delivered", "delivered"]);
    expect(runtime.promptContexts).toHaveLength(2);
    expect(runtime.systemPrompts[0]).not.toContain("## Active Feedback Buffer");
    expect(runtime.promptContexts[0]).not.toContain("## Active Feedback Buffer");
  } finally {
    server.stop();
    bridge.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
}, 10_000);

class InspectingRuntime implements AgentRuntimeAdapter {
  readonly id = "cognition-transport-e2e-runtime";
  readonly systemPrompts: string[] = [];
  readonly promptContexts: string[] = [];
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    this.systemPrompts.push(input.systemPrompt);
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `cognition-e2e:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    const promptContext = typeof input.metadata?.promptContext === "string" ? input.metadata.promptContext : "";
    this.promptContexts.push(promptContext);
    const dynamicTurnContext = promptContext;
    return {
      text: dynamicTurnContext.includes("## Active Feedback Buffer") ? "feedback-visible" : "feedback-missing",
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }
}

const fakeProvider: ModelProviderAdapter = {
  id: "fake-provider",
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

async function getJson(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return await response.json();
}

async function waitForAssistantMessage(
  url: string,
  chatId: string,
  text: string,
  count = 1,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const messages = await getJson(
      `${url}messages?chat_id=${encodeURIComponent(chatId)}&cursor=0`,
    );
    const matches = (
      messages.data.messages as Array<Record<string, unknown>>
    ).filter((message) => message.role === "assistant" && message.text === text);
    if (matches.length >= count) return matches.at(-1)!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Assistant message did not appear: ${text}`);
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  expect(response.ok, JSON.stringify(parsed)).toBe(true);
  return parsed;
}
