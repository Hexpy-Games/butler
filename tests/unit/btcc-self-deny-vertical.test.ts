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
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { BTCC_AUTHORITY_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/authority-schema.ts";
import { parseAuthorityOutcomeReceipt } from "../../packages/butler-agent/src/agent/btcc/authority/index.ts";

const AUTHORITY_DENIAL_TEXT = "Reviewed command denied. No command was run.";
const PRIVATE_PROVIDER_TEXT = "provider-private-deny-text";
const PRIVATE_CONTINUATION_INPUT = "Report the denied command with its private arguments.";
const PRIVATE_MODIFY_INPUT = "Use the private replacement target and print only the replacement value.";
const PRIVATE_MODIFY_PROVIDER_TEXT = "provider-private-modify-text";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("real App ask_first Deny schedules one same-Work Turn with typed denial and zero effect dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-deny-vertical-"));
  roots.push(root);
  publishNativeReadiness(root);
  const appDbPath = join(root, "app.sqlite");
  const legacyAuthority = seedLegacyAuthorityRequest(root);
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
    ownerId: "self-deny-vertical-test",
    sessionBindings: bindings,
    modelRound: deniedCommandRound(),
  });
  const migratedDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
    readonly: true,
  });
  try {
    const definition = migratedDb.query<{ sql: string }, []>(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'btcc_authority_requests'
    `).get()?.sql ?? "";
    expect(definition).toContain("'denied'");
    const { schedule_state: ignoredScheduleState, ...migratedAuthority } = legacyAuthority;
    void ignoredScheduleState;
    expect(migratedDb.query<Record<string, unknown>, [string]>(`
      SELECT request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision,
        schedule_client_message_id, schedule_input_text, outcome,
        outcome_receipt_json, created_at, updated_at
      FROM btcc_authority_requests WHERE request_ref = ?
    `).get(legacyAuthority.request_ref)).toEqual(migratedAuthority);
  } finally {
    migratedDb.close();
  }
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
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Run the reviewed command only after approval.",
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
    expect(await Bun.file(join(root, "denied-command.txt")).exists()).toBe(false);

    const btccDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(btccDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects",
      ).get()?.count ?? 0).toBe(0);
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
    expect(publicProjection).not.toContain("denied-command.txt");
    expect(publicProjection).not.toContain("private-deny-value");
    expect(publicProjection).not.toContain("--private-deny-flag");

    const requestRef = authorityBody.data.requests[0]?.request_ref;
    expect(typeof requestRef).toBe("string");
    const deny = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/deny?session_id=general`,
      { method: "POST" },
    );
    expect(deny.status).toBe(202);
    const replayDeny = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/deny?session_id=general`,
      { method: "POST" },
    );
    expect(replayDeny.status).toBe(202);

    const scheduled = new Database(appDbPath, { readonly: true });
    let scheduledClientMessageId = "";
    let resumedTurnId = "";
    try {
      const rows = scheduled.query<{
        client_message_id: string;
        turn_id: string;
        control_resolution_json: string;
      }, []>(`
        SELECT client_message_id, turn_id, control_resolution_json
        FROM session_queued_messages WHERE chat_id = 'general' ORDER BY rowid ASC
      `).all();
      expect(rows).toHaveLength(2);
      expect(rows[1]?.control_resolution_json).toContain(String(requestRef));
      scheduledClientMessageId = rows[1]!.client_message_id;
      resumedTurnId = rows[1]!.turn_id;
      expect(resumedTurnId).not.toBe(rows[0]!.turn_id);
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
    expect(await Bun.file(join(root, "denied-command.txt")).exists()).toBe(false);

    const messagesResponse = await fetch(`${server.url}messages?chat_id=general`);
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json() as {
      data: { messages: Array<{ role: string; turn_id?: string; text: string }> };
    };
    const finalMessages = messagesBody.data.messages.filter(
      (message) => message.role === "assistant" && message.turn_id === resumedTurnId,
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toBe(AUTHORITY_DENIAL_TEXT);
    expect(JSON.stringify(finalMessages)).not.toContain("private-deny-value");
    expect(JSON.stringify(finalMessages)).not.toContain("denied-command.txt");

    const eventsResponse = await fetch(`${server.url}events?limit=200`);
    expect(eventsResponse.status).toBe(200);
    const eventsBody = await eventsResponse.json() as {
      data: { events: Array<{ payload: Record<string, unknown> }> };
    };
    const serializedEvents = JSON.stringify(eventsBody.data.events);
    expect(serializedEvents).not.toContain(commandValueForPrivacy());
    expect(serializedEvents).not.toContain("private-deny-value");
    expect(serializedEvents).not.toContain("denied-command.txt");
    expect(serializedEvents).not.toContain("--private-deny-flag");
    expect(serializedEvents).not.toContain(PRIVATE_CONTINUATION_INPUT);
    expect(serializedEvents).not.toContain(PRIVATE_PROVIDER_TEXT);
    const denialEvents = eventsBody.data.events.filter((event) =>
      JSON.stringify(event.payload).includes(AUTHORITY_DENIAL_TEXT),
    );
    expect(denialEvents.length).toBeGreaterThan(0);
    expect(denialEvents.every((event) => {
      const text = JSON.stringify(event.payload);
      return text.includes(AUTHORITY_DENIAL_TEXT) &&
        !text.includes("denied-command.txt") &&
        !text.includes("private-deny-value") &&
        !text.includes("--private-deny-flag");
    })).toBe(true);

    const finalDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(finalDb.query<{ decision: string; outcome: string }, [string]>(`
        SELECT decision, outcome FROM btcc_authority_requests WHERE request_ref = ?
      `).get(String(requestRef))).toEqual({
        decision: "denied",
        outcome: "pending",
      });
      expect(finalDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects",
      ).get()?.count).toBe(0);
      expect(finalDb.query<{ attempts: number | null }, []>(
        "SELECT SUM(dispatch_attempts) AS attempts FROM btcc_guided_effects",
      ).get()?.attempts ?? 0).toBe(0);
      const bindingsForWork = finalDb.query<{ turn_id: string; work_id: string }, []>(`
        SELECT turn_id, work_id FROM btcc_guided_turn_work_bindings
        WHERE is_current = 1 ORDER BY rowid
      `).all();
      expect(bindingsForWork).toHaveLength(2);
      expect(bindingsForWork[1]?.work_id).toBe(bindingsForWork[0]?.work_id);
      expect(bindingsForWork[1]?.turn_id).toBe(resumedTurnId);
      const blockedDisposition = finalDb.query<{
        disposition: string;
        summary: string;
        action_updates_json: string;
        remaining_actions_json: string;
        next_condition: string | null;
        origin_turn_id: string;
      }, [string]>(`
        SELECT disposition, summary, action_updates_json, remaining_actions_json,
          next_condition, origin_turn_id
        FROM btcc_guided_work_disposition_revisions
        WHERE work_id = ? ORDER BY revision DESC LIMIT 1
      `).get(bindingsForWork[1]!.work_id);
      expect(blockedDisposition).toMatchObject({
        disposition: "blocked",
        summary: AUTHORITY_DENIAL_TEXT,
        next_condition: "A later Turn can safely continue without the denied command.",
        origin_turn_id: resumedTurnId,
      });
      expect(blockedDisposition?.action_updates_json).toContain('"status":"blocked"');
      expect(blockedDisposition?.remaining_actions_json).toContain(
        "A later Turn can choose a non-effectful alternative.",
      );
      const deniedToolResult = finalDb.query<{ result_json: string | null; error_code: string | null }, [string]>(`
        SELECT result_json, error_code FROM btcc_guided_tool_calls
        WHERE turn_id = ? AND tool_name = 'run_command'
        ORDER BY rowid DESC LIMIT 1
      `).get(resumedTurnId);
      expect(deniedToolResult?.error_code).toBeNull();
      expect(deniedToolResult?.result_json).toContain("authority_request_denied");
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

test("real App ask_first Modify schedules one same-Work replan Turn before a replacement authority request", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-modify-vertical-"));
  roots.push(root);
  publishNativeReadiness(root);
  mkdirSync(join(root, "replacement-dir"), { recursive: true });
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
    ownerId: "self-modify-vertical-test",
    sessionBindings: bindings,
    modelRound: modifyingCommandRound(),
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
        text: "Run the reviewed command with the requested replacement.",
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
    expect(await Bun.file(join(root, "old-modify-command.txt")).exists()).toBe(false);
    const authorityResponse = await fetch(`${server.url}authority-requests?session_id=general`);
    expect(authorityResponse.status).toBe(200);
    const authorityBody = await authorityResponse.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(authorityBody.data.requests).toHaveLength(1);
    const requestRef = authorityBody.data.requests[0]?.request_ref;
    expect(typeof requestRef).toBe("string");
    const beforeModifyProjection = JSON.stringify(authorityBody.data.requests[0]);
    expect(beforeModifyProjection).not.toContain(PRIVATE_MODIFY_INPUT);
    expect(beforeModifyProjection).not.toContain("old-modify-command.txt");

    const modify = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/modify?session_id=general`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alternative: PRIVATE_MODIFY_INPUT }),
      },
    );
    expect(modify.status).toBe(202);
    const replayModify = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(String(requestRef))}/modify?session_id=general`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alternative: PRIVATE_MODIFY_INPUT }),
      },
    );
    expect(replayModify.status).toBe(202);

    const scheduled = new Database(appDbPath, { readonly: true });
    let scheduledClientMessageId = "";
    let resumedTurnId = "";
    let sourceTurnId = "";
    try {
      const rows = scheduled.query<{
        client_message_id: string;
        turn_id: string;
        text: string;
        control_resolution_json: string;
      }, []>(`
        SELECT client_message_id, turn_id, text, control_resolution_json
        FROM session_queued_messages WHERE chat_id = 'general' ORDER BY rowid ASC
      `).all();
      expect(rows).toHaveLength(2);
      expect(rows[1]?.control_resolution_json).toContain(String(requestRef));
      expect(rows[1]?.text).not.toContain(PRIVATE_MODIFY_INPUT);
      scheduledClientMessageId = rows[1]!.client_message_id;
      resumedTurnId = rows[1]!.turn_id;
      sourceTurnId = rows[0]!.turn_id;
      expect(resumedTurnId).not.toBe(sourceTurnId);
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
    expect(await Bun.file(join(root, "old-modify-command.txt")).exists()).toBe(false);
    expect(await Bun.file(join(root, "replacement-modify-command.txt")).exists()).toBe(false);

    const afterAuthorityResponse = await fetch(`${server.url}authority-requests?session_id=general`);
    expect(afterAuthorityResponse.status).toBe(200);
    const afterAuthorityBody = await afterAuthorityResponse.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(afterAuthorityBody.data.requests).toHaveLength(1);
    const replacementRequest = afterAuthorityBody.data.requests[0]!;
    const replacementRequestRef = String(replacementRequest.request_ref);
    expect(replacementRequestRef).not.toBe(String(requestRef));
    expect(replacementRequest.executable).toBe("printf");
    const publicProjection = JSON.stringify(replacementRequest);
    expect(publicProjection).not.toContain(PRIVATE_MODIFY_INPUT);
    expect(publicProjection).not.toContain(PRIVATE_MODIFY_PROVIDER_TEXT);
    expect(publicProjection).not.toContain("replacement-modify-command.txt");

    const messagesResponse = await fetch(`${server.url}messages?chat_id=general`);
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json() as {
      data: { messages: Array<{ role: string; turn_id?: string; text: string }> };
    };
    const resumedMessages = messagesBody.data.messages.filter(
      (message) => message.role === "assistant" && message.turn_id === resumedTurnId,
    );
    expect(resumedMessages).toHaveLength(1);
    expect(resumedMessages[0]?.text).toBe("Replacement command is waiting for Allow.");
    const serializedMessages = JSON.stringify(messagesBody.data.messages);
    expect(serializedMessages).not.toContain(PRIVATE_MODIFY_INPUT);
    expect(serializedMessages).not.toContain(PRIVATE_MODIFY_PROVIDER_TEXT);

    const eventsResponse = await fetch(`${server.url}events?limit=200`);
    expect(eventsResponse.status).toBe(200);
    const eventsBody = await eventsResponse.json() as {
      data: { events: Array<{ payload: Record<string, unknown> }> };
    };
    const serializedEvents = JSON.stringify(eventsBody.data.events);
    expect(serializedEvents).not.toContain(PRIVATE_MODIFY_INPUT);
    expect(serializedEvents).not.toContain(PRIVATE_MODIFY_PROVIDER_TEXT);
    expect(serializedEvents).not.toContain("old-modify-command.txt");
    expect(serializedEvents).not.toContain("replacement-modify-command.txt");

    const finalDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      const oldAuthority = finalDb.query<{
        decision: string;
        private_alternative_input: string | null;
        source_work_id: string;
        source_turn_id: string;
        plan_revision_id: string;
      }, [string]>(`
        SELECT decision, private_alternative_input,
          source_work_id, source_turn_id
          , plan_revision_id
        FROM btcc_authority_requests WHERE request_ref = ?
      `).get(String(requestRef));
      expect(oldAuthority).toMatchObject({
        decision: "modified",
        private_alternative_input: PRIVATE_MODIFY_INPUT,
        source_turn_id: sourceTurnId,
      });
      const replacementAuthority = finalDb.query<{
        decision: string;
        authority_generation: number;
        source_turn_id: string;
        source_work_id: string;
        plan_revision_id: string;
        action_key: string;
      }, [string]>(`
        SELECT decision, authority_generation, source_turn_id, source_work_id,
          plan_revision_id, action_key
        FROM btcc_authority_requests WHERE request_ref = ?
      `).get(replacementRequestRef);
      expect(replacementAuthority).toMatchObject({
        decision: "pending",
        authority_generation: 2,
        source_turn_id: resumedTurnId,
        source_work_id: oldAuthority?.source_work_id,
        action_key: "run-replacement-modify-command",
      });
      expect(replacementAuthority?.plan_revision_id).not.toBe(oldAuthority?.plan_revision_id);

      const planRows = finalDb.query<{
        plan_revision_id: string;
        revision: number;
        origin_turn_id: string;
        actions_json: string;
      }, [string]>(`
        SELECT plan_revision_id, revision, origin_turn_id, actions_json
        FROM btcc_guided_work_plan_revisions
        WHERE work_id = ? ORDER BY revision ASC
      `).all(oldAuthority!.source_work_id);
      expect(planRows).toHaveLength(2);
      expect(planRows[1]).toMatchObject({
        origin_turn_id: resumedTurnId,
        revision: 2,
      });
      expect(planRows[1]?.actions_json).toContain("replacement-dir");
      const review = finalDb.query<{
        subject: string;
        verdict: string;
        bound_plan_revision_id: string;
        origin_turn_id: string;
      }, [string]>(`
        SELECT subject, verdict, bound_plan_revision_id, origin_turn_id
        FROM btcc_guided_work_review_revisions
        WHERE work_id = ? ORDER BY revision DESC LIMIT 1
      `).get(oldAuthority!.source_work_id);
      expect(review).toMatchObject({
        subject: "plan",
        verdict: "accept",
        bound_plan_revision_id: planRows[1]!.plan_revision_id,
        origin_turn_id: resumedTurnId,
      });
      expect(finalDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects",
      ).get()?.count ?? 0).toBe(0);
      expect(finalDb.query<{ attempts: number | null }, []>(
        "SELECT SUM(dispatch_attempts) AS attempts FROM btcc_guided_effects",
      ).get()?.attempts ?? 0).toBe(0);
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

test("authority schema preserves current and prior accepted outcome rows across reopen", () => {
  const rootCurrent = mkdtempSync(join(tmpdir(), "butler-authority-current-reopen-"));
  roots.push(rootCurrent);
  const currentDbPath = join(rootCurrent, "agent-runtime", "btcc.sqlite");
  const currentRows: AuthorityOutcomeRow[] = [
    authorityOutcomeRow({
      slot: 1,
      identityHexCharacter: "a",
      decision: "pending",
      outcome: "pending",
      privateAlternativeInput: null,
      outcomeReceiptJson: null,
      workspacePath: rootCurrent,
    }),
    authorityOutcomeRow({
      slot: 2,
      identityHexCharacter: "b",
      decision: "allowed",
      outcome: "applied",
      privateAlternativeInput: "synthetic-private-alternative-applied",
      outcomeReceiptJson: appliedAuthorityReceiptJson({
        identitySha256: "b".repeat(64),
        journalEffectIdHexCharacter: "e",
        dispatchAttempt: 3,
      }),
      workspacePath: rootCurrent,
    }),
    authorityOutcomeRow({
      slot: 3,
      identityHexCharacter: "c",
      decision: "denied",
      outcome: "failed",
      privateAlternativeInput: null,
      outcomeReceiptJson: null,
      workspacePath: rootCurrent,
    }),
    authorityOutcomeRow({
      slot: 4,
      identityHexCharacter: "d",
      decision: "modified",
      outcome: "uncertain",
      privateAlternativeInput: "synthetic-private-alternative-uncertain",
      outcomeReceiptJson: uncertainAuthorityReceiptJson({
        identitySha256: "d".repeat(64),
        journalEffectIdHexCharacter: "f",
        dispatchAttempt: 2,
      }),
      workspacePath: rootCurrent,
    }),
  ];

  const created = openBtccSqliteStores({
    dbPath: currentDbPath,
    ownerId: AUTHORITY_REOPEN_OWNER_ID,
  });
  created.close();
  const seeded = new Database(currentDbPath);
  try {
    for (const row of currentRows) insertAuthorityOutcomeRow(seeded, row);
  } finally {
    seeded.close();
  }
  const firstReopen = openBtccSqliteStores({
    dbPath: currentDbPath,
    ownerId: AUTHORITY_REOPEN_OWNER_ID,
  });
  firstReopen.close();
  const secondReopen = openBtccSqliteStores({
    dbPath: currentDbPath,
    ownerId: AUTHORITY_REOPEN_OWNER_ID,
  });
  secondReopen.close();

  const currentSnapshot = readAuthorityTableSnapshot(currentDbPath);
  expect(currentSnapshot.tableDefinition).toContain(
    "outcome IN ('pending', 'applied', 'failed', 'uncertain')",
  );
  expect(currentSnapshot.tableDefinition).not.toContain("schedule_state");
  expect(currentSnapshot.tableDefinition).not.toContain("schedule_turn_id");
  expect(currentSnapshot.legacyTableNamePresent).toBe(false);
  expect(currentSnapshot.rows).toEqual(currentRows);
  const appliedRow = currentSnapshot.rows[1]!;
  expect(appliedRow.outcome).toBe("applied");
  expect(appliedRow.identity_sha256).toBe("b".repeat(64));
  expect(appliedRow.private_alternative_input).toBe("synthetic-private-alternative-applied");
  expect(appliedRow.schedule_client_message_id).toBe("client-synthetic-02");
  expect(appliedRow.schedule_input_text).toBe("Continue synthetic scheduled operation 02.");
  expect(appliedRow.outcome_receipt_json).toBe(currentRows[1]!.outcome_receipt_json);
  const uncertainRow = currentSnapshot.rows[3]!;
  expect(uncertainRow.outcome).toBe("uncertain");
  expect(uncertainRow.private_alternative_input).toBe("synthetic-private-alternative-uncertain");
  expect(uncertainRow.outcome_receipt_json).toBe(currentRows[3]!.outcome_receipt_json);
  expect(parseAuthorityOutcomeReceipt(appliedRow.outcome_receipt_json)).toEqual({
    schema: AUTHORITY_OUTCOME_RECEIPT_SCHEMA,
    outcome: "applied",
    evidenceRef: `authority-evidence-${"b".repeat(64)}`,
    journalEffectId: `guided-effect-${"e".repeat(64)}`,
    dispatchAttempt: 3,
  });
  expect(parseAuthorityOutcomeReceipt(uncertainRow.outcome_receipt_json)).toEqual({
    schema: AUTHORITY_OUTCOME_RECEIPT_SCHEMA,
    outcome: "uncertain",
    evidenceRef: `authority-evidence-${"d".repeat(64)}`,
    journalEffectId: `guided-effect-${"f".repeat(64)}`,
    dispatchAttempt: 2,
    errorCode: "effect_reconciliation_required",
  });

  const rootPrior = mkdtempSync(join(tmpdir(), "butler-authority-af02d-reopen-"));
  roots.push(rootPrior);
  const priorDbPath = join(rootPrior, "agent-runtime", "btcc.sqlite");
  const priorSchema = BTCC_AUTHORITY_SCHEMA.replace(
    "outcome IN ('pending', 'applied', 'failed', 'uncertain')",
    "outcome IN ('pending', 'applied', 'failed')",
  );
  if (
    priorSchema === BTCC_AUTHORITY_SCHEMA ||
    !priorSchema.includes("outcome IN ('pending', 'applied', 'failed')") ||
    priorSchema.includes("'uncertain'") ||
    !priorSchema.includes("decision IN ('pending', 'allowed', 'denied', 'modified')") ||
    !priorSchema.includes("schedule_client_message_id TEXT NOT NULL UNIQUE,") ||
    !priorSchema.includes("schedule_input_text TEXT NOT NULL,") ||
    !priorSchema.includes("private_alternative_input TEXT,") ||
    !priorSchema.includes("idx_btcc_authority_requests_owner_pending") ||
    !priorSchema.includes("idx_btcc_authority_requests_slot_action")
  ) {
    throw new Error("AF-02D prior accepted authority schema was not constructed exactly");
  }
  const priorRows: AuthorityOutcomeRow[] = [
    authorityOutcomeRow({
      slot: 1,
      identityHexCharacter: "a",
      decision: "pending",
      outcome: "pending",
      privateAlternativeInput: null,
      outcomeReceiptJson: null,
      workspacePath: rootPrior,
    }),
    authorityOutcomeRow({
      slot: 2,
      identityHexCharacter: "b",
      decision: "allowed",
      outcome: "applied",
      privateAlternativeInput: "synthetic-private-alternative-legacy-applied",
      outcomeReceiptJson: appliedAuthorityReceiptJson({
        identitySha256: "b".repeat(64),
        journalEffectIdHexCharacter: "9",
        dispatchAttempt: 5,
      }),
      workspacePath: rootPrior,
    }),
    authorityOutcomeRow({
      slot: 3,
      identityHexCharacter: "c",
      decision: "denied",
      outcome: "failed",
      privateAlternativeInput: null,
      outcomeReceiptJson: null,
      workspacePath: rootPrior,
    }),
  ];
  mkdirSync(join(rootPrior, "agent-runtime"), { recursive: true });
  const priorSeeded = new Database(priorDbPath);
  try {
    priorSeeded.exec(priorSchema);
    for (const row of priorRows) insertAuthorityOutcomeRow(priorSeeded, row);
  } finally {
    priorSeeded.close();
  }

  const migrated = openBtccSqliteStores({
    dbPath: priorDbPath,
    ownerId: AUTHORITY_REOPEN_OWNER_ID,
  });
  migrated.close();
  const migratedSnapshot = readAuthorityTableSnapshot(priorDbPath);
  expect(migratedSnapshot.tableDefinition).toContain(
    "outcome IN ('pending', 'applied', 'failed', 'uncertain')",
  );
  expect(migratedSnapshot.tableDefinition).toContain(
    "decision IN ('pending', 'allowed', 'denied', 'modified')",
  );
  expect(migratedSnapshot.tableDefinition).not.toContain("schedule_state");
  expect(migratedSnapshot.tableDefinition).not.toContain("schedule_turn_id");
  expect(migratedSnapshot.indexNames).toContain("idx_btcc_authority_requests_owner_pending");
  expect(migratedSnapshot.indexNames).toContain("idx_btcc_authority_requests_slot_action");
  expect(migratedSnapshot.legacyTableNamePresent).toBe(false);
  expect(migratedSnapshot.rows).toEqual(priorRows);
  const migratedAppliedReceipt = migratedSnapshot.rows[1]!.outcome_receipt_json!;
  expect(migratedAppliedReceipt).toBe(priorRows[1]!.outcome_receipt_json!);
  expect(parseAuthorityOutcomeReceipt(migratedAppliedReceipt)).toEqual({
    schema: AUTHORITY_OUTCOME_RECEIPT_SCHEMA,
    outcome: "applied",
    evidenceRef: `authority-evidence-${"b".repeat(64)}`,
    journalEffectId: `guided-effect-${"9".repeat(64)}`,
    dispatchAttempt: 5,
  });

  const reopenedAfterMigration = openBtccSqliteStores({
    dbPath: priorDbPath,
    ownerId: AUTHORITY_REOPEN_OWNER_ID,
  });
  reopenedAfterMigration.close();
  expect(readAuthorityTableSnapshot(priorDbPath)).toEqual(migratedSnapshot);
});

function deniedCommandRound(): ModelRoundPort {
  let round = 0;
  const command = commandValueForPrivacy();
  return {
    async runRound(request) {
      round += 1;
      if (round === 1) {
        const plan = {
          start_new: true,
          objective: "Run one reviewed command",
          actions: [{
            action_key: "run-denied-command",
            description: "Run the reviewed command only after approval",
            dependency_keys: [],
            effect: { capability: "run_command", target: "workspace-command:." },
          }],
          checks: ["denied-command.txt contains the command output"],
        };
        const review = {
          subject: "plan",
          verdict: "accept",
          summary: "The command is reviewed for this task.",
        };
        return {
          toolCalls: [
            toolCall("plan", "replace_work_plan", plan),
            toolCall("review", "record_work_review", review),
            toolCall("run", "run_command", {
              command,
              cwd: ".",
              state_effect: "mutation",
              summary: "Run the reviewed command",
            }),
          ],
        };
      }
      if (round === 2) {
        return {
          toolCalls: [toolCall("run-resume", "run_command", {
            command: "printf tampered > wrong-deny-target.txt",
            cwd: ".",
            state_effect: "mutation",
            summary: "Resume reviewed command",
          })],
        };
      }
      if (round === 3) {
        assertDenialDeliveredToProvider(request);
        const workId = request.messages
          .map((message) => message.content.match(/Explicit relation Work id .*?: ([A-Za-z0-9-]+)/u)?.[1])
          .find(Boolean);
        if (!workId) throw new Error("same Work identity was not projected to the fresh Turn");
        return {
          text: `${PRIVATE_CONTINUATION_INPUT} ${PRIVATE_PROVIDER_TEXT}`,
          toolCalls: [toolCall("blocked", "record_work_disposition", {
            work_id: workId,
            disposition: "blocked",
            summary: AUTHORITY_DENIAL_TEXT,
            action_updates: [{ action_key: "run-denied-command", status: "blocked" }],
            remaining_actions: ["A later Turn can choose a non-effectful alternative."],
            next_condition: "A later Turn can safely continue without the denied command.",
          })],
        };
      }
      return { text: "No further action is required.", toolCalls: [] };
    },
  };
}

function modifyingCommandRound(): ModelRoundPort {
  let round = 0;
  const oldCommand = "printf 'old-private-value\\n' > old-modify-command.txt";
  return {
    async runRound(request) {
      round += 1;
      if (round === 1) {
        const plan = {
          start_new: true,
          objective: "Run one command with a possible replacement",
          actions: [{
            action_key: "run-old-modify-command",
            description: "Run the original command only after approval",
            dependency_keys: [],
            effect: { capability: "run_command", target: "workspace-command:." },
          }],
          checks: ["old-modify-command.txt contains the original output"],
        };
        const review = {
          subject: "plan",
          verdict: "accept",
          summary: "The original command is reviewed for this task.",
        };
        return {
          toolCalls: [
            toolCall("modify-plan", "replace_work_plan", plan),
            toolCall("modify-review", "record_work_review", review),
            toolCall("modify-run", "run_command", {
              command: oldCommand,
              cwd: ".",
              state_effect: "mutation",
              summary: "Run original reviewed command",
            }),
          ],
        };
      }
      if (round === 2) {
        const serialized = JSON.stringify(request.messages);
        if (!serialized.includes(PRIVATE_MODIFY_INPUT)) {
          throw new Error(`private Modify input missing from exact scheduled Turn: ${serialized}`);
        }
        const workId = request.messages
          .map((message) => message.content.match(/Explicit relation Work id .*?: ([A-Za-z0-9-]+)/u)?.[1])
          .find(Boolean);
        if (!workId) throw new Error("same Work identity was not projected to the Modify Turn");
        const replacementPlan = {
          start_new: false,
          objective: "Run one command with a possible replacement",
          actions: [{
            action_key: "run-replacement-modify-command",
            description: "Run the replacement command only after approval",
            dependency_keys: [],
            effect: {
              capability: "run_command",
              target: "workspace-command:replacement-dir",
            },
          }],
          checks: ["replacement-modify-command.txt contains the replacement output"],
        };
        const review = {
          subject: "plan",
          verdict: "accept",
          summary: "The replacement plan is accepted in the scheduled Modify Turn.",
          action_updates: [{
            action_key: "run-replacement-modify-command",
            status: "active",
          }],
        };
        return {
          text: PRIVATE_MODIFY_PROVIDER_TEXT,
          toolCalls: [
            toolCall("modify-continue", "continue_work", { work_id: workId }),
            toolCall("modify-result-review", "record_work_review", {
              subject: "result",
              verdict: "partial",
              summary: "The original effect was not dispatched; replan the requested target.",
              corrections: ["Replan the requested target before another effect proposal."],
              correction_scope: "planning",
            }),
            toolCall("modify-replan", "replace_work_plan", replacementPlan),
            toolCall("modify-re-review", "record_work_review", review),
            toolCall("modify-replacement-run", "run_command", {
              command: "printf 'replacement-private-value\\n' > replacement-modify-command.txt",
              cwd: "replacement-dir",
              state_effect: "mutation",
              summary: "Run replacement reviewed command",
            }),
          ],
        };
      }
      throw new Error(`unexpected Modify model round ${round}`);
    },
  };
}

function commandValueForPrivacy(): string {
  return "printf 'private-deny-value\\n' --private-deny-flag > denied-command.txt";
}

function assertDenialDeliveredToProvider(request: {
  messages: ReadonlyArray<{ role: string; content: string }>;
}): void {
  const toolMessages = request.messages.filter((message) => message.role === "tool");
  const serialized = JSON.stringify(toolMessages);
  if (!serialized.includes("authority_request_denied") ||
      !serialized.includes(AUTHORITY_DENIAL_TEXT)) {
    throw new Error(`provider denial delivery missing: ${serialized}`);
  }
}

type LegacyAuthorityRow = {
  request_id: string;
  request_ref: string;
  identity_sha256: string;
  owner_session_id: string;
  source_session_id: string;
  source_turn_id: string;
  source_work_id: string;
  workspace_path: string;
  plan_revision_id: string;
  action_key: string;
  authority_generation: number;
  capability: string;
  normalized_target: string;
  normalized_input_json: string;
  model_ref: string;
  reasoning_effort: string;
  category: string;
  reason: string;
  executable: string;
  command_count: number;
  decision: string;
  schedule_state: string;
  schedule_client_message_id: string;
  schedule_input_text: string;
  outcome: string;
  outcome_receipt_json: string | null;
  created_at: string;
  updated_at: string;
};

function seedLegacyAuthorityRequest(root: string): LegacyAuthorityRow {
  const dbPath = join(root, "agent-runtime", "btcc.sqlite");
  mkdirSync(join(root, "agent-runtime"), { recursive: true });
  const legacySchema = BTCC_AUTHORITY_SCHEMA
    .replace(
      "decision IN ('pending', 'allowed', 'denied', 'modified')",
      "decision IN ('pending', 'allowed')",
    )
    .replace(
      "schedule_client_message_id TEXT NOT NULL UNIQUE,",
      "schedule_state TEXT NOT NULL CHECK (schedule_state IN ('pending', 'scheduled')),\n  schedule_client_message_id TEXT NOT NULL UNIQUE,\n  schedule_turn_id TEXT,",
    );
  if (!legacySchema.includes("decision IN ('pending', 'allowed')") ||
      legacySchema.includes("decision IN ('pending', 'allowed', 'denied', 'modified')")) {
    throw new Error("AF-02A legacy authority schema was not constructed exactly");
  }
  const row: LegacyAuthorityRow = {
    request_id: "authority-legacy-sentinel",
    request_ref: "authority-ref-legacy-sentinel",
    identity_sha256: "legacy-sentinel-identity",
    owner_session_id: "legacy-sentinel-owner",
    source_session_id: "legacy-sentinel-owner",
    source_turn_id: "legacy-sentinel-turn",
    source_work_id: "legacy-sentinel-work",
    workspace_path: root,
    plan_revision_id: "legacy-sentinel-plan",
    action_key: "legacy-sentinel-action",
    authority_generation: 1,
    capability: "run_command",
    normalized_target: "workspace-command:.",
    normalized_input_json: JSON.stringify({
      command: "printf sentinel",
      cwd: ".",
      state_effect: "mutation",
    }),
    model_ref: "openai/gpt-5.5",
    reasoning_effort: "low",
    category: "command",
    reason: "Legacy pending sentinel",
    executable: "printf",
    command_count: 1,
    decision: "pending",
    schedule_state: "pending",
    schedule_client_message_id: "client-legacy-sentinel",
    schedule_input_text: "Continue the legacy sentinel operation.",
    outcome: "pending",
    outcome_receipt_json: null,
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
  };
  const db = new Database(dbPath);
  try {
    db.exec(legacySchema);
    db.query(`
      INSERT INTO btcc_authority_requests (
        request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision, schedule_state,
        schedule_client_message_id, schedule_input_text, outcome,
        outcome_receipt_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      row.request_id,
      row.request_ref,
      row.identity_sha256,
      row.owner_session_id,
      row.source_session_id,
      row.source_turn_id,
      row.source_work_id,
      row.workspace_path,
      row.plan_revision_id,
      row.action_key,
      row.authority_generation,
      row.capability,
      row.normalized_target,
      row.normalized_input_json,
      row.model_ref,
      row.reasoning_effort,
      row.category,
      row.reason,
      row.executable,
      row.command_count,
      row.decision,
      row.schedule_state,
      row.schedule_client_message_id,
      row.schedule_input_text,
      row.outcome,
      row.outcome_receipt_json,
      row.created_at,
      row.updated_at,
    );
  } finally {
    db.close();
  }
  return row;
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
  throw new Error(`Queue state did not become ${state}`);
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

