/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
import type { GuidedEffectFaultHook } from "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
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
      const rawReceiptJson = finalDb.query<
        { outcome_receipt_json: string | null },
        [string]
      >(
        "SELECT outcome_receipt_json FROM btcc_authority_requests WHERE request_ref = ?",
      ).get(String(requestRef))?.outcome_receipt_json;
      expect(rawReceiptJson != null && rawReceiptJson.length > 0).toBe(true);
      const receiptJsonText = rawReceiptJson as string;
      const parsedReceipt = JSON.parse(receiptJsonText) as Record<string, unknown>;
      expect(Object.keys(parsedReceipt).sort()).toEqual([
        "dispatchAttempt",
        "evidenceRef",
        "journalEffectId",
        "outcome",
        "schema",
      ]);
      expect(parsedReceipt.schema).toBe("butler.authority-outcome-receipt.v1");
      expect(parsedReceipt.outcome).toBe("applied");
      expect(
        typeof parsedReceipt.evidenceRef === "string" &&
          /^authority-evidence-[a-f0-9]{64}$/.test(parsedReceipt.evidenceRef),
      ).toBe(true);
      expect(
        typeof parsedReceipt.journalEffectId === "string" &&
          /^guided-effect-[a-f0-9]{64}$/.test(parsedReceipt.journalEffectId),
      ).toBe(true);
      expect(parsedReceipt.dispatchAttempt).toBe(1);
      expect("errorCode" in parsedReceipt).toBe(false);
      const journalEffectId = parsedReceipt.journalEffectId;
      const dispatchAttempt = parsedReceipt.dispatchAttempt;
      if (typeof journalEffectId !== "string") {
        throw new Error("receipt journalEffectId is not a string");
      }
      if (typeof dispatchAttempt !== "number") {
        throw new Error("receipt dispatchAttempt is not a number");
      }
      const effectRow = finalDb.query<
        { effect_id: string; dispatch_attempts: number },
        []
      >(
        "SELECT effect_id, dispatch_attempts FROM btcc_guided_effects WHERE capability = 'run_command'",
      ).get();
      expect(effectRow?.effect_id).toBe(journalEffectId);
      expect(effectRow?.dispatch_attempts).toBe(dispatchAttempt);
      for (const forbidden of [
        "secret-value",
        "printf",
        "--private-flag",
        "approved-once.txt",
        "Run the reviewed command",
        "mutation",
        "workspace-command",
        "run_command",
        "run-approved-command",
        '"command"',
        '"input"',
        '"result"',
        '"path"',
        '"sanitizedTarget"',
        '"capability"',
        '"workId"',
        '"planRevisionId"',
        '"actionKey"',
        '"receiptId"',
        '"identitySha256"',
        '"errorCode"',
        "work-",
        "plan-",
      ]) {
        expect(receiptJsonText).not.toContain(forbidden);
      }
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

