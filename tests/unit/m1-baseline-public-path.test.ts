import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import type { ModelRoundPort } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { AgentConversationStore } from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import { createTurnExecutionControls } from
  "../../packages/butler-agent/src/gateways/core/turn-execution-controls.ts";
import type {
  GatewayRoute,
  InboundEnvelope,
} from "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { readOperationalMetricEvents } from
  "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("M1 telemetry uses production gateway admission, rollback, and fallback boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-m1-public-path-"));
  roots.push(root);
  const sessionId = "butler/m1-public-path";
  const bindings = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"));
  const conversations = new AgentConversationStore({ butlerData: root });
  const envKeys = [
    "BUTLER_METRICS_ENABLED",
    "BUTLER_M1_BASELINE_TELEMETRY",
    "BUTLER_M1_BASELINE_ARM_ID",
    "BUTLER_M1_BASELINE_SCENARIO",
    "BUTLER_M1_BASELINE_CACHE_STATE",
    "BUTLER_M1_BASELINE_SOURCE_REVISION",
    "BUTLER_M1_BASELINE_FLAG_REVISION",
    "BUTLER_M1_BASELINE_ARM_STATE",
    "BUTLER_MODEL_API_RETRY_ATTEMPTS",
    "BUTLER_MODEL_API_RETRY_DELAY_MS",
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let composition: ReturnType<typeof createProductionBtccComposition> | undefined;
  try {
    process.env.BUTLER_METRICS_ENABLED = "true";
    process.env.BUTLER_M1_BASELINE_TELEMETRY = "on";
    process.env.BUTLER_M1_BASELINE_ARM_ID = "direct-cold";
    process.env.BUTLER_M1_BASELINE_SCENARIO = "direct";
    process.env.BUTLER_M1_BASELINE_CACHE_STATE = "cold";
    process.env.BUTLER_M1_BASELINE_SOURCE_REVISION = "65494154f6e9ddbfb20458bc67250c7d15b5d13d";
    process.env.BUTLER_M1_BASELINE_FLAG_REVISION = "m1-t1-v1";
    process.env.BUTLER_M1_BASELINE_ARM_STATE = "accepted";
    process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "1";
    process.env.BUTLER_MODEL_API_RETRY_DELAY_MS = "0";

    bindings.upsert({
      sessionId,
      role: "butler",
      workspacePath: root,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      transportBindings: [],
      metadata: {
        accessMode: "full_access",
        reasoning_effort: "low",
        runtimePolicy: { trackingMode: "local" },
      },
    });

    const modelRound: ModelRoundPort = {
      async runRound(request) {
        if (request.model === "openai/gpt-5.5") {
          throw new ModelProviderRequestError({
            code: "provider_rate_limited",
            message: "safe test fallback",
            provider: "openai",
            retryable: true,
          });
        }
        return { text: "gateway path answer", toolCalls: [] };
      },
    };
    composition = createProductionBtccComposition({
      butlerHome: root,
      butlerData: root,
      appMessageDbPath: join(root, "butler.sqlite"),
      ownerId: "m1-public-path",
      modelRound,
      sessionBindings: bindings,
      conversationStore: conversations,
    });
    await composition.ready;
    const handler = createBtccGatewayHandlers({ btcc: composition.btcc }).butler;
    if (!handler) throw new Error("BTCC Butler gateway handler is unavailable");
    const route: GatewayRoute = {
      sessionId,
      role: "butler",
      reason: "session-hint",
      workspacePath: root,
    };
    const invoke = (turnId: string, executionControls?: InboundEnvelope["executionControls"]) =>
      handler({
        route,
        envelope: productionM1Envelope(turnId, executionControls),
      });

    const enabledResult = await invoke("m1-public-enabled");
    expect(enabledResult).toMatchObject({
      ok: true,
      handledBy: "btcc/turn",
      metadata: { durableFinalRecorded: true, text: "gateway path answer" },
    });
    const enabledDurable = durableFinalSnapshot(
      join(root, "butler.sqlite"),
      conversations,
      "m1-public-enabled",
      sessionId,
    );
    expect(enabledDurable.btcc).toMatchObject({
      semanticState: "delivered",
      finalDisposition: "completed",
    });

    process.env.BUTLER_M1_BASELINE_TELEMETRY = "off";
    const disabledResult = await invoke("m1-public-disabled");
    expect(disabledResult).toMatchObject({
      ok: true,
      handledBy: "btcc/turn",
      metadata: { durableFinalRecorded: true, text: "gateway path answer" },
    });
    const disabledDurable = durableFinalSnapshot(
      join(root, "butler.sqlite"),
      conversations,
      "m1-public-disabled",
      sessionId,
    );
    expect(disabledDurable).toEqual({
      ...enabledDurable,
      turnId: "m1-public-disabled",
    });
    expect(readOperationalMetricEvents({ butlerData: root })
      .filter((event) => event.name === "m1_baseline_arm_observed")).toHaveLength(1);

    process.env.BUTLER_M1_BASELINE_TELEMETRY = "on";
    const fallbackTurnId = "m1-public-fallback";
    const fallbackResult = await invoke(
      fallbackTurnId,
      createFallbackExecutionControls(fallbackTurnId, sessionId),
    );
    expect(fallbackResult).toMatchObject({
      ok: true,
      handledBy: "btcc/turn",
      metadata: { durableFinalRecorded: true, text: "gateway path answer" },
    });
    const fallbackDurable = durableFinalSnapshot(
      join(root, "butler.sqlite"),
      conversations,
      fallbackTurnId,
      sessionId,
    );
    expect(fallbackDurable.btcc).toMatchObject({
      semanticState: "delivered",
      finalDisposition: "completed",
    });
    const events = readOperationalMetricEvents({ butlerData: root })
      .filter((event) => event.name === "m1_baseline_arm_observed");
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      status: "skipped",
      dimensions: { armState: "measurement-ineligible" },
    });
  } finally {
    await composition?.host.close();
    conversations.close();
    bindings.close();
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function productionM1Envelope(
  turnId: string,
  executionControls?: InboundEnvelope["executionControls"],
): InboundEnvelope {
  return {
    eventId: turnId,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: "m1-public-peer" },
    sender: { id: "local-principal" },
    message: {
      id: `message:${turnId}`,
      text: "안전한 public path 회귀 테스트 요청",
      timestamp: "2026-08-10T00:00:00.000Z",
    },
    ...(executionControls ? { executionControls } : {}),
  };
}

function createFallbackExecutionControls(turnId: string, sessionId: string) {
  return createTurnExecutionControls({
    turnId,
    sessionId,
    resolution: {
      controls: {
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "full_access",
        plan_mode: false,
      },
      source: "message_override",
      sessionControlRevision: 1,
      catalogGeneration: "m1-t1-test-catalog",
      model_fallback: {
        enabled: true,
        models: ["zai/glm-5.2"],
      },
    },
    resolvedAt: "2026-08-10T00:00:00.000Z",
  });
}

function durableFinalSnapshot(
  dbPath: string,
  conversations: AgentConversationStore,
  turnId: string,
  sessionId: string,
) {
  const db = new Database(dbPath);
  try {
    const btcc = db.query<{
      semanticState: string;
      finalDisposition: string | null;
    }, [string]>(`
      SELECT semantic_state AS semanticState, final_disposition AS finalDisposition
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    const session = conversations.getSessionByGatewayBinding("app", sessionId);
    return {
      turnId,
      btcc,
      conversationStatus: conversations.readTurn(turnId)?.status ?? null,
      messageCount: session ? conversations.readMessagesForTurn(turnId).length : 0,
    };
  } finally {
    db.close(false);
  }
}