const AUTHORITY_REOPEN_OWNER_ID = "af02e-criterion-6-authority-reopen";
const AUTHORITY_OUTCOME_RECEIPT_SCHEMA = "butler.authority-outcome-receipt.v1";

type AuthorityDecisionValue = "pending" | "allowed" | "denied" | "modified";
type AuthorityOutcomeValue = "pending" | "applied" | "failed" | "uncertain";

type AuthorityOutcomeRow = {
  request_id: string;
  request_ref: string;
  identity_sha256: string;
  owner_session_id: string;
  source_session_id: string;
  source_turn_id: string;
  source_work_id: string;
  workspace_path: string;
  plan_revision_id: string;
  action_key: string;
  authority_generation: number;
  capability: string;
  normalized_target: string;
  normalized_input_json: string;
  model_ref: string;
  reasoning_effort: string;
  category: string;
  reason: string;
  executable: string;
  command_count: number;
  decision: string;
  schedule_client_message_id: string;
  schedule_input_text: string;
  private_alternative_input: string | null;
  outcome: string;
  outcome_receipt_json: string | null;
  created_at: string;
  updated_at: string;
};

const AUTHORITY_ROW_COLUMNS = [
  "request_id",
  "request_ref",
  "identity_sha256",
  "owner_session_id",
  "source_session_id",
  "source_turn_id",
  "source_work_id",
  "workspace_path",
  "plan_revision_id",
  "action_key",
  "authority_generation",
  "capability",
  "normalized_target",
  "normalized_input_json",
  "model_ref",
  "reasoning_effort",
  "category",
  "reason",
  "executable",
  "command_count",
  "decision",
  "schedule_client_message_id",
  "schedule_input_text",
  "private_alternative_input",
  "outcome",
  "outcome_receipt_json",
  "created_at",
  "updated_at",
] as const;

