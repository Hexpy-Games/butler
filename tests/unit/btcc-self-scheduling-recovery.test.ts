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

test("public Allow survives an interrupted queue handoff and App restart with one canonical row", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-af02d-recovery-"));
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
    ownerId: "af02d-recovery-test",
    sessionBindings: bindings,
    modelRound: reviewedCommandRound(),
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
  let server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  try {
    const initial = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Run the reviewed command once.",
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "ask_first",
        client_message_id: "client-af02d-initial-000000000000000000000000",
      }),
    });
    expect(initial.status).toBe(202);
    const firstSummary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    await server.store.waitForAppTransportProjection();
    expect(firstSummary.claimed).toBe(1);
    expect(firstSummary.failed).toBe(0);
    const authority = await waitForAuthority(root);
    const requestRef = authority.request_ref;
    const clientMessageId = authority.schedule_client_message_id;
    expect(readAuthorityDecision(root, requestRef)).toMatchObject({
      decision: "pending",
      schedule_client_message_id: clientMessageId,
    });
    expect(readQueueSnapshot(appDbPath, clientMessageId)).toEqual([]);

    const _originalSendMessage = server.store.sendMessage;
    server.store.sendMessage = (async () => {
      throw new Error("injected_pre_queue_interruption");
    }) as typeof _originalSendMessage;
    const interrupted = await Promise.all([
      fetch(
        `${server.url}authority-requests/${encodeURIComponent(requestRef)}/allow?session_id=general`,
        { method: "POST" },
      ),
      fetch(
        `${server.url}authority-requests/${encodeURIComponent(requestRef)}/allow?session_id=general`,
        { method: "POST" },
      ),
    ]);
    expect(interrupted.map((response) => response.status)).toEqual([202, 202]);
    expect(await Promise.all(interrupted.map((response) => response.json()))).toEqual([
      expect.objectContaining({ data: { request_ref: requestRef, decision: "allowed", scheduled: false } }),
      expect.objectContaining({ data: { request_ref: requestRef, decision: "allowed", scheduled: false } }),
    ]);
    expect(readQueueCount(appDbPath, clientMessageId)).toBe(0);
    expect(readAuthorityDecision(root, requestRef)).toMatchObject({
      decision: "allowed",
      schedule_client_message_id: clientMessageId,
    });

    server.stop();
    server = createAppServer({
      dbPath: appDbPath,
      butlerHome: root,
      butlerData: root,
      port: 0,
    });
    await waitForQueueRow(appDbPath, clientMessageId);
    await waitForQueueTurn(appDbPath, clientMessageId);
    expect(readQueueCount(appDbPath, clientMessageId)).toBe(1);

    const beforeMismatchAuthority = readAuthorityDecision(root, requestRef);
    const beforeMismatchQueue = readQueueSnapshot(appDbPath, clientMessageId);

    const mismatched = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(requestRef)}/deny?session_id=other`,
      { method: "POST" },
    );
    expect(mismatched.status).toBe(404);
    expect(readAuthorityDecision(root, requestRef)).toEqual(beforeMismatchAuthority);
    expect(readQueueSnapshot(appDbPath, clientMessageId)).toEqual(beforeMismatchQueue);

    const conflicting = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(requestRef)}/deny?session_id=general`,
      { method: "POST" },
    );
    expect(conflicting.status).toBe(409);
    expect(readAuthorityDecision(root, requestRef)).toEqual(beforeMismatchAuthority);
    expect(readQueueSnapshot(appDbPath, clientMessageId)).toEqual(beforeMismatchQueue);

    const resumed = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(resumed.claimed).toBe(1);
    expect(resumed.failed).toBe(0);
    const resumedTurn = readQueueTurn(appDbPath, clientMessageId);
    expect(resumedTurn).toBeTruthy();
    expect(readWorkBinding(root, resumedTurn!)).toBe(authority.source_work_id);
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("startup skips a decided authority input whose source Work was abandoned", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-af02d-stale-"));
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
    ownerId: "af02d-stale-test",
    sessionBindings: bindings,
    modelRound: abandonAfterAuthorityRound(),
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
  let server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  try {
    const initial = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Run the reviewed command once, then abandon it.",
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "ask_first",
        client_message_id: "client-af02d-stale-initial-000000000000000",
      }),
    });
    expect(initial.status).toBe(202);
    const firstSummary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    await server.store.waitForAppTransportProjection();
    expect(firstSummary.claimed).toBe(1);
    expect(firstSummary.failed).toBe(0);
    const authority = await waitForAuthority(root);
    const requestRef = authority.request_ref;
    const clientMessageId = authority.schedule_client_message_id;
    const originalSendMessage = server.store.sendMessage;
    server.store.sendMessage = (async () => {
      throw new Error("injected_pre_queue_interruption");
    }) as typeof originalSendMessage;

    const interrupted = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(requestRef)}/allow?session_id=general`,
      { method: "POST" },
    );
    expect(interrupted.status).toBe(202);
    expect(readQueueCount(appDbPath, clientMessageId)).toBe(0);
    expect(readAuthorityDecision(root, requestRef)).toMatchObject({ decision: "allowed" });

    server.store.sendMessage = originalSendMessage;
    const replacement = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Start a fresh Work and leave the reviewed Work abandoned.",
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "ask_first",
        client_message_id: "client-af02d-stale-replacement-00000000000",
      }),
    });
    expect(replacement.status).toBe(202);
    const replacementSummary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 4,
      maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    expect(replacementSummary.claimed).toBe(1);
    expect(replacementSummary.failed).toBe(0);
    await waitForWorkStatus(root, authority.source_work_id, "abandoned");
    expect(readQueueCount(appDbPath, clientMessageId)).toBe(0);

    server.stop();
    server = createAppServer({
      dbPath: appDbPath,
      butlerHome: root,
      butlerData: root,
      port: 0,
    });
    await Bun.sleep(100);
    expect(readQueueCount(appDbPath, clientMessageId)).toBe(0);
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

function reviewedCommandRound(): ModelRoundPort {
  let round = 0;
  return {
    async runRound(request) {
      round += 1;
      if (round === 1) {
        return {
          toolCalls: [
            toolCall("plan", "replace_work_plan", {
              start_new: true,
              objective: "Run one reviewed command",
              actions: [{
                action_key: "run-reviewed-command",
                description: "Run the reviewed command once",
                dependency_keys: [],
                effect: { capability: "run_command", target: "workspace-command:." },
              }],
              checks: ["recovery-command.txt contains the output"],
            }),
            toolCall("review", "record_work_review", {
              subject: "plan",
              verdict: "accept",
              summary: "The command is reviewed for this task.",
            }),
            toolCall("run", "run_command", {
              command: "printf recovered > recovery-command.txt",
              cwd: ".",
              state_effect: "mutation",
              summary: "Run the reviewed command",
            }),
          ],
        };
      }
      if (round === 2) {
        return { text: "Waiting for Allow.", toolCalls: [] };
      }
      if (round === 3) {
        return {
          toolCalls: [toolCall("run-resumed", "run_command", {
            command: "printf recovered > recovery-command.txt",
            cwd: ".",
            state_effect: "mutation",
            summary: "Resume the reviewed command",
          })],
        };
      }
      if (round === 4) {
        const workId = request.messages
          .map((message) => message.content.match(/Explicit relation Work id .*?: ([A-Za-z0-9-]+)/u)?.[1])
          .find(Boolean);
        if (!workId) throw new Error("recovery Work id missing");
        return {
          toolCalls: [toolCall("complete", "record_work_disposition", {
            work_id: workId,
            disposition: "completed",
            summary: "The approved command completed once.",
            action_updates: [{ action_key: "run-reviewed-command", status: "done" }],
          })],
        };
      }
      return { text: "Approved command completed once.", toolCalls: [] };
    },
  };
}

function abandonAfterAuthorityRound(): ModelRoundPort {
  let round = 0;
  let freshStarted = false;
  return {
    async runRound(request) {
      round += 1;
      if (!freshStarted && request.messages.some((message) => message.content.includes("Start a fresh Work"))) {
        freshStarted = true;
        return {
          toolCalls: [toolCall("abandon-stale", "start_work", {
            objective: "Start a fresh Work after the reviewed Work is abandoned",
          })],
        };
      }
      if (round === 1) {
        return {
          toolCalls: [
            toolCall("plan-stale", "replace_work_plan", {
              start_new: true,
              objective: "Run one reviewed command",
              actions: [{
                action_key: "run-reviewed-command",
                description: "Run the reviewed command once",
                dependency_keys: [],
                effect: { capability: "run_command", target: "workspace-command:." },
              }],
              checks: ["recovery-command.txt contains the output"],
            }),
            toolCall("review-stale", "record_work_review", {
              subject: "plan",
              verdict: "accept",
              summary: "The command is reviewed for this task.",
            }),
            toolCall("run-stale", "run_command", {
              command: "printf recovered > recovery-command.txt",
              cwd: ".",
              state_effect: "mutation",
              summary: "Run the reviewed command",
            }),
          ],
        };
      }
      if (round === 2) return { text: "Waiting for Allow.", toolCalls: [] };
      return { text: "The stale Work was abandoned.", toolCalls: [] };
    },
  };
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>) {
  return { id, name, arguments: argumentsValue, rawArguments: JSON.stringify(argumentsValue) };
}

async function waitForAuthority(root: string): Promise<{
  request_ref: string;
  source_work_id: string;
  schedule_client_message_id: string;
}> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const db = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      const row = db.query<{
        request_ref: string;
        source_work_id: string;
        schedule_client_message_id: string;
      }, []>(`
        SELECT request_ref, source_work_id, schedule_client_message_id
        FROM btcc_authority_requests WHERE decision = 'pending'
        ORDER BY rowid DESC LIMIT 1
      `).get();
      if (row) return row;
    } finally {
      db.close();
    }
    await Bun.sleep(25);
  }
  throw new Error("authority request was not persisted");
}

function readQueueCount(dbPath: string, clientMessageId: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM session_queued_messages WHERE client_message_id = ?",
    ).get(clientMessageId)?.count ?? 0;
  } finally {
    db.close();
  }
}

async function waitForQueueRow(dbPath: string, clientMessageId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (readQueueCount(dbPath, clientMessageId) === 1) return;
    await Bun.sleep(25);
  }
  throw new Error("authority queue row was not admitted after restart");
}

async function waitForQueueTurn(dbPath: string, clientMessageId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (readQueueTurn(dbPath, clientMessageId)) return;
    await Bun.sleep(25);
  }
  throw new Error("authority queue row was not bound to an App Turn after restart");
}

async function waitForWorkStatus(
  root: string,
  workId: string,
  status: "open" | "blocked" | "completed" | "abandoned",
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const db = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      const row = db.query<{ status: string }, [string]>(
        "SELECT status FROM btcc_guided_works WHERE work_id = ?",
      ).get(workId);
      if (row?.status === status) return;
    } finally {
      db.close();
    }
    await Bun.sleep(25);
  }
  throw new Error(`Work did not become ${status}: ${workId}`);
}

function readQueueTurn(dbPath: string, clientMessageId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ turn_id: string | null }, [string]>(
      "SELECT turn_id FROM session_queued_messages WHERE client_message_id = ?",
    ).get(clientMessageId)?.turn_id ?? null;
  } finally {
    db.close();
  }
}

function readAuthorityDecision(root: string, requestRef: string): {
  decision: string;
  schedule_client_message_id: string;
  schedule_input_text: string;
  private_alternative_input: string | null;
  outcome: string;
  updated_at: string;
} | null {
  const db = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
  try {
    return db.query<{
      decision: string;
      schedule_client_message_id: string;
      schedule_input_text: string;
      private_alternative_input: string | null;
      outcome: string;
      updated_at: string;
    }, [string]>(
      "SELECT decision, schedule_client_message_id, schedule_input_text, private_alternative_input, outcome, updated_at FROM btcc_authority_requests WHERE request_ref = ?",
    ).get(requestRef) ?? null;
  } finally {
    db.close();
  }
}

function readQueueSnapshot(dbPath: string, clientMessageId: string): Array<{
  client_message_id: string;
  turn_id: string | null;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{
      client_message_id: string;
      turn_id: string | null;
    }, [string]>(
      "SELECT client_message_id, turn_id FROM session_queued_messages WHERE client_message_id = ? ORDER BY rowid",
    ).all(clientMessageId);
  } finally {
    db.close();
  }
}

function readWorkBinding(root: string, turnId: string): string | null {
  const db = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
  try {
    return db.query<{ work_id: string }, [string]>(`
      SELECT work_id FROM btcc_guided_turn_work_bindings
      WHERE turn_id = ? AND is_current = 1
    `).get(turnId)?.work_id ?? null;
  } finally {
    db.close();
  }
}

function publishNativeReadiness(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "butler-main-native.json"), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runtime: "test-native-butler",
    launcher: "test",
  }), "utf8");
}

function clearNativeReadiness(root: string): void {
  rmSync(join(root, "state", "butler-main-native.json"), { force: true });
}
