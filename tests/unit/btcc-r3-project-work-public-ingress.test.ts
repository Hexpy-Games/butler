import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from
  "../../packages/butler-agent/src/test-support/app-server.ts";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import type { ModelRoundPort, ModelRoundResult } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { GatewayRouter } from
  "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from
  "../../packages/butler-agent/src/gateways/core/server.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { BtccInboundDispatcher } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";

test("real App message ingress preserves differing App and Ledger project identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-public-ingress-"));
  const dbPath = join(root, "app.sqlite");
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2026-08-25T13:00:00.000Z",
      runtime: "codex-api",
      launcher: "start-butler.sh",
    }),
  );
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Public ingress selection",
    });
    const appProjectId = project.data.project.id as string;
    const ledgerProjectId = "ledger-public-ingress-selection";
    const db = new Database(dbPath);
    db.query("UPDATE projects SET ledger_project_id = ? WHERE id = ?")
      .run(ledgerProjectId, appProjectId);
    db.close(false);

    const session = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: appProjectId,
      title: "Public ingress selection",
    });
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: session.data.session.id,
        text: "Use the exact Project Ledger scope.",
      }),
    });
    expect(response.status).toBe(202);

    const pendingDir = join(root, "runtime", "inbound-events", "pending");
    const pendingNames = readdirSync(pendingDir);
    expect(pendingNames).toHaveLength(1);
    const queued = JSON.parse(
      readFileSync(join(pendingDir, pendingNames[0]!), "utf8"),
    ) as { envelope: InboundEnvelope };
    expect(queued.envelope.appTurnContext?.project).toMatchObject({
      id: appProjectId,
      ledgerProjectId,
    });
    server.stop();

    const bindingsPath = join(root, "runtime", "session-store.sqlite");
    let bindings = new SessionBindingStore(bindingsPath, "ephemeral");
    const composition = createProductionBtccComposition({
      butlerHome: process.cwd(),
      butlerData: root,
      ownerId: "public-ingress-selection",
      sessionBindings: bindings,
      modelRound: scriptedModelRound([
        toolResponse("public-ingress-plan", "replace_work_plan", {
          objective: "Prove exact public ingress Project Work selection",
          actions: [{
            action_key: "verify_public_ingress",
            description: "Verify the exact Ledger identity from App ingress",
            dependency_keys: [],
          }],
          checks: ["Only the explicit Ledger project receives Work records"],
        }),
        toolResponse("public-ingress-review", "record_work_review", {
          subject: "plan",
          verdict: "accept",
          summary: "The public ingress identity is exact.",
          corrections: [],
        }),
        { text: "공개 진입 경로를 확인했습니다.", toolCalls: [] },
      ]),
    });
    try {
      const gateway = createGatewayServer({
        router: new GatewayRouter({ store: bindings }),
        handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
        butlerData: root,
      });
      await composition.ready;
      expect(existsSync(join(root, "project-ledger"))).toBe(false);
      const dispatcher = new BtccInboundDispatcher();
      const summary = dispatcher.poll({
        queue: new NativeInboundQueue(root),
        server: gateway,
        store: bindings,
        deliveryGuard: new DeliveryGuard({
          adapters: [createAppTransportAdapter()],
          butlerData: root,
        }),
        limit: 1,
      });
      await dispatcher.waitForIdle();
      expect(summary).toMatchObject({
        claimed: 1,
        handled: 1,
        failed: 0,
        interrupted: 0,
      });

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

    bindings = new SessionBindingStore(bindingsPath, "ephemeral");
    try {
      expect(
        bindings.getBySessionId(queued.envelope.routingHints!.sessionId!),
      ).toMatchObject({
        projectId: appProjectId,
        appProjectId,
        ledgerProjectId,
      });
    } finally {
      bindings.close();
    }
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real App project ingress fails closed before queueing a missing or corrupt Ledger identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-project-public-ingress-invalid-"));
  const dbPath = join(root, "app.sqlite");
  writeNativeMainState(root);
  const server = createTestAppServer({
    dbPath,
    butlerData: root,
    projectWorkspaceRoot: join(root, "workspaces"),
    port: 0,
  });
  try {
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Invalid Ledger identity",
    });
    const appProjectId = project.data.project.id as string;
    const session = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: appProjectId,
      title: "Invalid Ledger identity",
    });
    const db = new Database(dbPath);
    try {
      for (const [index, ledgerProjectId] of [null, "../escape"].entries()) {
        db.query("UPDATE projects SET ledger_project_id = ? WHERE id = ?")
          .run(ledgerProjectId, appProjectId);
        const response = await fetch(`${server.url}messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: session.data.session.id,
            client_message_id: `invalid-ledger-${index}`,
            text: "Do not fall back to Session or the App project id.",
          }),
        });
        expect(response.status).toBe(202);
        expect((await response.json()).data.turn).toMatchObject({
          state: "failed",
          safe_error_code: "app_turn_queue_failed",
        });
      }
    } finally {
      db.close(false);
    }
    const pendingDir = join(root, "runtime", "inbound-events", "pending");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir) : []).toEqual([]);
    expect(existsSync(join(root, "project-ledger"))).toBe(false);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real non-project App ingress remains Session Work without a fake project", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-session-public-ingress-"));
  writeNativeMainState(root);
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
  });
  let bindings: SessionBindingStore | undefined;
  let composition: ReturnType<typeof createProductionBtccComposition> | undefined;
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Keep this ordinary conversation in Session Work.",
      }),
    });
    expect(response.status).toBe(202);
    const pendingDir = join(root, "runtime", "inbound-events", "pending");
    const pendingNames = readdirSync(pendingDir);
    expect(pendingNames).toHaveLength(1);
    const queued = JSON.parse(
      readFileSync(join(pendingDir, pendingNames[0]!), "utf8"),
    ) as { envelope: InboundEnvelope };
    expect(queued.envelope.appTurnContext?.project).toBeUndefined();
    server.stop();

    bindings = new SessionBindingStore(
      join(root, "runtime", "session-store.sqlite"),
      "ephemeral",
    );
    composition = createProductionBtccComposition({
      butlerHome: process.cwd(),
      butlerData: root,
      ownerId: "session-public-ingress",
      sessionBindings: bindings,
      modelRound: scriptedModelRound([
        { text: "일반 대화로 처리했습니다.", toolCalls: [] },
      ]),
    });
    const gateway = createGatewayServer({
      router: new GatewayRouter({ store: bindings }),
      handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
      butlerData: root,
    });
    await composition.ready;
    const dispatcher = new BtccInboundDispatcher();
    const summary = dispatcher.poll({
      queue: new NativeInboundQueue(root),
      server: gateway,
      store: bindings,
      deliveryGuard: new DeliveryGuard({
        adapters: [createAppTransportAdapter()],
        butlerData: root,
      }),
      limit: 1,
    });
    await dispatcher.waitForIdle();
    expect(summary).toMatchObject({ handled: 1, interrupted: 0 });
    expect(existsSync(join(root, "project-ledger"))).toBe(false);
    expect(
      bindings.getBySessionId(queued.envelope.routingHints!.sessionId!),
    ).toMatchObject({
      projectId: undefined,
      appProjectId: undefined,
      ledgerProjectId: undefined,
    });
  } finally {
    if (composition) await composition.host.close();
    bindings?.close();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return await response.json();
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

function writeNativeMainState(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2026-08-25T13:00:00.000Z",
      runtime: "codex-api",
      launcher: "start-butler.sh",
    }),
  );
}
