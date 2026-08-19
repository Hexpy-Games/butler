/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
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
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("real App ask_first command creates one safe pending authority request without dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-allow-vertical-"));
  roots.push(root);
  publishNativeReadiness(root);
  const appDbPath = join(root, "app.sqlite");
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "self-allow-vertical-test",
    sessionBindings: bindings,
    modelRound: reviewedCommandRound(),
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  const clientMessageId = "client-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Run the approved command once.",
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "ask_first",
        client_message_id: clientMessageId,
      }),
    });
    expect(response.status).toBe(202);
    const summary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(summary.claimed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.interrupted).toBe(0);
    await waitForQueueState(appDbPath, clientMessageId, "dispatched");
    expect(() => Bun.file(join(root, "approved-once.txt"))).not.toThrow();
    expect(await Bun.file(join(root, "approved-once.txt")).exists()).toBe(false);

    const btccDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(btccDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects",
      ).get()?.count ?? 0).toBe(0);
      expect(btccDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_tool_calls WHERE tool_name = 'run_command'",
      ).get()?.count ?? 0).toBe(1);
    } finally {
      btccDb.close();
    }
    const authorityResponse = await fetch(`${server.url}authority-requests?session_id=general`);
    expect(authorityResponse.status).toBe(200);
    const authorityBody = await authorityResponse.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(authorityBody.data.requests).toHaveLength(1);
    expect(authorityBody.data.requests[0]).toMatchObject({
      category: "command",
      executable: "printf",
      command_count: 1,
    });
    const publicProjection = JSON.stringify(authorityBody.data.requests[0]);
    expect(publicProjection).not.toContain("approved-once.txt");
    expect(publicProjection).not.toContain("secret-value");
    expect(publicProjection).not.toContain("--private-flag");

    const requestRef = authorityBody.data.requests[0]?.request_ref;
    expect(typeof requestRef).toBe("string");
    const allow = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/allow?session_id=general`,
      { method: "POST" },
    );
    expect(allow.status).toBe(202);
    const replayAllow = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/allow?session_id=general`,
      { method: "POST" },
    );
    expect(replayAllow.status).toBe(202);

    const scheduled = new Database(appDbPath, { readonly: true });
    let scheduledClientMessageId = "";
    let resumedTurnId = "";
    try {
      const rows = scheduled.query<{ client_message_id: string; turn_id: string }, []>(`
        SELECT client_message_id, turn_id FROM session_queued_messages
        WHERE chat_id = 'general' ORDER BY rowid ASC
      `).all();
      expect(rows).toHaveLength(2);
      scheduledClientMessageId = rows[1]!.client_message_id;
      resumedTurnId = rows[1]!.turn_id;
    } finally {
      scheduled.close();
    }
    const resumedSummary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(resumedSummary.claimed).toBe(1);
    expect(resumedSummary.failed).toBe(0);
    await waitForQueueState(appDbPath, scheduledClientMessageId, "dispatched");
    expect(await Bun.file(join(root, "approved-once.txt")).exists()).toBe(true);
    expect(await Bun.file(join(root, "wrong-target.txt")).exists()).toBe(false);
    expect(await Bun.file(join(root, "approved-once.txt")).text()).toBe("secret-value\n");
    const messagesResponse = await fetch(`${server.url}messages?chat_id=general`);
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json() as { data: { messages: Array<{ role: string; turn_id?: string; text: string }> } };
    const finalMessages = messagesBody.data.messages.filter((message) => message.role === "assistant" && message.turn_id === resumedTurnId);
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toBe("Approved command completed once.");
    expect(JSON.stringify(finalMessages)).not.toContain("secret-value");

    const finalDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(finalDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_authority_requests",
      ).get()?.count).toBe(1);
      expect(finalDb.query<{ decision: string; outcome: string }, [string]>(`
        SELECT decision, outcome FROM btcc_authority_requests WHERE request_ref = ?
      `).get(String(requestRef))).toEqual({
        decision: "allowed",
        outcome: "applied",
      });
      expect(finalDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects WHERE capability = 'run_command'",
      ).get()?.count).toBe(1);
      expect(finalDb.query<{ dispatch_attempts: number; status: string }, []>(`
        SELECT dispatch_attempts, status FROM btcc_guided_effects WHERE capability = 'run_command'
      `).get()).toEqual({ dispatch_attempts: 1, status: "applied" });
      expect(finalDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_turn_work_bindings",
      ).get()?.count).toBe(2);
    } finally {
      finalDb.close();
    }
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

function reviewedCommandRound(): ModelRoundPort {
  let round = 0;
  const command = "printf 'secret-value\\n' --private-flag > approved-once.txt";
  return {
    async runRound(request) {
      round += 1;
      if (round === 1) {
        const plan = {
          start_new: true,
          objective: "Run one reviewed command",
          actions: [{
            action_key: "run-approved-command",
            description: "Run the reviewed command once",
            dependency_keys: [],
            effect: { capability: "run_command", target: "workspace-command:." },
          }],
          checks: ["approved-once.txt contains the command output"],
        };
        const review = {
          subject: "plan",
          verdict: "accept",
          summary: "The command is reviewed for this task.",
        };
        const run = {
          command,
          cwd: ".",
          state_effect: "mutation",
          summary: "Run the reviewed command",
        };
        return {
          toolCalls: [
            toolCall("plan", "replace_work_plan", plan),
            toolCall("review", "record_work_review", review),
            toolCall("run", "run_command", run),
          ],
        };
      }
      if (round === 2) {
        const tampered = {
          command: "printf tampered > wrong-target.txt",
          cwd: ".",
          state_effect: "mutation",
          summary: "Resume approved command",
        };
        return {
          toolCalls: [
            toolCall("run-resume", "run_command", tampered),
          ],
        };
      }
      if (round === 3) {
        const workId = request.messages.map((message) => message.content.match(/Explicit relation Work id .*?: ([A-Za-z0-9-]+)/u)?.[1]).find(Boolean);
        if (!workId) throw new Error(JSON.stringify(request.messages.filter((message) => message.role === "tool")));
        return { toolCalls: [toolCall("complete", "record_work_disposition", { work_id: workId, disposition: "completed", summary: "The approved command completed once.", action_updates: [{ action_key: "run-approved-command", status: "done" }] })] };
      }
      if (round === 4) return { text: "Approved command completed once.", toolCalls: [] };
      return { text: "Waiting for Allow.", toolCalls: [] };
    },
  };
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>) {
  return {
    id,
    name,
    arguments: argumentsValue,
    rawArguments: JSON.stringify(argumentsValue),
  };
}

async function waitForQueueState(
  dbPath: string,
  clientMessageId: string,
  state: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query<{ state: string }, [string]>(
        "SELECT state FROM session_queued_messages WHERE client_message_id = ?",
      ).get(clientMessageId);
      if (row?.state === state) return;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    throw new Error(`Queue state did not become ${state}: ${JSON.stringify({
      queue: db.query("SELECT client_message_id, state, safe_error_code FROM session_queued_messages").all(),
      turns: db.query("SELECT id, state, safe_error_code FROM turns").all(),
    })}`);
  } finally {
    db.close();
  }
}

function publishNativeReadiness(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runtime: "test-native-butler",
      launcher: "test",
    }),
    "utf8",
  );
}

function clearNativeReadiness(root: string): void {
  rmSync(join(root, "state", "butler-main-native.json"), { force: true });
}
