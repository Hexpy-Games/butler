/// <reference types="bun" />

import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createProductionBtccComposition } from "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { createBtccGatewayHandlers } from "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { BtccInboundDispatcher } from "../../packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import type { ModelRoundPort } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";


test("public Allow survives an interrupted control handoff and App restart on the original Turn", async () => {
  const h = await harness();
  try {
    const source = await h.start();
    const enqueue = spyOn(NativeInboundQueue.prototype, "enqueueIdempotent")
      .mockImplementationOnce(() => { throw new Error("injected_control_handoff_interruption"); });
    try {
      const decision = await h.decide(source.request_ref, "allow");
      expect(decision.status).toBe(500);
    } finally { enqueue.mockRestore(); }
    expect(h.authorityRow(source.request_ref)).toMatchObject({ decision: "allowed" });
    h.restartApp();
    const duplicate = await h.decide(source.request_ref, "allow");
    expect(duplicate.status).toBe(202);
    expect((await h.decide(source.request_ref, "deny")).status).toBe(409);
    expect((await h.decide(source.request_ref, "deny", "other")).status).toBe(404);
    expect((await h.poll()).claimed).toBe(1);
    expect(await Bun.file(join(h.root, "recovery-command.txt")).text()).toBe("recovered");
    const rows = h.queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn_id: source.source_turn_id, state: "dispatched" });
    expect(h.authorityRow(source.request_ref)).toMatchObject({ decision: "allowed", outcome: "applied" });
    expect((await h.poll()).claimed).toBe(0);
  } finally { await h.close(); }
});

test("a normal later message cannot replace a Work while its original call awaits permission", async () => {
  const h = await harness();
  try {
    const source = await h.start();
    const before = h.workRow(source.source_work_id);
    expect((await h.send("Start a different Work instead.", "client-later")).status).toBe(202);
    expect((await h.poll()).claimed).toBe(0);
    expect(h.workRow(source.source_work_id)).toEqual(before);
    expect(h.authorityRow(source.request_ref)).toMatchObject({ decision: "pending", outcome: "pending", close_reason: null });
    expect(h.queueRows().map(row => row.state)).toEqual(["dispatching", "queued"]);
    h.restartApp();
    expect((await h.poll()).claimed).toBe(0);
    expect(h.workRow(source.source_work_id)).toEqual(before);
    expect(await Bun.file(join(h.root, "recovery-command.txt")).exists()).toBe(false);
  } finally { await h.close(); }
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "butler-approval-recovery-"));
  writeFileSync(join(root, "eol.md"), "Follow the requested objective.\n");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "butler-main-native.json"), JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), runtime: "test-native-butler", launcher: "test",
  }));
  const bindings = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"), "ephemeral");
  bindings.upsert({ sessionId: sessionHintForRow("general"), role: "butler", workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime", modelProviderId: "openai", modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }] });
  const composition = createProductionBtccComposition({ butlerHome: root, butlerData: root,
    ownerId: "approval-recovery-test", sessionBindings: bindings, modelRound: reviewedCommandRound() });
  const queue = new NativeInboundQueue(root), inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({ router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }), butlerData: root });
  const deliveryGuard = new DeliveryGuard({ adapters: [createAppTransportAdapter()], butlerData: root });
  const appDbPath = join(root, "app.sqlite");
  const app = () => createAppServer({ dbPath: appDbPath, butlerHome: root, butlerData: root, port: 0 });
  let server = app();
  const db = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
  const appDb = new Database(appDbPath, { readonly: true });
  const send = (text: string, clientMessageId: string) => fetch(`${server.url}messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: "general", text, access_mode: "ask_first",
      model: "openai/gpt-5.5", reasoning_effort: "low", client_message_id: clientMessageId }),
  });
  const poll = async () => {
    const result = inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 4, maxConcurrentSessions: 1 });
    await inbound.waitForIdle();
    await server.store.waitForAppTransportProjection();
    return result;
  };
  return { root, send, poll,
    async start() {
      expect((await send("Run the reviewed command once.", "client-original")).status).toBe(202);
      expect((await poll()).claimed).toBe(1);
      const request = db.query<{ request_ref: string; source_work_id: string; source_turn_id: string }, []>(
        "SELECT request_ref, source_work_id, source_turn_id FROM btcc_authority_requests").get()!;
      expect(request).not.toBeNull();
      return request;
    },
    decide: (ref: string, action: string, session = "general") => fetch(
      `${server.url}authority-requests/${encodeURIComponent(ref)}/${action}?session_id=${session}`, { method: "POST" }),
    authorityRow: (ref: string) => db.query("SELECT decision,outcome,close_reason FROM btcc_authority_requests WHERE request_ref=?").get(ref),
    workRow: (id: string) => db.query("SELECT * FROM btcc_guided_works WHERE work_id=?").get(id),
    queueRows: () => appDb.query<{ turn_id: string; state: string }, []>(
      "SELECT turn_id,state FROM session_queued_messages WHERE chat_id='general' ORDER BY rowid").all(),
    restartApp() { server.stop(); server = app(); },
    async close() {
      server.stop(); await composition.host.close(); bindings.close(); db.close(); appDb.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function reviewedCommandRound(): ModelRoundPort {
  let round = 0;
  return { async runRound(request) {
    round++;
    if (round === 1) return { toolCalls: [
      toolCall("plan", "replace_work_plan", { start_new: true, objective: "Run one reviewed command",
        execution_mode: "direct", actions: [{ action_key: "run-command", description: "Create recovery file",
          dependency_keys: [], effect: { capability: "run_command", target: "workspace-command:." } }],
        checks: ["recovery-command.txt contains recovered"] }),
      toolCall("review", "record_work_review", { subject: "plan", verdict: "accept", summary: "The plan meets this request." }),
      toolCall("command", "run_command", { command: "printf recovered > recovery-command.txt", cwd: ".",
        state_effect: "mutation", summary: "Create recovery file" }),
    ] };
    if (round === 2) {
      expect(request.messages.filter(m => m.role === "tool" && m.name === "run_command")).toHaveLength(1);
      const workId = request.messages.filter(m => m.role === "tool")
        .map(m => JSON.parse(m.content)?.output?.work?.work_id).find(Boolean);
      expect(workId).toBeDefined();
      return { toolCalls: [toolCall("done", "record_work_disposition", { work_id: workId, disposition: "completed",
        summary: "Created the file.", action_updates: [{ action_key: "run-command", status: "done" }] })] };
    }
    return { text: "Created the file.", toolCalls: [] };
  } };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}
