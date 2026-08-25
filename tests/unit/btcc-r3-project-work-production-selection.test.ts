import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import type {
  ModelRoundPort,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { bindQueuedInboundSession } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/queued-inbound-session-binder.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { GatewayRouter } from
  "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from
  "../../packages/butler-agent/src/gateways/core/server.ts";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { createTurnExecutionControls } from
  "../../packages/butler-agent/src/gateways/core/turn-execution-controls.ts";
import { openProductionBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import {
  createScopeSelectedWorkStore,
} from "../../packages/butler-agent/src/agent/adapters/btcc/scope-selected-work-store.ts";
import type { DurableWorkStore } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";

test("production Work composition rejects missing structural collaborators", () => {
  expect(() => openProductionBtccSqliteStores({
    dbPath: ":memory:",
    ownerId: "missing-selection",
    workSelection: undefined as never,
  })).toThrow("production_work_selection_collaborator_missing");
});

test("unknown turn-only Work lookups fail closed without invoking Session store", () => {
  const calls = { bound: 0, abandoned: 0 };
  const sessionStore = {
    async boundWorkForTurn() {
      calls.bound += 1;
      return null;
    },
    async abandonBoundWorkForTurn() {
      calls.abandoned += 1;
      return null;
    },
  } as unknown as DurableWorkStore;
  const store = createScopeSelectedWorkStore({
    sessionBindings: { getBySessionId: () => null } as never,
    sessionStore,
    resolveProjectScope: () => {
      throw new Error("project_scope_resolution_should_not_run");
    },
    createProjectStore: () => {
      throw new Error("project_store_creation_should_not_run");
    },
    persistedScopeForTurn: () => null,
  });

  for (const lookup of [
    () => store.boundWorkForTurn("unknown-turn"),
    () => store.abandonBoundWorkForTurn("unknown-turn"),
  ]) {
    let error: unknown;
    try {
      lookup();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "work_scope_turn_missing" });
  }
  expect(calls).toEqual({ bound: 0, abandoned: 0 });
});

test("production composition initializes and writes only the exact differing Ledger project", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-project-selection-"));
  const workspace = join(root, "workspace");
  const bindingPath = join(root, "runtime", "session-store.sqlite");
  const sessionId = "butler/app-project-selection";
  const appProjectId = "app-project-selection";
  const ledgerProjectId = "ledger-project-selection";
  let bindings = new SessionBindingStore(bindingPath, "ephemeral");
  const envelope = appEnvelope({
    sessionId,
    appProjectId,
    ledgerProjectId,
    workspacePath: workspace,
  });
  bindQueuedInboundSession(envelope, bindings);
  const composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData: root,
    ownerId: "project-selection-first",
    sessionBindings: bindings,
    modelRound: scriptedModelRound([
      toolResponse("project-plan", "replace_work_plan", {
        objective: "Prove exact Project Work production selection",
        actions: [{
          action_key: "verify_selection",
          description: "Verify the selected Project Work adapter",
          dependency_keys: [],
        }],
        checks: ["Only the explicit Ledger project receives Work records"],
      }),
      toolResponse("project-plan-review", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The plan verifies the exact structural selection.",
        corrections: [],
      }),
      { text: "프로젝트 작업 경로를 확인했습니다.", toolCalls: [] },
    ]),
  });
  try {
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    await composition.ready;
    const result = await gateway.handleInbound(envelope);
    expect(result.status).toBe("handled");

    const ledgerRoot = join(
      root,
      "project-ledger",
      "projects",
      ledgerProjectId,
    );
    expect(existsSync(join(ledgerRoot, "project.json"))).toBe(true);
    expect(existsSync(join(ledgerRoot, "ledger.jsonl"))).toBe(true);
    expect(existsSync(join(root, "project-ledger", "projects", appProjectId)))
      .toBe(false);
    expect(readdirSync(join(ledgerRoot, "work"))).toHaveLength(1);
  } finally {
    await composition.host.close();
    bindings.close();
  }

  bindings = new SessionBindingStore(bindingPath, "ephemeral");
  try {
    expect(bindings.getBySessionId(sessionId)).toMatchObject({
      projectId: appProjectId,
      appProjectId,
      ledgerProjectId,
    });
  } finally {
    bindings.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production-composed non-project turn stays on Session Work without a fake project", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-session-selection-"));
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  const envelope = appEnvelope({ sessionId: "butler/app-chat-selection" });
  bindQueuedInboundSession(envelope, bindings);
  const composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData: root,
    ownerId: "session-selection",
    sessionBindings: bindings,
    modelRound: scriptedModelRound([
      { text: "일반 대화입니다.", toolCalls: [] },
    ]),
  });
  try {
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    await composition.ready;
    expect((await gateway.handleInbound(envelope)).status).toBe("handled");
    expect(existsSync(join(root, "project-ledger"))).toBe(false);
    expect(bindings.getBySessionId(envelope.routingHints!.sessionId!)).toMatchObject({
      projectId: undefined,
      appProjectId: undefined,
      ledgerProjectId: undefined,
    });
  } finally {
    await composition.host.close();
    bindings.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function appEnvelope(input: {
  sessionId: string;
  appProjectId?: string;
  ledgerProjectId?: string;
  workspacePath?: string;
}): InboundEnvelope {
  const chatId = input.sessionId.replace("butler/app-", "");
  const turnId = `${chatId}-turn`;
  const messageId = `${chatId}-message`;
  return {
    eventId: `${chatId}-event`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: chatId },
    sender: { id: "app-user" },
    message: {
      id: messageId,
      text: "구조적 Work 저장소 선택을 확인해 주세요.",
      timestamp: "2026-08-25T13:00:00.000Z",
    },
    routingHints: { sessionId: input.sessionId, turnId },
    executionControls: createTurnExecutionControls({
      turnId,
      sessionId: chatId,
      resolvedAt: "2026-08-25T13:00:00.000Z",
      resolution: {
        controls: {
          model: "openai/gpt-5.6-sol",
          reasoning_effort: "medium",
          access_mode: "full_access",
          plan_mode: false,
        },
        source: "session_override",
        sessionControlRevision: 1,
        catalogGeneration: "project-selection-test",
        model_fallback: { enabled: false, models: [] },
      },
    }),
    appTurnContext: {
      version: 1,
      session: {
        id: chatId,
        kind: input.appProjectId ? "project" : "chat",
      },
      conversation: {
        chatId,
        userMessageId: messageId,
        turnId,
        turnAttempt: 1,
      },
      ...(input.appProjectId && input.workspacePath
        ? {
            project: {
              id: input.appProjectId,
              workspacePath: input.workspacePath,
              ...(input.ledgerProjectId
                ? { ledgerProjectId: input.ledgerProjectId }
                : {}),
            },
          }
        : {}),
      model: {
        requestedModelRef: "openai/gpt-5.6-sol",
        reasoningEffort: "medium",
      },
    },
  };
}

function scriptedModelRound(steps: ModelRoundResult[]): ModelRoundPort {
  let index = 0;
  return {
    async runRound() {
      const step = steps[index++];
      if (!step) throw new Error("scripted_model_round_exhausted");
      return step;
    },
  };
}

function toolResponse(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): ModelRoundResult {
  return {
    toolCalls: [{
      id,
      name,
      arguments: arguments_,
      rawArguments: JSON.stringify(arguments_),
    }],
  };
}