function authorityOutcomeRow(config: {
  slot: number;
  identityHexCharacter: string;
  decision: AuthorityDecisionValue;
  outcome: AuthorityOutcomeValue;
  privateAlternativeInput: string | null;
  outcomeReceiptJson: string | null;
  workspacePath: string;
}): AuthorityOutcomeRow {
  const slotLabel = String(config.slot).padStart(2, "0");
  return {
    request_id: `authority-request-id-${slotLabel}`,
    request_ref: `authority-request-ref-${slotLabel}`,
    identity_sha256: config.identityHexCharacter.repeat(64),
    owner_session_id: "synthetic-owner-session",
    source_session_id: "synthetic-source-session",
    source_turn_id: `synthetic-source-turn-${slotLabel}`,
    source_work_id: `synthetic-work-${slotLabel}`,
    workspace_path: config.workspacePath,
    plan_revision_id: `synthetic-plan-${slotLabel}`,
    action_key: `run-synthetic-action-${slotLabel}`,
    authority_generation: 1,
    capability: "run_command",
    normalized_target: "workspace-command:synthetic",
    normalized_input_json: JSON.stringify({
      command: `printf synthetic-${slotLabel}`,
      cwd: ".",
      state_effect: "mutation",
    }),
    model_ref: "openai/gpt-5.5",
    reasoning_effort: "low",
    category: "command",
    reason: `Synthetic authority row ${slotLabel}`,
    executable: "printf",
    command_count: 1,
    decision: config.decision,
    schedule_client_message_id: `client-synthetic-${slotLabel}`,
    schedule_input_text: `Continue synthetic scheduled operation ${slotLabel}.`,
    private_alternative_input: config.privateAlternativeInput,
    outcome: config.outcome,
    outcome_receipt_json: config.outcomeReceiptJson,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
  };
}