test("real App ask_first known not_applied command records one failed authority outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-known-not-applied-vertical-"));
  roots.push(root);
  publishNativeReadiness(root);
  const approvedWorkspace = join(root, "approved-workspace");
  const replacementWorkspace = join(root, "replacement-workspace");
  const linkedWorkspace = join(root, "linked-workspace");
  mkdirSync(approvedWorkspace, { recursive: true });
  mkdirSync(replacementWorkspace, { recursive: true });
  symlinkSync(approvedWorkspace, linkedWorkspace, "dir");
  const appDbPath = join(root, "app.sqlite");
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  bindings.upsert({
    sessionId: sessionHintForRow("general"),
    role: "butler",
    workspacePath: linkedWorkspace,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  let hookCalls = 0;
  let hookedIdentity: {
    capability: string;
    actionKey: string;
    sanitizedTarget: string;
  } | undefined;
  let hookArmed = false;
  const guidedEffectFaultHook: GuidedEffectFaultHook = (point, identity) => {
    if (point !== "after_dispatch_marker") return;
    if (identity.capability !== "run_command") return;
    if (identity.actionKey !== "accepted-plan") return;
    if (identity.sanitizedTarget !== "workspace-command:.") return;
    hookCalls += 1;
    hookedIdentity = {
      capability: identity.capability,
      actionKey: identity.actionKey,
      sanitizedTarget: identity.sanitizedTarget,
    };
    if (hookArmed) return;
    hookArmed = true;
    unlinkSync(linkedWorkspace);
    symlinkSync(replacementWorkspace, linkedWorkspace, "dir");
  };
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "known-not-applied-vertical-test",
    sessionBindings: bindings,
    modelRound: knownNotAppliedCommandRound(),
    guidedEffectFaultHook,
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
  const clientMessageId = "client-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const outputName = "known-not-applied-output.txt";
  const workspaceHasOutput = async (workspace: string) =>
    await Bun.file(join(workspace, outputName)).exists();
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

    const pendingDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(pendingDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects",
      ).get()?.count ?? 0).toBe(0);
      expect(pendingDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_tool_calls WHERE tool_name = 'run_command'",
      ).get()?.count ?? 0).toBe(1);
    } finally {
      pendingDb.close();
    }
    expect(hookCalls).toBe(0);
    expect(await workspaceHasOutput(approvedWorkspace)).toBe(false);
    expect(await workspaceHasOutput(replacementWorkspace)).toBe(false);

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
    expect(publicProjection).not.toContain(outputName);
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

    expect(hookCalls).toBe(1);
    expect(hookedIdentity).toEqual({
      capability: "run_command",
      actionKey: "accepted-plan",
      sanitizedTarget: "workspace-command:.",
    });
    expect(await workspaceHasOutput(approvedWorkspace)).toBe(false);
    expect(await workspaceHasOutput(replacementWorkspace)).toBe(false);

    const messagesResponse = await fetch(`${server.url}messages?chat_id=general`);
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json() as { data: { messages: Array<{ role: string; turn_id?: string; text: string }> } };
    const finalMessages = messagesBody.data.messages.filter((message) => message.role === "assistant" && message.turn_id === resumedTurnId);
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toBe("Approved command failed to complete.");
    const publicFinalProjection = JSON.stringify(finalMessages);
    for (const forbidden of [
      "secret-value",
      "--private-flag",
      "printf",
      outputName,
      "workspace-command",
      "command_workspace_identity_changed",
      "changed before dispatch",
      "effect_dispatch_failed",
    ]) {
      expect(publicFinalProjection).not.toContain(forbidden);
    }

    const finalDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(finalDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects WHERE capability = 'run_command'",
      ).get()?.count).toBe(1);
      expect(finalDb.query<{ dispatch_attempts: number; status: string }, []>(`
        SELECT dispatch_attempts, status FROM btcc_guided_effects WHERE capability = 'run_command'
      `).get()).toEqual({ dispatch_attempts: 1, status: "failed" });
      const errorJson = finalDb.query<{ error_json: string | null }, []>(
        "SELECT error_json FROM btcc_guided_effects WHERE capability = 'run_command'",
      ).get()?.error_json;
      expect(typeof errorJson).toBe("string");
      expect(String(errorJson)).toContain("effect_dispatch_failed");
      expect(finalDb.query<{ decision: string; outcome: string; outcome_receipt_json: string | null }, [string]>(`
        SELECT decision, outcome, outcome_receipt_json FROM btcc_authority_requests WHERE request_ref = ?
      `).get(String(requestRef))).toEqual({
        decision: "allowed",
        outcome: "failed",
        outcome_receipt_json: null,
      });
      const toolResults = finalDb.query<{ result_json: string | null }, []>(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name = 'run_command'",
      ).all();
      expect(toolResults.filter((row) => (row.result_json ?? "").includes("effect_dispatch_failed"))).toHaveLength(1);
    } finally {
      finalDb.close();
    }

    const duplicateAllow = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/allow?session_id=general`,
      { method: "POST" },
    );
    expect(duplicateAllow.status).toBe(202);
    const replayDb = new Database(appDbPath, { readonly: true });
    try {
      expect(replayDb.query<{ client_message_id: string }, []>(
        "SELECT client_message_id FROM session_queued_messages WHERE chat_id = 'general' ORDER BY rowid ASC",
      ).all()).toHaveLength(2);
    } finally {
      replayDb.close();
    }
    expect(hookCalls).toBe(1);
    expect(await workspaceHasOutput(approvedWorkspace)).toBe(false);
    expect(await workspaceHasOutput(replacementWorkspace)).toBe(false);
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("real App ask_first possible-started uncertain command records one terminal uncertain authority receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-uncertain-vertical-"));
  roots.push(root);
  publishNativeReadiness(root);
  const outputName = "uncertain-once.txt";
  let hookCuts = 0;
  let hookThrew = false;
  const guidedEffectFaultHook: GuidedEffectFaultHook = (point, identity) => {
    if (point !== "after_dispatch") return;
    if (identity.capability !== "run_command") return;
    if (identity.actionKey !== "accepted-plan") return;
    if (identity.sanitizedTarget !== "workspace-command:.") return;
    hookCuts += 1;
    if (hookThrew) return;
    hookThrew = true;
    throw new Error("injected after-dispatch cut");
  };
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
    ownerId: "uncertain-vertical-test",
    sessionBindings: bindings,
    modelRound: uncertainCommandRound(),
    guidedEffectFaultHook,
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
  const clientMessageId = "client-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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

    const pendingDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(pendingDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects",
      ).get()?.count ?? 0).toBe(0);
    } finally {
      pendingDb.close();
    }
    expect(hookCuts).toBe(0);
    expect(await Bun.file(join(root, outputName)).exists()).toBe(false);

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
    expect(publicProjection).not.toContain(outputName);
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

    expect(hookCuts).toBe(1);
    expect(await Bun.file(join(root, outputName)).text()).toBe("secret-value\n");
    expect(await Bun.file(join(root, "wrong-target.txt")).exists()).toBe(false);

    let evidenceRef = "";
    let receiptJsonText = "";
    const finalDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(finalDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects WHERE capability = 'run_command'",
      ).get()?.count).toBe(1);
      expect(finalDb.query<{ dispatch_attempts: number; status: string }, []>(`
        SELECT dispatch_attempts, status FROM btcc_guided_effects WHERE capability = 'run_command'
      `).get()).toEqual({ dispatch_attempts: 1, status: "uncertain" });
      expect(finalDb.query<{ decision: string; outcome: string }, [string]>(`
        SELECT decision, outcome FROM btcc_authority_requests WHERE request_ref = ?
      `).get(String(requestRef))).toEqual({
        decision: "allowed",
        outcome: "uncertain",
      });
      const rawReceiptJson = finalDb.query<
        { outcome_receipt_json: string | null },
        [string]
      >(
        "SELECT outcome_receipt_json FROM btcc_authority_requests WHERE request_ref = ?",
      ).get(String(requestRef))?.outcome_receipt_json;
      expect(rawReceiptJson != null && rawReceiptJson.length > 0).toBe(true);
      receiptJsonText = rawReceiptJson as string;
      const parsedReceipt = JSON.parse(receiptJsonText) as Record<string, unknown>;
      expect(Object.keys(parsedReceipt).sort()).toEqual([
        "dispatchAttempt",
        "errorCode",
        "evidenceRef",
        "journalEffectId",
        "outcome",
        "schema",
      ]);
      expect(parsedReceipt.schema).toBe("butler.authority-outcome-receipt.v1");
      expect(parsedReceipt.outcome).toBe("uncertain");
      expect(parsedReceipt.errorCode).toBe("effect_reconciliation_required");
      expect(
        typeof parsedReceipt.evidenceRef === "string" &&
          /^authority-evidence-[a-f0-9]{64}$/.test(parsedReceipt.evidenceRef),
      ).toBe(true);
      evidenceRef = String(parsedReceipt.evidenceRef);
      const journalEffectId = parsedReceipt.journalEffectId;
      const dispatchAttempt = parsedReceipt.dispatchAttempt;
      if (typeof journalEffectId !== "string") {
        throw new Error("receipt journalEffectId is not a string");
      }
      if (typeof dispatchAttempt !== "number") {
        throw new Error("receipt dispatchAttempt is not a number");
      }
      const effectRow = finalDb.query<
        { effect_id: string; dispatch_attempts: number },
        []
      >(
        "SELECT effect_id, dispatch_attempts FROM btcc_guided_effects WHERE capability = 'run_command'",
      ).get();
      expect(effectRow?.effect_id).toBe(journalEffectId);
      expect(effectRow?.dispatch_attempts).toBe(dispatchAttempt);
    } finally {
      finalDb.close();
    }

    const duplicateAllow = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/allow?session_id=general`,
      { method: "POST" },
    );
    expect(duplicateAllow.status).toBe(202);
    const replayDb = new Database(appDbPath, { readonly: true });
    try {
      expect(replayDb.query<{ client_message_id: string }, []>(
        "SELECT client_message_id FROM session_queued_messages WHERE chat_id = 'general' ORDER BY rowid ASC",
      ).all()).toHaveLength(2);
    } finally {
      replayDb.close();
    }
    expect(hookCuts).toBe(1);
    const replayEffectsDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(replayEffectsDb.query<{ dispatch_attempts: number; status: string }, []>(`
        SELECT dispatch_attempts, status FROM btcc_guided_effects WHERE capability = 'run_command'
      `).get()).toEqual({ dispatch_attempts: 1, status: "uncertain" });
      expect(replayEffectsDb.query<{ outcome_receipt_json: string | null }, [string]>(`
        SELECT outcome_receipt_json FROM btcc_authority_requests WHERE request_ref = ?
      `).get(String(requestRef))?.outcome_receipt_json).toBe(receiptJsonText);
    } finally {
      replayEffectsDb.close();
    }

    const messagesResponse = await fetch(`${server.url}messages?chat_id=general`);
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json() as { data: { messages: Array<{ role: string; turn_id?: string; text: string }> } };
    const finalMessages = messagesBody.data.messages.filter((message) => message.role === "assistant" && message.turn_id === resumedTurnId);
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toBe(`확인 필요 · ${evidenceRef}`);
    const publicFinalProjection = JSON.stringify(finalMessages);
    for (const forbidden of [
      "secret-value",
      "--private-flag",
      "printf",
      outputName,
      "workspace-command",
      "run_command",
      "command_effect_reconciliation_required",
      "effect_reconciliation_required",
      "guided-effect-",
      "journalEffectId",
      "dispatchAttempt",
      "errorCode",
      "injected after-dispatch cut",
    ]) {
      expect(publicFinalProjection).not.toContain(forbidden);
    }
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

