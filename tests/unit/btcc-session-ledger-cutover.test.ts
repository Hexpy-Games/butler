import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindQueuedInboundSession } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/queued-inbound-session-binder.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { createAppServer } from
  "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { GatewayRouter } from
  "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from
  "../../packages/butler-agent/src/gateways/core/server.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { BtccInboundDispatcher } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { sessionHintForRow } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";

test("queued non-project App ingress converges legacy local metadata to Session Ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-session-ledger-binding-"));
  const store = new SessionBindingStore(join(root, "sessions.sqlite"), "ephemeral");
  const sessionId = "butler/app-session-ledger";
  try {
    store.upsert({
      sessionId,
      role: "butler",
      workspacePath: root,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.6-sol",
      transportBindings: [],
      metadata: {
        runtimePolicy: {
          trackingMode: "local",
          tracking_mode: "local",
          closeoutStrategy: "local_workstream",
          closeout_strategy: "local_workstream",
        },
      },
    });

    const envelope = nonProjectAppEnvelope(sessionId);
    bindQueuedInboundSession(envelope, store);
    const first = store.getBySessionId(sessionId)?.metadata?.runtimePolicy;
    expect(first).toEqual(expect.objectContaining({
      workLedgerScope: "session",
      work_ledger_scope: "session",
      closeoutStrategy: "session_ledger",
      closeout_strategy: "session_ledger",
    }));
    expect(JSON.stringify(first)).not.toContain("local");
    expect(store.getBySessionId(sessionId)?.projectId).toBeUndefined();

    bindQueuedInboundSession(envelope, store);
    expect(store.getBySessionId(sessionId)?.metadata?.runtimePolicy).toEqual(first);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("queued project App ingress preserves the project Ledger runtime policy", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-ledger-binding-"));
  const store = new SessionBindingStore(join(root, "sessions.sqlite"), "ephemeral");
  const sessionId = "butler/app-project-ledger";
  try {
    bindQueuedInboundSession(
      projectAppEnvelope(sessionId, "project-ledger", root),
      store,
    );

    const runtimePolicy = store.getBySessionId(sessionId)?.metadata?.runtimePolicy;
    expect(runtimePolicy).toEqual({
      accessMode: "full_access",
      trackingMode: "ledger",
      tracking_mode: "ledger",
      trackingModeSource: "app_project_default",
      tracking_mode_source: "app_project_default",
      closeoutStrategy: "ledger",
      closeout_strategy: "ledger",
      thinFirstResponse: true,
      thin_first_response: true,
      requiredNativeTools: [],
      required_tools: [],
      requiredNativeToolProfiles: ["workspace", "project", "project-lifecycle"],
    });
    expect(runtimePolicy).not.toHaveProperty("workLedgerScope");
    expect(runtimePolicy).not.toHaveProperty("work_ledger_scope");
    expect(store.getBySessionId(sessionId)?.projectId).toBe("project-ledger");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real non-project App work uses Session Ledger across restart and closeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-session-ledger-app-"));
  const appDbPath = join(root, "app.sqlite");
  const bindingPath = join(root, "runtime", "session-store.sqlite");
  const sessionId = sessionHintForRow("general");
  publishNativeReadiness(root);
  writeFileSync(join(root, "source.txt"), "session ledger fact\n", "utf8");
  const bindings = new SessionBindingStore(bindingPath, "ephemeral");
  bindings.upsert({
    sessionId,
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
    metadata: {
      runtimePolicy: {
        trackingMode: "local",
        tracking_mode: "local",
        closeoutStrategy: "local_workstream",
        closeout_strategy: "local_workstream",
      },
    },
  });
  const app = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  const queue = new NativeInboundQueue(root);
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  let workId = "";
  let composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "session-ledger-first",
    sessionBindings: bindings,
    modelRound: scriptedModelRound([
      () => toolResponse("session-plan", "replace_work_plan", {
        objective: "Read and review source.txt across Turns",
        actions: [{
          action_key: "read_source",
          description: "Read source.txt and verify its fact",
          dependency_keys: [],
        }],
        checks: ["The final answer uses the observed source fact"],
      }),
      (request) => {
        workId = workIdFrom(request, "replace_work_plan");
        return toolResponse("session-plan-review", "record_work_review", {
          subject: "plan",
          verdict: "accept",
          summary: "The plan directly verifies the requested source.",
          corrections: [],
        });
      },
      () => toolResponse("session-read", "read_file", {
        requests: [{ path: "source.txt" }],
      }),
      () => toolResponse("session-checkpoint", "record_work_checkpoint", {
        action_updates: [{ action_key: "read_source", status: "done" }],
        public_summary: "The source fact was read and preserved.",
        next_step: "Continue after restart for final review.",
      }),
      () => toolResponse("session-open", "record_work_disposition", {
        work_id: workId,
        disposition: "open",
        summary: "The observed fact is ready for final review after restart.",
        remaining_actions: ["Complete final review after restart"],
      }),
      { text: "초기 확인을 마쳤고 다음 Turn에서 최종 검토할 수 있습니다.", toolCalls: [] },
    ]),
  });
  try {
    const first = await postAppMessage(app.url, {
      text: "source.txt를 확인하고 다음 Turn에서 최종 검토해 주세요.",
      client_message_id: "client-session-ledger-first-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(first.status).toBe(202);
    await dispatchOne(queue, bindings, deliveryGuard, composition, root);
    const afterFirst = inspectSessionWork(root);
    expect(afterFirst).toMatchObject({
      count: 1,
      scopeKind: "session",
      scopeRef: sessionId,
      status: "open",
      projectBindings: 0,
    });
    expect(workId).not.toBe("");
    const runtimePolicy = bindings.getBySessionId(sessionId)?.metadata?.runtimePolicy;
    expect(runtimePolicy).toEqual(expect.objectContaining({
      workLedgerScope: "session",
      closeout_strategy: "session_ledger",
    }));
    expect(JSON.stringify(runtimePolicy)).not.toContain("local");

    await composition.host.close();
    composition = createProductionBtccComposition({
      butlerHome: root,
      butlerData: root,
      ownerId: "session-ledger-second",
      sessionBindings: bindings,
      modelRound: scriptedModelRound([
        () => toolResponse("session-continue", "continue_work", { work_id: workId }),
        () => toolResponse("session-result-review", "record_work_review", {
          subject: "result",
          verdict: "accept",
          summary: "The persisted source result supports the requested conclusion.",
          corrections: [],
        }),
        () => toolResponse("session-completion-review", "record_work_review", {
          subject: "completion",
          verdict: "accept",
          summary: "The whole Session Work satisfies its objective.",
          corrections: [],
        }),
        () => toolResponse("session-complete", "record_work_disposition", {
          work_id: workId,
          disposition: "completed",
          summary: "The Session Work was reviewed and completed.",
        }),
        { text: "재시작 뒤 이어서 검토하고 세션 작업을 완료했습니다.", toolCalls: [] },
        { text: "간단한 대화에는 새 작업을 만들지 않습니다.", toolCalls: [] },
      ]),
    });
    const second = await postAppMessage(app.url, {
      text: "재시작 전 작업을 이어서 최종 검토해 주세요.",
      client_message_id: "client-session-ledger-second-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(second.status).toBe(202);
    await dispatchOne(queue, bindings, deliveryGuard, composition, root);
    expect(inspectSessionWork(root)).toMatchObject({
      count: 1,
      scopeKind: "session",
      scopeRef: sessionId,
      status: "completed",
      planCount: 1,
      resultCount: 1,
      reviewCount: 3,
      dispositionCount: 2,
      turnBindingCount: 2,
      projectBindings: 0,
    });
    expect(existsSync(join(root, "project-ledger"))).toBe(false);

    const simple = await postAppMessage(app.url, {
      text: "안녕하세요.",
      client_message_id: "client-session-ledger-simple-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(simple.status).toBe(202);
    await dispatchOne(queue, bindings, deliveryGuard, composition, root);
    expect(inspectSessionWork(root).count).toBe(1);
  } finally {
    app.stop();
    await composition.host.close();
    bindings.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function nonProjectAppEnvelope(sessionId: string): InboundEnvelope {
  return {
    eventId: "session-ledger-ingress",
    transport: "app",
    accountId: "local",
    peer: { kind: "dm" as const, id: "session-ledger-chat" },
    sender: { id: "app-user" },
    message: {
      id: "session-ledger-message",
      text: "여러 단계의 보고서를 작성하고 검토해 주세요.",
      timestamp: "2026-08-25T00:00:00.000Z",
    },
    routingHints: { sessionId, turnId: "session-ledger-turn" },
    executionControls: {
      schema_version: "butler.turn-execution-controls.v1" as const,
      turn_id: "session-ledger-turn",
      session_id: "session-ledger-chat",
      model_ref: "openai/gpt-5.6-sol",
      reasoning_effort: "medium" as const,
      access_mode: "full_access" as const,
      plan_mode: false,
      source: "session_override" as const,
      session_control_revision: 1,
      catalog_generation: "session-ledger-test",
      resolved_at: "2026-08-25T00:00:00.000Z",
      model_fallback: { enabled: false, models: [] },
      integrity_hash: "session-ledger-test",
    },
    appTurnContext: {
      version: 1 as const,
      session: { id: "session-ledger-chat", kind: "chat" as const },
      conversation: {
        chatId: "session-ledger-chat",
        userMessageId: "session-ledger-message",
        turnId: "session-ledger-turn",
        turnAttempt: 1,
      },
      model: {
        requestedModelRef: "openai/gpt-5.6-sol",
        reasoningEffort: "medium" as const,
      },
    },
  };
}

function projectAppEnvelope(
  sessionId: string,
  projectId: string,
  workspacePath: string,
): InboundEnvelope {
  const envelope = nonProjectAppEnvelope(sessionId);
  return {
    ...envelope,
    appTurnContext: {
      ...envelope.appTurnContext!,
      session: { ...envelope.appTurnContext!.session, kind: "project" },
      project: { id: projectId, workspacePath },
    },
  };
}

type ScriptStep = ModelRoundResult | ((request: ModelRoundRequest) => ModelRoundResult);

function scriptedModelRound(steps: ScriptStep[]): ModelRoundPort {
  let index = 0;
  return {
    async runRound(request) {
      const step = steps[index++];
      if (!step) throw new Error("scripted_model_round_exhausted");
      return typeof step === "function" ? step(request) : step;
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

function workIdFrom(request: ModelRoundRequest, toolName: string): string {
  const message = request.messages.filter((item) =>
    item.role === "tool" && item.name === toolName).at(-1);
  if (!message) throw new Error(`${toolName}_result_missing`);
  const result = JSON.parse(message.content) as {
    output?: { work?: { work_id?: string } };
  };
  const workId = result.output?.work?.work_id;
  if (!workId) throw new Error(`${toolName}_work_id_missing`);
  return workId;
}

function postAppMessage(appUrl: string, input: {
  text: string;
  client_message_id: string;
}): Promise<Response> {
  return fetch(`${appUrl}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: "general",
      text: input.text,
      model: "openai/gpt-5.6-sol",
      reasoning_effort: "medium",
      access_mode: "full_access",
      client_message_id: input.client_message_id,
    }),
  });
}

async function dispatchOne(
  queue: NativeInboundQueue,
  bindings: SessionBindingStore,
  deliveryGuard: DeliveryGuard,
  composition: ReturnType<typeof createProductionBtccComposition>,
  root: string,
): Promise<void> {
  await composition.ready;
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  let summary = { claimed: 0, handled: 0, delivered: 0, failed: 0, interrupted: 0 };
  for (let attempt = 0; attempt < 20 && summary.claimed === 0; attempt += 1) {
    summary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 1,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    if (summary.claimed === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  expect(summary).toMatchObject({ claimed: 1, failed: 0, interrupted: 0 });
}

function inspectSessionWork(root: string) {
  const db = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
    readonly: true,
  });
  try {
    const work = db.query<{
      count: number;
      scope_kind: string | null;
      scope_ref: string | null;
      status: string | null;
    }, []>(`
      SELECT COUNT(*) AS count, MAX(scope_kind) AS scope_kind,
        MAX(scope_ref) AS scope_ref, MAX(status) AS status
      FROM btcc_guided_works
    `).get()!;
    const count = (table: string) => db.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get()?.count ?? 0;
    return {
      count: work.count,
      scopeKind: work.scope_kind,
      scopeRef: work.scope_ref,
      status: work.status,
      planCount: count("btcc_guided_work_plan_revisions"),
      resultCount: count("btcc_guided_work_results"),
      reviewCount: count("btcc_guided_work_review_revisions"),
      dispositionCount: count("btcc_guided_work_disposition_revisions"),
      turnBindingCount: count("btcc_guided_turn_work_bindings"),
      projectBindings: db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_guided_works
        WHERE scope_kind = 'project'
      `).get()?.count ?? 0,
    };
  } finally {
    db.close();
  }
}

function publishNativeReadiness(root: string): void {
  writeFileSync(
    join(root, "eol.md"),
    "Act only from explicit evidence and preserve the exact reviewed objective.\n",
    "utf8",
  );
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "butler-main-native.json"), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runtime: "session-ledger-test",
    launcher: "test",
  }), "utf8");
}