function appliedAuthorityReceiptJson(config: {
  identitySha256: string;
  journalEffectIdHexCharacter: string;
  dispatchAttempt: number;
}): string {
  return JSON.stringify({
    schema: AUTHORITY_OUTCOME_RECEIPT_SCHEMA,
    outcome: "applied" as const,
    evidenceRef: `authority-evidence-${config.identitySha256}`,
    journalEffectId: `guided-effect-${config.journalEffectIdHexCharacter.repeat(64)}`,
    dispatchAttempt: config.dispatchAttempt,
  });
}

function uncertainAuthorityReceiptJson(config: {
  identitySha256: string;
  journalEffectIdHexCharacter: string;
  dispatchAttempt: number;
}): string {
  return JSON.stringify({
    schema: AUTHORITY_OUTCOME_RECEIPT_SCHEMA,
    outcome: "uncertain" as const,
    evidenceRef: `authority-evidence-${config.identitySha256}`,
    journalEffectId: `guided-effect-${config.journalEffectIdHexCharacter.repeat(64)}`,
    dispatchAttempt: config.dispatchAttempt,
    errorCode: "effect_reconciliation_required" as const,
  });
}

function insertAuthorityOutcomeRow(db: Database, row: AuthorityOutcomeRow): void {
  db.query(`
    INSERT INTO btcc_authority_requests (${AUTHORITY_ROW_COLUMNS.join(", ")})
    VALUES (${AUTHORITY_ROW_COLUMNS.map(() => "?").join(", ")})
  `).run(...AUTHORITY_ROW_COLUMNS.map((column) => row[column]));
}

type AuthorityTableSnapshot = {
  tableDefinition: string;
  indexNames: string[];
  legacyTableNamePresent: boolean;
  rows: AuthorityOutcomeRow[];
};

function readAuthorityTableSnapshot(dbPath: string): AuthorityTableSnapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      tableDefinition: db.query<{ sql: string }, []>(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'table' AND name = 'btcc_authority_requests'
      `).get()?.sql ?? "",
      indexNames: db.query<{ name: string }, []>(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND tbl_name = 'btcc_authority_requests'
        ORDER BY name
      `).all().map((row) => row.name),
      legacyTableNamePresent: Boolean(db.query<{ name: string }, []>(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'btcc_authority_requests_af02d_legacy'
      `).get()),
      rows: db.query<AuthorityOutcomeRow, []>(`
        SELECT ${AUTHORITY_ROW_COLUMNS.join(", ")}
        FROM btcc_authority_requests ORDER BY rowid ASC
      `).all(),
    };
  } finally {
    db.close();
  }
}
