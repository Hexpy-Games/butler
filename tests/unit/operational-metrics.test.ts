import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  isOperationalMetricsEnabled,
  operationalMetricsPath,
  readOperationalMetricEvents,
  readOperationalMetricSummary,
  recordOperationalMetric,
  setOperationalMetricsEnabled,
  tailOperationalMetricEvents,
} from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-operational-metrics-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

const mockProvider: ModelProviderAdapter = {
  id: "mock-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: false,
    supportsPromptCaching: false,
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("operational metrics records sanitized JSONL events without raw private text", () => {
  const butlerData = tempRoot();

  try {
    recordOperationalMetric({
      category: "runtime",
      name: "turn",
      status: "ok",
      durationMs: 42,
      dimensions: {
        role: "butler",
        model: "openai/auto:codex-latest",
        promptTokens: 123,
        message: "SECRET_MESSAGE_TEXT",
        query: "SECRET_QUERY",
        url: "https://secret.example/path",
        apiKey: "SECRET_KEY",
        nested: { raw: "SECRET_NESTED" },
        "SECRET DIMENSION KEY": "safe-looking-value",
      },
    }, { butlerData });

    const file = readFileSync(operationalMetricsPath(butlerData), "utf8");
    const events = readOperationalMetricEvents({ butlerData });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schema: "butler.operational-metric.v1",
      category: "runtime",
      name: "turn",
      status: "ok",
      rawTextStored: false,
      dimensions: {
        role: "butler",
        model: "openai/auto:codex-latest",
        promptTokens: 123,
      },
    });
    expect(file).not.toContain("SECRET_MESSAGE_TEXT");
    expect(file).not.toContain("SECRET_QUERY");
    expect(file).not.toContain("secret.example");
    expect(file).not.toContain("SECRET_KEY");
    expect(file).not.toContain("SECRET_NESTED");
    expect(file).not.toContain("SECRET DIMENSION KEY");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operational metrics can be disabled by config or env", () => {
  const butlerData = tempRoot();

  try {
    expect(isOperationalMetricsEnabled({ butlerData })).toBe(true);
    setOperationalMetricsEnabled({ butlerData, enabled: false });
    expect(isOperationalMetricsEnabled({ butlerData })).toBe(false);

    recordOperationalMetric({
      category: "runtime",
      name: "disabled_by_config",
      status: "ok",
    }, { butlerData });

    expect(existsSync(operationalMetricsPath(butlerData))).toBe(false);

    setOperationalMetricsEnabled({ butlerData, enabled: true });
    expect(isOperationalMetricsEnabled({
      butlerData,
      env: { BUTLER_METRICS_ENABLED: "off" },
    })).toBe(false);

    recordOperationalMetric({
      category: "runtime",
      name: "disabled_by_env",
      status: "ok",
    }, {
      butlerData,
      env: { BUTLER_METRICS_ENABLED: "false" },
    });

    expect(existsSync(operationalMetricsPath(butlerData))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operational metrics summary and tail aggregate safe event data", () => {
  const butlerData = tempRoot();

  try {
    recordOperationalMetric({
      category: "tool",
      name: "web_search",
      status: "ok",
      durationMs: 10,
    }, { butlerData });
    recordOperationalMetric({
      category: "tool",
      name: "web_search",
      status: "error",
      durationMs: 40,
    }, { butlerData });
    recordOperationalMetric({
      category: "delivery",
      name: "send",
      status: "ok",
      durationMs: 20,
    }, { butlerData });

    const summary = readOperationalMetricSummary({ butlerData });
    const tail = tailOperationalMetricEvents({ butlerData, lines: 2 });

    expect(summary.totalEvents).toBe(3);
    expect(summary.byCategory.tool).toMatchObject({
      events: 2,
      errors: 1,
      durationMs: {
        min: 10,
        max: 40,
      },
    });
    expect(summary.byName["tool:web_search"]).toMatchObject({
      events: 2,
      errors: 1,
    });
    expect(tail).toHaveLength(2);
    expect(tail.map((event) => `${event.category}:${event.name}`)).toEqual([
      "tool:web_search",
      "delivery:send",
    ]);
    expect(summary.privacy.rawTextStored).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("gateway ingress emits operational metrics through the transport layer path", async () => {
  const butlerData = tempRoot();

  try {
    const server = createGatewayServer({
      butlerData,
      router: {
        routeInbound() {
          return {
            status: "routed",
            route: {
              sessionId: "butler/main",
              role: "butler",
              reason: "butler-fallback",
              workspacePath: "/tmp/project",
            },
          };
        },
      },
      handlers: {
        butler: async () => ({ ok: true, handledBy: "mock" }),
      },
    });

    const result = await server.handleInbound({
      eventId: "event-1",
      transport: "mock",
      accountId: "test-account",
      peer: { kind: "dm", id: "peer-1" },
      sender: { id: "user-1" },
      message: {
        id: "msg-1",
        text: "SECRET_USER_TEXT",
        timestamp: new Date(0).toISOString(),
      },
    });

    const metrics = readFileSync(operationalMetricsPath(butlerData), "utf8");
    const events = readOperationalMetricEvents({ butlerData });

    expect(result.status).toBe("handled");
    expect(events.some((event) => event.category === "ingress" && event.name === "handle_inbound")).toBe(true);
    expect(metrics).not.toContain("SECRET_USER_TEXT");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native runtime and tool execution emit operational metrics without tool payloads", async () => {
  const root = tempRoot();
  const butlerData = join(root, "data");
  const originalData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = butlerData;

  try {
    const runtime = new NativeToolLoopRuntime({
      butlerHome: root,
      butlerData,
      runFunctionToolPromptText: async ({ executeTool }) => {
        await executeTool({
          name: "get_usage_monitor",
          args: { message: "SECRET_TOOL_ARGUMENT" },
          rawArguments: "{\"message\":\"SECRET_TOOL_ARGUMENT\"}",
        });
        return "tool done";
      },
      executeButlerTool: async () => ({ ok: true }),
      disableAutomaticRecall: true,
    });
    const handle = await runtime.createSession({
      sessionId: "butler/main",
      role: "butler",
      workspacePath: root,
      systemPrompt: "system",
    });

    const result = await runtime.runTurn({
      handle,
      provider: mockProvider,
      model: "openai/auto:codex-latest",
      input: { text: "run status check" },
    });

    const metrics = readFileSync(operationalMetricsPath(butlerData), "utf8");
    const events = readOperationalMetricEvents({ butlerData });

    expect(result.text).toBe("tool done");
    expect(events.some((event) => event.category === "runtime" && event.name === "turn")).toBe(true);
    expect(events.some((event) => event.category === "tool" && event.name === "get_usage_monitor")).toBe(true);
    expect(metrics).not.toContain("SECRET_TOOL_ARGUMENT");
  } finally {
    if (originalData === undefined) {
      delete process.env.BUTLER_DATA;
    } else {
      process.env.BUTLER_DATA = originalData;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("operational metrics readers tolerate malformed rows", () => {
  const butlerData = tempRoot();

  try {
    mkdirSync(join(butlerData, "metrics"), { recursive: true });
    writeFileSync(
      operationalMetricsPath(butlerData),
      [
        JSON.stringify({
          schema: "butler.operational-metric.v1",
          ts: 1,
          category: "runtime",
          name: "turn",
          status: "ok",
          rawTextStored: false,
        }),
        "{bad json SECRET_TEXT",
      ].join("\n"),
      "utf8",
    );

    const summary = readOperationalMetricSummary({ butlerData });

    expect(summary.totalEvents).toBe(1);
    expect(summary.parseErrors).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("SECRET_TEXT");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
