import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  ModelProviderAdapter,
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
import { ScriptedBtccGatewayRuntime } from "./support/fake-btcc-gateway-runtime.ts";

let tempDir = "";
let originalFetch: typeof fetch;
let originalButlerData: string | undefined;
let originalTelegramToken: string | undefined;
const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version as string;

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

function writeServiceUpdateManifest(path: string, version: string): void {
  writeFileSync(path, JSON.stringify({
    artifacts: [{
      component: "service",
      version,
      channel: "stable",
      artifact_url: null,
      sha256: null,
      bundled_components: ["service"],
      product: "butler-agent",
      canonical_component: "agent",
      profile: "agent-standalone",
      protocol_compatibility: {
        protocol: "butler.agent.v1",
        minimumAgentProtocol: "butler.agent.v1",
        maximumAgentProtocol: "butler.agent.v1",
      },
      integrity: {
        digestAlgorithm: "sha256",
        digest: null,
        signature: null,
      },
      update_policy: "explicit",
      restart_policy: "restart-service",
      updater_owner: "butler-agent",
      payload_format: "agent-archive",
      staging_policy: "butler-data-updates",
      activation_policy: "versioned-standalone-runtime",
      rollback_policy: "preserve-previous-standalone-runtime",
    }],
  }), "utf8");
}

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

  const btcc = new ScriptedBtccGatewayRuntime("runtime reply");
  const result = await runNativeButlerMain({
    butlerHome: "fixtures/butler-project",
    butlerData,
    btcc,
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
  expect(btcc.commands).toHaveLength(1);
  expect(btcc.commands[0]).toMatchObject({
    kind: "run",
    message: { content: "hello butler" },
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
  const previousUpdateManifest = process.env.BUTLER_UPDATE_MANIFEST;
  const updateManifestPath = join(tempDir, "service-update-manifest.json");
  writeServiceUpdateManifest(updateManifestPath, packageVersion);
  process.env.BUTLER_UPDATE_MANIFEST = updateManifestPath;
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
      "Butler Agent is up to date",
    );
  } finally {
    if (previousUpdateManifest === undefined)
      delete process.env.BUTLER_UPDATE_MANIFEST;
    else process.env.BUTLER_UPDATE_MANIFEST = previousUpdateManifest;
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
  writeFileSync(join(taskDir, "worker_activity_events.jsonl"), [
    JSON.stringify({
      semantic_phase: "executing",
      action_kind: "edit_file",
      status_line: "Created chart output.",
      evidence_refs: ["result.md"],
    }),
    JSON.stringify({
      semantic_phase: "verifying",
      action_kind: "test",
      status_line: "Verified chart output.",
      evidence_refs: ["result.md"],
    }),
  ].join("\n") + "\n", "utf8");

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

  const btcc = new ScriptedBtccGatewayRuntime((command) => {
    const content = command.kind === "run" ? command.message.content : "";
    return content.includes("background worker task completed")
      ? "작업 보고입니다. 차트가 준비되었습니다: chart is ready"
      : "runtime reply";
  });
  const result = await runNativeButlerMain({
    butlerHome: "fixtures/butler-project",
    butlerData,
    btcc,
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
