import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentRuntimeAdapter,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { runNativeButlerMain } from "../../packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createTelegramLiveGateway } from "../../packages/butler-agent/src/interfaces/transport/telegram/live-gateway.ts";
import { createTelegramTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/telegram/adapter.ts";
import { runTelegramPolling } from "../../packages/butler-agent/src/interfaces/transport/telegram/polling-runner.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import {
  resolveTelegramGatewayRuntimeConfig,
  writeGatewaySettings,
} from "../../packages/butler-agent/src/operations/gateway/registry.ts";

let tempDir = "";
let originalFetch: typeof fetch;
let originalButlerData: string | undefined;
let originalTelegramToken: string | undefined;

class FakeRuntime implements AgentRuntimeAdapter {
  readonly id = "fake-native-runtime";
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  readonly turns: RuntimeTurnInput[] = [];

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `fake:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.turns.push(input);
    const turnText = ("message" in input.input ? input.input.message.text : input.input.text) ?? "";
    return {
      text: turnText.includes("background worker task completed")
        ? "작업 보고입니다. 차트가 준비되었습니다: chart is ready"
        : "runtime reply",
      runtimeSessionRef: input.handle.runtimeSessionRef,
    };
  }

  async closeSession() {}
}

const fakeProvider: ModelProviderAdapter = {
  id: "fake-openai",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: false,
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-native-telegram-"));
  originalFetch = globalThis.fetch;
  originalButlerData = process.env.BUTLER_DATA;
  originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.BUTLER_DATA = tempDir;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (originalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  rmSync(tempDir, { recursive: true, force: true });
});

test("native butler-main polls Telegram from $BUTLER_DATA/.env and delivers runtime replies", async () => {
  const butlerData = tempDir;
  writeFileSync(join(butlerData, ".env"), "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");
  writeGatewaySettings(butlerData, "telegram", {
    enabled: true,
    config: { chatId: "123" },
  });
  writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
    system: {
      runtime: "codex-api",
      defaultModel: "openai/auto:codex-latest",
    },
    telegram: {
      groupId: "123",
    },
  }), "utf8");

  const runtime = new FakeRuntime();
  const deliveries: Array<{ chatId: string; text: string; threadId?: string }> = [];
  const controller = new AbortController();
  let getUpdatesCalls = 0;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    expect(url).toContain("/bottest-token/");
    if (url.endsWith("/deleteWebhook")) {
      return Response.json({ ok: true, result: true });
    }
    if (url.endsWith("/getUpdates")) {
      getUpdatesCalls += 1;
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("allowed_updates")).toContain("message");
      return Response.json({
        ok: true,
        result: getUpdatesCalls === 1
          ? [{
              update_id: 10,
              message: {
                message_id: 20,
                date: 1_700_000_000,
                text: "hello butler",
                chat: { id: 123, type: "private" },
                from: { id: 456, username: "tester" },
              },
            }]
          : [],
      });
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  }) as unknown as typeof fetch;

  const result = await runNativeButlerMain({
    butlerHome: "fixtures/butler-project",
    butlerData,
    runtime,
    provider: fakeProvider,
    shutdownSignal: controller.signal,
    shutdownPollMs: 10,
    workerResultPollMs: 10,
    sendTelegram: async (input) => {
      deliveries.push(input);
      if (input.text === "runtime reply") {
        controller.abort();
      }
      return {
        ok: true,
        transportMessageId: String(deliveries.length),
      };
    },
  });

  expect(result.shutdownReason).toBe("signal");
  expect(getUpdatesCalls).toBeGreaterThanOrEqual(1);
  expect(runtime.turns).toHaveLength(1);
  expect(runtime.turns[0]!.input).toMatchObject({
    transport: "telegram",
    message: {
      text: "hello butler",
    },
  });
  expect(deliveries.map((delivery) => delivery.text)).toContain("runtime reply");
});

test("native butler-main leaves Telegram idle when gateway is not enabled", async () => {
  const butlerData = tempDir;
  writeFileSync(join(butlerData, ".env"), "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");
  writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
    system: {
      runtime: "codex-api",
      defaultModel: "openai/auto:codex-latest",
    },
    telegram: {
      groupId: "123",
    },
  }), "utf8");

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    throw new Error(`unexpected Telegram fetch while disabled: ${String(input)}`);
  }) as unknown as typeof fetch;

  const deliveries: Array<{ chatId: string; text: string; threadId?: string }> = [];
  const result = await runNativeButlerMain({
    butlerHome: "fixtures/butler-project",
    butlerData,
    runtime: new FakeRuntime(),
    provider: fakeProvider,
    waitForShutdown: false,
    sendTelegram: async (input) => {
      deliveries.push(input);
      return {
        ok: true,
        transportMessageId: String(deliveries.length),
      };
    },
  });

  expect(result.shutdownReason).toBe("bootstrap-only");
  expect(deliveries).toEqual([]);
});

test("native Telegram /update command checks service updates without model routing", async () => {
  const deliveries: Array<{ chatId: string; text: string; threadId?: string }> = [];
  const adapter = createTelegramTransportAdapter({
    sendTelegram: async (input) => {
      deliveries.push(input);
      return {
        ok: true,
        transportMessageId: String(deliveries.length),
      };
    },
  });
  const store = new SessionBindingStore(join(tempDir, "telegram-sessions.sqlite"));
  try {
    const gateway = createTelegramLiveGateway({
      adapter,
      router: new GatewayRouter({ store }),
      butlerHome: process.cwd(),
      butlerData: tempDir,
      server: {
        async handleInbound() {
          throw new Error("/update should not route to the model runtime");
        },
      },
    });

    const result = await gateway.handleMessage({
      chatId: "123",
      chatType: "private",
      messageId: "21",
      text: "/update",
      senderId: "456",
      timestamp: new Date(0).toISOString(),
    });

    expect(result).toMatchObject({
      kind: "command",
      command: "update",
      delivered: true,
    });
    expect(deliveries.map((delivery) => delivery.text).join("\n")).toContain(
      "Butler service is up to date",
    );
  } finally {
    store.close();
  }
});

test("native butler-main proactively delivers worker completion through delivery layer", async () => {
  const butlerData = tempDir;
  writeFileSync(join(butlerData, ".env"), "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");
  writeGatewaySettings(butlerData, "telegram", {
    enabled: true,
    config: { chatId: "123" },
  });
  writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
    system: {
      runtime: "codex-api",
      defaultModel: "openai/auto:codex-latest",
    },
    telegram: {
      groupId: "123",
    },
  }), "utf8");
  const taskDir = join(butlerData, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "build chart\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "chart is ready\n", "utf8");

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/deleteWebhook")) {
      return Response.json({ ok: true, result: true });
    }
    if (url.endsWith("/getUpdates")) {
      return Response.json({ ok: true, result: [] });
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  }) as unknown as typeof fetch;

  const controller = new AbortController();
  const deliveries: Array<{ chatId: string; text: string; threadId?: string }> = [];

  const result = await runNativeButlerMain({
    butlerHome: "fixtures/butler-project",
    butlerData,
    runtime: new FakeRuntime(),
    provider: fakeProvider,
    shutdownSignal: controller.signal,
    shutdownPollMs: 10,
    workerResultPollMs: 10,
    sendTelegram: async (input) => {
      deliveries.push(input);
      if (input.text.includes("chart is ready")) {
        controller.abort();
      }
      return {
        ok: true,
        transportMessageId: String(deliveries.length),
      };
    },
  });

  expect(result.shutdownReason).toBe("signal");
  expect(deliveries.some((delivery) => delivery.text.includes("Task ID:"))).toBe(false);
  expect(deliveries.some((delivery) => delivery.text.includes("chart is ready"))).toBe(true);
});

test("Telegram polling exits before handling updates after gateway disable", async () => {
  const butlerData = tempDir;
  writeFileSync(join(butlerData, ".env"), "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");
  writeGatewaySettings(butlerData, "telegram", {
    enabled: true,
    config: { chatId: "123" },
  });
  const logs: string[] = [];
  let getUpdatesCalls = 0;
  let handled = 0;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/deleteWebhook")) {
      return Response.json({ ok: true, result: true });
    }
    if (url.endsWith("/getUpdates")) {
      getUpdatesCalls += 1;
      writeGatewaySettings(butlerData, "telegram", {
        enabled: false,
        config: { chatId: "123" },
      });
      return Response.json({
        ok: true,
        result: [{
          update_id: 42,
          message: {
            message_id: 24,
            date: 1_700_000_000,
            text: "stop before handling",
            chat: { id: 123, type: "private" },
            from: { id: 456, username: "tester" },
          },
        }],
      });
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  }) as unknown as typeof fetch;

  await runTelegramPolling({
    butlerData,
    timeoutSec: 0,
    gateway: {
      async handleMessage() {
        handled += 1;
        return { kind: "routed", dispatchStatus: "handled" };
      },
    },
    shouldStop: () => !resolveTelegramGatewayRuntimeConfig({ butlerData }).enabled,
    log: (line) => logs.push(line),
  });

  expect(getUpdatesCalls).toBe(1);
  expect(handled).toBe(0);
  expect(logs).toContain("Telegram polling stopped");
});