function knownNotAppliedCommandRound(): ModelRoundPort {
  let round = 0;
  const command = "printf 'secret-value\\n' --private-flag > known-not-applied-output.txt";
  return {
    async runRound(request) {
      round += 1;
      if (round === 1) {
        const plan = {
          start_new: true,
          objective: "Run one reviewed command",
          actions: [{
            action_key: "run-known-not-applied-command",
            description: "Run the reviewed command once",
            dependency_keys: [],
            effect: { capability: "run_command", target: "workspace-command:." },
          }],
          checks: ["known-not-applied-output.txt contains the command output"],
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
        const run = {
          command,
          cwd: ".",
          state_effect: "mutation",
          summary: "Resume approved command",
        };
        return { toolCalls: [toolCall("run-resume", "run_command", run)] };
      }
      if (round === 3) {
        const workId = request.messages.map((message) => message.content.match(/Explicit relation Work id .*?: ([A-Za-z0-9-]+)/u)?.[1]).find(Boolean);
        if (!workId) throw new Error(JSON.stringify(request.messages.filter((message) => message.role === "tool")));
        return { toolCalls: [toolCall("complete", "record_work_disposition", { work_id: workId, disposition: "blocked", summary: "The approved command failed to complete.", action_updates: [{ action_key: "run-known-not-applied-command", status: "blocked" }] })] };
      }
      if (round === 4) return { text: "Approved command failed to complete.", toolCalls: [] };
      return { text: "Waiting for Allow.", toolCalls: [] };
    },
  };
}

function uncertainCommandRound(): ModelRoundPort {
  let round = 0;
  const command = "printf 'secret-value\\n' --private-flag > uncertain-once.txt";
  return {
    async runRound(request) {
      round += 1;
      if (round === 1) {
        const plan = {
          start_new: true,
          objective: "Run one reviewed command",
          actions: [{
            action_key: "run-uncertain-command",
            description: "Run the reviewed command once",
            dependency_keys: [],
            effect: { capability: "run_command", target: "workspace-command:." },
          }],
          checks: ["uncertain-once.txt contains the command output"],
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
      if (round >= 2 && round <= 4) {
        const callIds = ["run-resume-first", "run-resume-second", "run-resume-third"];
        const run = {
          command,
          cwd: ".",
          state_effect: "mutation",
          summary: "Resume approved command",
        };
        return { toolCalls: [toolCall(callIds[round - 2]!, "run_command", run)] };
      }
      if (round === 5) {
        const workId = request.messages.map((message) => message.content.match(/Explicit relation Work id .*?: ([A-Za-z0-9-]+)/u)?.[1]).find(Boolean);
        if (!workId) throw new Error(JSON.stringify(request.messages.filter((message) => message.role === "tool")));
        return { toolCalls: [toolCall("complete", "record_work_disposition", { work_id: workId, disposition: "blocked", summary: "The approved command may have run.", action_updates: [{ action_key: "run-uncertain-command", status: "blocked" }] })] };
      }
      if (round === 6) return { text: "Approved command needs reconciliation.", toolCalls: [] };
      return { text: "Waiting for Allow.", toolCalls: [] };
    },
  };
}

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
  writeFileSync(
    join(root, "eol.md"),
    "Act only from explicit evidence and preserve the exact reviewed objective.\n",
    "utf8",
  );
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
