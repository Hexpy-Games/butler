/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test(
  "real App Turn cancellation closes only that self-session's open requests inside the stop transaction",
  async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-turn-stop-close-"));
  roots.push(root);
  publishNativeReadiness(root);
  const appDbPath = join(root, "app.sqlite");
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  prepareAuthorityStore(btccDbPath);
  const selfOwner = "butler/app-general";
  const islandOwner = "butler/app-island";
  seedIslandRows(btccDbPath);

  let releaseSecondTurnStarted!: () => void;
  const secondTurnStarted = new Promise<void>((resolve) => {
    releaseSecondTurnStarted = resolve;
  });
  let observedAbort = false;
  let mainRequestRef!: string;
  let round = 0;
  const reviewedCommand =
    "printf 'stop-private-value\\n' --stop-private-flag > stopped-command.txt";
  const modelRound: ModelRoundPort = {
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
                description: "Run the reviewed command only after approval",
                dependency_keys: [],
                effect: { capability: "run_command", target: "workspace-command:." },
              }],
              checks: ["stopped-command.txt exists"],
            }),
            toolCall("review", "record_work_review", {
              subject: "plan",
              verdict: "accept",
              summary: "The command is reviewed for this task.",
            }),
            toolCall("run", "run_command", {
              command: reviewedCommand,
              cwd: ".",
              state_effect: "mutation",
              summary: "Run the reviewed command",
            }),
          ],
        };
      }
      releaseSecondTurnStarted();
      const abortSignal = request.signal;
      if (!abortSignal) {
        throw new Error(
          "model round missing abort signal; failing closed instead of waiting forever",
        );
      }
      await new Promise<never>((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      return { text: "", toolCalls: [] };
    },
  };

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
    ownerId: "turn-stop-operational-close-test",
    sessionBindings: bindings,
    modelRound,
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
  const drainOptions = {
    queue,
    server: gateway,
    store: bindings,
    deliveryGuard,
    limit: 4,
    // The cancel-control lane must stay claimable while the session's
    // long-running turn occupies one dispatch slot.
    maxConcurrentSessions: 2,
  };
  try {
    const firstMessageId = "client-11111111-1111-4111-8111-111111111111";
    const firstResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Run the reviewed command only after approval.",
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "ask_first",
        client_message_id: firstMessageId,
      }),
    });
    expect(firstResponse.status).toBe(202);
    expect(inbound.poll(drainOptions).claimed).toBe(1);
    await inbound.waitForIdle();
    await waitForQueueState(appDbPath, firstMessageId, "dispatched");

    const cardsBefore = await fetch(
      `${server.url}authority-requests?session_id=general`,
    );
    expect(cardsBefore.status).toBe(200);
    const cardsBeforeBody = await cardsBefore.json() as {
      data: { requests: Array<{ request_ref: string }> };
    };
    expect(cardsBeforeBody.data.requests).toHaveLength(1);
    const requestRef = String(cardsBeforeBody.data.requests[0]!.request_ref);
    mainRequestRef = requestRef;
    const beforeClose = readAuthorityRow(btccDbPath, requestRef);
    expect(beforeClose).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: null,
      close_scope: null,
      closed_at: null,
    });
    const sourceWorkId = readBoundWorkId(btccDbPath);
    expect(sourceWorkId).toBeTruthy();

    const secondMessageId = "client-22222222-2222-4222-8222-222222222222";
    const secondResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "Continue with something else meanwhile.",
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "ask_first",
        client_message_id: secondMessageId,
      }),
    });
    expect(secondResponse.status).toBe(202);
    const secondBody = await secondResponse.json() as {
      data: { turn: { id: string } };
    };
    const cancelledTurnId = String(secondBody.data.turn.id);
    expect(inbound.poll(drainOptions).claimed).toBe(1);
    await secondTurnStarted;

    const admittedTurn = readTurnRow(btccDbPath, cancelledTurnId);
    expect(admittedTurn).toMatchObject({
      semantic_state: "admitted",
      session_id: selfOwner,
    });

    seedDecidedAppliedRow(btccDbPath);

    const cancel = await fetch(
      `${server.url}turns/${encodeURIComponent(cancelledTurnId)}/cancel`,
      { method: "POST" },
    );
    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toMatchObject({
      data: { turn: { id: cancelledTurnId, state: "cancelling" } },
    });

    expect(inbound.poll(drainOptions).claimed).toBe(1);
    await inbound.waitForIdle();
    await waitForCancellationTerminal(appDbPath, cancelledTurnId);

    expect(observedAbort).toBe(true);
    expect(readTurnRow(btccDbPath, cancelledTurnId)).toMatchObject({
      semantic_state: "cancelled",
      final_disposition: "cancelled",
      session_id: selfOwner,
    });

    const closedAtExpected = readAuthorityRow(btccDbPath, requestRef);
    expect(closedAtExpected).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "session_cancelled",
      close_scope: "self_session",
      schedule_client_message_id: beforeClose?.schedule_client_message_id,
      outcome_receipt_json: null,
    });
    expect(closedAtExpected?.closed_at).toBeTruthy();
    expect(Number.isNaN(Date.parse(closedAtExpected?.closed_at ?? ""))).toBe(false);

    const cardsAfter = await fetch(
      `${server.url}authority-requests?session_id=general`,
    );
    expect((await cardsAfter.json()) as { data: { requests: unknown[] } })
      .toMatchObject({ data: { requests: [] } });
    const islandCards = await fetch(
      `${server.url}authority-requests?session_id=island`,
    );
    expect(islandCards.status).toBe(200);
    const islandBody = await islandCards.json() as {
      data: { requests: Array<{ request_ref: string }> };
    };
    expect(islandBody.data.requests).toHaveLength(1);
    expect(islandBody.data.requests[0]!.request_ref).toBe(
      "authority-ref-stop-island",
    );

    for (const action of ["allow", "deny"]) {
      const decision = await fetch(
        `${server.url}authority-requests/${encodeURIComponent(requestRef)}/${action}?session_id=general`,
        { method: "POST" },
      );
      expect(decision.status).toBe(409);
      expect(await decision.json()).toMatchObject({
        error: { code: "authority_decision_conflict" },
      });
    }
    const modify = await fetch(
      `${server.url}authority-requests/${encodeURIComponent(requestRef)}/modify?session_id=general`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alternative: "printf replacement-value" }),
      },
    );
    expect(modify.status).toBe(409);
    expect(await modify.json()).toMatchObject({
      error: { code: "authority_decision_conflict" },
    });
    expect(readAuthorityRow(btccDbPath, requestRef))
      .toEqual(closedAtExpected);

    const effectsDb = new Database(btccDbPath, { readonly: true });
    try {
      expect(effectsDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects",
      ).get()?.count ?? 0).toBe(0);
    } finally {
      effectsDb.close();
    }
    const queuedDb = new Database(appDbPath, { readonly: true });
    let queuedRows: string;
    try {
      queuedRows = JSON.stringify(queuedDb.query<Record<string, unknown>, []>(
        "SELECT * FROM session_queued_messages",
      ).all());
    } finally {
      queuedDb.close();
    }
    expect(queuedRows).not.toContain(requestRef);
    expect(queuedRows).not.toContain(beforeClose?.schedule_client_message_id ?? "");

    expect(readWorkRow(btccDbPath, sourceWorkId!)).toMatchObject({
      status: "open",
    });
    const dispositionsDb = new Database(btccDbPath, { readonly: true });
    let dispositions: string[];
    try {
      dispositions = dispositionsDb.query<{ disposition: string }, [string]>(`
        SELECT disposition FROM btcc_guided_work_disposition_revisions
        WHERE work_id = ? ORDER BY revision ASC
      `).all(sourceWorkId!).map((row) => row.disposition);
    } finally {
      dispositionsDb.close();
    }
    expect(dispositions).not.toContain("abandoned");

    const decidedRow = readFullAuthorityRow(btccDbPath, "authority-ref-stop-done");
    expect(decidedRow).toMatchObject({
      decision: "allowed",
      outcome: "applied",
      close_reason: null,
      close_scope: null,
      closed_at: null,
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-island"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        close_scope: null,
        closed_at: null,
      });
  } finally {
    server.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-operational-close-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: selfOwner })).toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: islandOwner }))
      .toHaveLength(1);
    const persisted = readAuthorityRow(btccDbPath, mainRequestRef);
    expect(persisted).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "session_cancelled",
      close_scope: "self_session",
    });
    expect(persisted?.closed_at).toBeTruthy();
  } finally {
    reopened.close();
  }
}, 30000);

test("stop persistence follows the close truth table without rewriting decisions that won first", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-turn-stop-close-cases-"));
  roots.push(root);
  const btccDbPath = join(root, "btcc.sqlite");
  const opened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-close-truth-table",
  });
  try {
    seedStopCloseSession(btccDbPath, {
      hint: "pending",
      workId: "work-stop-pending",
      requestRef: "authority-ref-stop-pending",
      privateValue: "truth-pending-value",
      clientMessageId: "client-truth-pending-0000000000000000000000",
    });

    expect(await opened.turns.stopTurn("turn-never-admitted"))
      .toEqual({ kind: "cancelled", turnId: "turn-never-admitted" });
    expect(readStopRequestRow(btccDbPath, "turn-never-admitted")).toMatchObject({
      status: "cancelled_before_admission",
      observed_turn_revision: -1,
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-pending"))
      .toMatchObject({ decision: "pending", close_reason: null });

    seedStopCloseSession(btccDbPath, {
      hint: "delivered",
      workId: "work-stop-delivered",
      requestRef: "authority-ref-stop-delivered",
      privateValue: "truth-delivered-value",
      clientMessageId: "client-truth-delivered-00000000000000000000",
    });
    const deliveredContent = "delivered final answer remains visible";
    const deliveredContentSha256 = createHash("sha256")
      .update(deliveredContent)
      .digest("hex");
    insertGuidedTurn(btccDbPath, {
      turnId: "turn-delivered-source",
      sessionId: "butler/app-delivered",
      semanticState: "delivered",
      revision: 3,
      executionFence: 2,
      canonicalAssistantMessageId: "assistant-delivered-source",
      finalPayloadJson: JSON.stringify({
        ref: {
          id: "payload-turn-delivered-source",
          sha256: deliveredContentSha256,
        },
        content: deliveredContent,
        contentSha256: deliveredContentSha256,
      }),
    });
    expect(await opened.turns.stopTurn("turn-delivered-source")).toEqual({
      kind: "already_delivered",
      turnId: "turn-delivered-source",
      messageId: "assistant-delivered-source",
      content: deliveredContent,
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-delivered"))
      .toMatchObject({ decision: "pending", close_reason: null });

    seedStopCloseSession(btccDbPath, {
      hint: "finalizing",
      workId: "work-stop-finalizing",
      requestRef: "authority-ref-stop-finalizing",
      privateValue: "truth-finalizing-value",
      clientMessageId: "client-truth-finalizing-0000000000000000000",
    });
    insertGuidedTurn(btccDbPath, {
      turnId: "turn-finalizing-source",
      sessionId: "butler/app-finalizing",
      semanticState: "delivery_committed",
      revision: 2,
      executionFence: 1,
    });
    expect(await opened.turns.stopTurn("turn-finalizing-source")).toEqual({
      kind: "already_finalizing",
      turnId: "turn-finalizing-source",
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-finalizing"))
      .toMatchObject({ decision: "pending", close_reason: null });

    seedStopCloseSession(btccDbPath, {
      hint: "won",
      workId: "work-stop-won",
      requestRef: "authority-ref-stop-won",
      privateValue: "truth-won-value",
      clientMessageId: "client-truth-won-000000000000000000000000",
    });
    expect(opened.authority.decide({
      ownerSessionId: "butler/app-won",
      requestRef: "authority-ref-stop-won",
      sourceSessionId: "butler/app-won",
      action: "allow",
    }).decision).toBe("allowed");
    const decidedSnapshot = readFullAuthorityRow(
      btccDbPath,
      "authority-ref-stop-won",
    );
    expect(decidedSnapshot).toMatchObject({ decision: "allowed" });
    insertGuidedTurn(btccDbPath, {
      turnId: "turn-won-source",
      sessionId: "butler/app-won",
      semanticState: "admitted",
    });
    expect(await opened.turns.stopTurn("turn-won-source")).toEqual({
      kind: "cancelled",
      turnId: "turn-won-source",
    });
    expect(readFullAuthorityRow(btccDbPath, "authority-ref-stop-won"))
      .toEqual(decidedSnapshot);
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-won"))
      .toMatchObject({ decision: "allowed", close_reason: null });

    seedStopCloseSession(btccDbPath, {
      hint: "admitted",
      workId: "work-stop-admitted",
      requestRef: "authority-ref-stop-admitted",
      privateValue: "truth-admitted-value",
      clientMessageId: "client-truth-admitted-000000000000000000000",
    });
    insertGuidedTurn(btccDbPath, {
      turnId: "turn-admitted-source",
      sessionId: "butler/app-admitted",
      semanticState: "admitted",
    });
    expect(await opened.turns.stopTurn("turn-admitted-source")).toEqual({
      kind: "cancelled",
      turnId: "turn-admitted-source",
    });
    expect(readTurnRow(btccDbPath, "turn-admitted-source")).toMatchObject({
      semantic_state: "cancelled",
      revision: 1,
      execution_fence: 1,
      final_disposition: "cancelled",
    });
    expect(
      readStopRequestRow(btccDbPath, "turn-admitted-source"),
    ).toMatchObject({
      status: "cancelled",
      observed_turn_revision: 1,
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-admitted"))
      .toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: "session_cancelled",
        close_scope: "self_session",
        outcome_receipt_json: null,
      });
    expect(
      readAuthorityRow(btccDbPath, "authority-ref-stop-admitted")?.closed_at,
    ).toBeTruthy();

    insertOpenWork(btccDbPath, {
      workId: "work-stop-admitted-newer",
      sessionId: "butler/app-admitted",
    });
    insertAuthorityRequest(btccDbPath, {
      requestRef: "authority-ref-stop-admitted-newer",
      ownerSessionId: "butler/app-admitted",
      sourceWorkId: "work-stop-admitted-newer",
      privateCommand: "printf 'truth-admitted-newer-value'",
      clientMessageId: "client-truth-admitted-newer-000000000000000000",
    });
    expect(readFullAuthorityRow(
      btccDbPath,
      "authority-ref-stop-admitted-newer",
    )).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: null,
      close_scope: null,
      closed_at: null,
    });
  } finally {
    opened.close();
  }

  const replayedTurnBeforeReopen = readTurnRow(btccDbPath, "turn-admitted-source");
  const replayedRequestBeforeReopen = readFullAuthorityRow(
    btccDbPath,
    "authority-ref-stop-admitted",
  );
  const newerOpenBeforeReplay = readFullAuthorityRow(
    btccDbPath,
    "authority-ref-stop-admitted-newer",
  );

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-close-truth-table-2",
  });
  try {
    expect(await reopened.turns.stopTurn("turn-admitted-source")).toEqual({
      kind: "already_cancelled",
      turnId: "turn-admitted-source",
    });
    expect(readTurnRow(btccDbPath, "turn-admitted-source"))
      .toEqual(replayedTurnBeforeReopen);
    expect(readFullAuthorityRow(btccDbPath, "authority-ref-stop-admitted"))
      .toEqual(replayedRequestBeforeReopen);
    expect(readStopRequestRow(btccDbPath, "turn-admitted-source")).toMatchObject({
      status: "already_cancelled",
      observed_turn_revision: 1,
    });
    expect(readFullAuthorityRow(btccDbPath, "authority-ref-stop-admitted-newer"))
      .toEqual(newerOpenBeforeReplay);
    expect(readFullAuthorityRow(btccDbPath, "authority-ref-stop-won"))
      .toMatchObject({ decision: "allowed", close_reason: null });
    const stillListed = reopened.authority.list({
      ownerSessionId: "butler/app-admitted",
    });
    expect(stillListed).toHaveLength(1);
    expect(stillListed[0]).toMatchObject({
      request_ref: "authority-ref-stop-admitted-newer",
    });

    seedStopCloseSession(btccDbPath, {
      hint: "legacy",
      workId: "work-stop-legacy",
      requestRef: "authority-ref-stop-legacy",
      privateValue: "truth-legacy-value",
      clientMessageId: "client-truth-legacy-00000000000000000000000",
    });
    insertGuidedTurn(btccDbPath, {
      turnId: "turn-legacy-cancelled-source",
      sessionId: "butler/app-legacy",
      semanticState: "cancelled",
    });
    expect(await reopened.turns.stopTurn("turn-legacy-cancelled-source"))
      .toEqual({
        kind: "already_cancelled",
        turnId: "turn-legacy-cancelled-source",
      });
    expect(readStopRequestRow(btccDbPath, "turn-legacy-cancelled-source"))
      .toMatchObject({
        status: "already_cancelled",
        observed_turn_revision: 0,
      });
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-legacy"))
      .toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: "session_cancelled",
        close_scope: "self_session",
      });
    expect(
      readAuthorityRow(btccDbPath, "authority-ref-stop-legacy")?.closed_at,
    ).toBeTruthy();
    expect(reopened.authority.list({ ownerSessionId: "butler/app-admitted" }))
      .toEqual(stillListed);
  } finally {
    reopened.close();
  }
});

test("fenced authority close rolls back Turn CAS, stop-request write, and authority close together in one stop transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-turn-stop-fenced-"));
  roots.push(root);
  const btccDbPath = join(root, "btcc.sqlite");
  prepareAuthorityStore(btccDbPath);
  seedStopCloseSession(btccDbPath, {
    hint: "fenced",
    workId: "work-stop-fenced",
    requestRef: "authority-ref-stop-fenced",
    privateValue: "truth-fenced-value",
    clientMessageId: "client-truth-fenced-000000000000000000000",
  });
  insertGuidedTurn(btccDbPath, {
    turnId: "turn-fenced-source",
    sessionId: "butler/app-fenced",
    semanticState: "admitted",
  });
  const turnBeforeFence = readTurnRow(btccDbPath, "turn-fenced-source");
  const authorityBeforeFence = readFullAuthorityRow(
    btccDbPath,
    "authority-ref-stop-fenced",
  );
  expect(turnBeforeFence).toMatchObject({ semantic_state: "admitted" });
  expect(authorityBeforeFence).toMatchObject({
    decision: "pending",
    close_reason: null,
  });

  blockAuthoritySelfSessionCloses(btccDbPath, "fence_btcc_authority_close");
  const fenced = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-close-fenced",
  });
  try {
    await expect(fenced.turns.stopTurn("turn-fenced-source")).rejects.toThrow(
      "forced btcc authority self-session close",
    );
    expect(readTurnRow(btccDbPath, "turn-fenced-source"))
      .toEqual(turnBeforeFence);
    expect(readFullAuthorityRow(btccDbPath, "authority-ref-stop-fenced"))
      .toEqual(authorityBeforeFence);
    expect(readStopRequestRow(btccDbPath, "turn-fenced-source")).toBeNull();
  } finally {
    unblockAuthoritySelfSessionCloses(btccDbPath, "fence_btcc_authority_close");
    fenced.close();
  }

  const retried = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-close-fenced-retry",
  });
  try {
    expect(await retried.turns.stopTurn("turn-fenced-source")).toEqual({
      kind: "cancelled",
      turnId: "turn-fenced-source",
    });
    expect(readTurnRow(btccDbPath, "turn-fenced-source")).toMatchObject({
      semantic_state: "cancelled",
      final_disposition: "cancelled",
    });
    expect(readStopRequestRow(btccDbPath, "turn-fenced-source")).toMatchObject({
      status: "cancelled",
      observed_turn_revision: 1,
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-stop-fenced"))
      .toMatchObject({
        decision: "pending",
        close_reason: "session_cancelled",
        close_scope: "self_session",
      });
  } finally {
    retried.close();
  }
});

test("frozen Slice-1 schema migrates to session_cancelled preserving every existing close audit exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-turn-stop-close-migration-"));
  roots.push(root);
  const btccDbPath = join(root, "btcc.sqlite");
  const frozenSliceOneSchema = BTCC_AUTHORITY_SCHEMA.replace(
    `'session_archived', 'session_permanently_deleted', 'session_cancelled',
      'work_abandoned'`,
    "'session_archived', 'session_permanently_deleted', 'session_cancelled'",
  ).replace(
    "close_scope IN ('self_session', 'work')",
    "close_scope = 'self_session'",
  );
  if (
    frozenSliceOneSchema === BTCC_AUTHORITY_SCHEMA ||
    !frozenSliceOneSchema.includes("'session_cancelled'") ||
    frozenSliceOneSchema.includes("'work_abandoned'") ||
    frozenSliceOneSchema.includes("close_scope IN ('self_session', 'work')") ||
    !frozenSliceOneSchema.includes("'session_archived', 'session_permanently_deleted'")
  ) {
    throw new Error("Frozen Slice-1 authority schema was not constructed exactly");
  }
  mkdirSync(join(root, "agent-runtime"), { recursive: true });
  const seed = new Database(btccDbPath);
  const receiptJson = JSON.stringify({
    schema: "butler.authority-outcome-receipt.v1",
    outcome: "applied",
    evidenceRef: `authority-evidence-${"a".repeat(64)}`,
    journalEffectId: `guided-effect-${"b".repeat(64)}`,
    dispatchAttempt: 2,
  });
  const uncertainReceiptJson = JSON.stringify({
    schema: "butler.authority-outcome-receipt.v1",
    outcome: "uncertain",
    evidenceRef: `authority-evidence-${"c".repeat(64)}`,
    journalEffectId: `guided-effect-${"d".repeat(64)}`,
    dispatchAttempt: 1,
  });
  try {
    seed.exec(frozenSliceOneSchema);
    insertMigrationRow(seed, {
      ref: "authority-ref-mig-archived",
      identity: "mig-archived",
      decision: "pending",
      outcome: "pending",
      closeReason: "session_archived",
      closedAt: "2026-08-23T07:00:00.000Z",
      receiptJson: null,
    });
    insertMigrationRow(seed, {
      ref: "authority-ref-mig-deleted",
      identity: "mig-deleted",
      decision: "pending",
      outcome: "pending",
      closeReason: "session_permanently_deleted",
      closedAt: "2026-08-23T07:30:00.000Z",
      receiptJson: null,
    });
    insertMigrationRow(seed, {
      ref: "authority-ref-mig-applied",
      identity: "mig-applied",
      decision: "allowed",
      outcome: "applied",
      closeReason: null,
      closedAt: null,
      receiptJson,
    });
    insertMigrationRow(seed, {
      ref: "authority-ref-mig-failed",
      identity: "mig-failed",
      decision: "allowed",
      outcome: "failed",
      closeReason: null,
      closedAt: null,
      receiptJson: null,
    });
    insertMigrationRow(seed, {
      ref: "authority-ref-mig-uncertain",
      identity: "mig-uncertain",
      decision: "allowed",
      outcome: "uncertain",
      closeReason: null,
      closedAt: null,
      receiptJson: uncertainReceiptJson,
    });
    insertMigrationRow(seed, {
      ref: "authority-ref-mig-open",
      identity: "mig-open",
      decision: "pending",
      outcome: "pending",
      closeReason: null,
      closedAt: null,
      receiptJson: null,
    });
  } finally {
    seed.close();
  }

  const migrated = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-close-migration-1",
  });
  migrated.close();

  const definitionAfter = readTableDefinition(btccDbPath);
  expect(definitionAfter).toContain(
    "'session_archived', 'session_permanently_deleted', 'session_cancelled'",
  );
  expect(definitionAfter).toContain("'work_abandoned'");
  expect(definitionAfter).toContain("close_scope IN ('self_session', 'work')");
  const legacyPresent = queryScalar(btccDbPath, `
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'table' AND name = 'btcc_authority_requests_af02d_legacy'
  `);
  expect(legacyPresent).toBe(0);
  const afterFirstMigration = readAllAuthorityRows(btccDbPath);
  expect(afterFirstMigration.map((row) => [
    row.request_ref, row.decision, row.outcome,
    row.close_reason, row.close_scope, row.closed_at,
    row.outcome_receipt_json,
  ])).toEqual([
    ["authority-ref-mig-archived", "pending", "pending",
      "session_archived", "self_session", "2026-08-23T07:00:00.000Z", null],
    ["authority-ref-mig-deleted", "pending", "pending",
      "session_permanently_deleted", "self_session", "2026-08-23T07:30:00.000Z", null],
    ["authority-ref-mig-applied", "allowed", "applied",
      null, null, null, receiptJson],
    ["authority-ref-mig-failed", "allowed", "failed",
      null, null, null, null],
    ["authority-ref-mig-uncertain", "allowed", "uncertain",
      null, null, null, uncertainReceiptJson],
    ["authority-ref-mig-open", "pending", "pending", null, null, null, null],
  ]);

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-close-migration-2",
  });
  try {
    expect(queryScalar(btccDbPath, `
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name = 'btcc_authority_requests_af02d_legacy'
    `)).toBe(0);
    expect(
      reopened.authority.closeSelfSession({
        selfSessionId: "butler/app-mig-owner",
        reason: "session_cancelled",
      }).closedCount,
    ).toBe(1);
    expect(readAuthorityRow(btccDbPath, "authority-ref-mig-open")).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "session_cancelled",
      close_scope: "self_session",
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-mig-open")?.closed_at)
      .toBeTruthy();
    expect(readFullAuthorityRow(btccDbPath, "authority-ref-mig-archived")).toEqual(
      afterFirstMigration      .find((row) =>
        row.request_ref === "authority-ref-mig-archived",
      ) ?? null,
    );
  } finally {
    reopened.close();
  }

  const definitionBeforeThirdReopen = readTableDefinition(btccDbPath);
  const rowsBeforeThirdReopen = readAllAuthorityRows(btccDbPath);
  expect(definitionBeforeThirdReopen).toEqual(definitionAfter);

  const reopenedAgain = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "turn-stop-close-migration-3",
  });
  reopenedAgain.close();
  expect(readTableDefinition(btccDbPath)).toEqual(definitionBeforeThirdReopen);
  expect(readAllAuthorityRows(btccDbPath)).toEqual(rowsBeforeThirdReopen);
  expect(rowsBeforeThirdReopen.map((row) => row.request_ref)).toEqual([
    "authority-ref-mig-archived",
    "authority-ref-mig-deleted",
    "authority-ref-mig-applied",
    "authority-ref-mig-failed",
    "authority-ref-mig-uncertain",
    "authority-ref-mig-open",
  ]);
});

function seedStopCloseSession(
  dbPath: string,
  input: {
    hint: string;
    workId: string;
    requestRef: string;
    privateValue: string;
    clientMessageId: string;
  },
): void {
  insertOpenWork(dbPath, {
    workId: input.workId,
    sessionId: `butler/app-${input.hint}`,
  });
  insertAuthorityRequest(dbPath, {
    requestRef: input.requestRef,
    ownerSessionId: `butler/app-${input.hint}`,
    sourceWorkId: input.workId,
    privateCommand: `printf '${input.privateValue}'`,
    clientMessageId: input.clientMessageId,
  });
}

type SeededTurnConfig = {
  turnId: string;
  sessionId: string;
  semanticState: "admitted" | "delivery_committed" | "delivered" | "cancelled";
  revision?: number;
  executionFence?: number;
  canonicalAssistantMessageId?: string;
  finalPayloadJson?: string;
};

function insertGuidedTurn(dbPath: string, config: SeededTurnConfig): void {
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, final_payload_json,
        canonical_assistant_message_id, revision, execution_fence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.turnId,
      config.sessionId,
      `inbox-${config.turnId}`,
      `trigger-${config.turnId}`,
      `message-${config.turnId}`,
      "Seeded stop-close truth Turn",
      "admission-snapshot-seeded",
      JSON.stringify({ providerId: "openai", modelRef: "openai/gpt-5.5" }),
      "{}",
      config.semanticState,
      config.finalPayloadJson ?? null,
      config.canonicalAssistantMessageId ?? null,
      config.revision ?? 0,
      config.executionFence ?? 0,
    );
  } finally {
    db.close();
  }
}

function readStopRequestRow(
  dbPath: string,
  turnId: string,
): { status: string; observed_turn_revision: number } | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<
      { status: string; observed_turn_revision: number },
      [string]
    >(`
      SELECT status, observed_turn_revision
      FROM btcc_stop_requests WHERE turn_id = ?
    `).get(turnId) ?? null;
  } finally {
    db.close();
  }
}

function blockAuthoritySelfSessionCloses(
  dbPath: string,
  triggerName: string,
): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TRIGGER ${triggerName} BEFORE UPDATE ON btcc_authority_requests
      WHEN NEW.close_reason IS NOT NULL AND OLD.close_reason IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced btcc authority self-session close');
      END;
    `);
  } finally {
    db.close();
  }
}

function unblockAuthoritySelfSessionCloses(
  dbPath: string,
  triggerName: string,
): void {
  const db = new Database(dbPath);
  try {
    db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
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

function prepareAuthorityStore(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const prepared = openBtccSqliteStores({
    dbPath,
    ownerId: "turn-stop-operational-close-setup",
  });
  prepared.close();
}

function seedIslandRows(dbPath: string): void {
  insertOpenWork(dbPath, {
    workId: "work-stop-island",
    sessionId: "butler/app-island",
  });
  insertAuthorityRequest(dbPath, {
    requestRef: "authority-ref-stop-island",
    ownerSessionId: "butler/app-island",
    sourceWorkId: "work-stop-island",
    privateCommand: "printf 'island-stop-private-value'",
    clientMessageId: "client-stop-island-0000000000000000000000000",
  });
}

function seedDecidedAppliedRow(dbPath: string): void {
  insertOpenWork(dbPath, {
    workId: "work-stop-done",
    sessionId: "butler/app-general",
  });
  insertAuthorityRequest(dbPath, {
    requestRef: "authority-ref-stop-done",
    ownerSessionId: "butler/app-general",
    sourceWorkId: "work-stop-done",
    privateCommand: "printf 'done-stop-private-value'",
    clientMessageId: "client-stop-done-00000000000000000000000000",
  });
  const db = new Database(dbPath);
  try {
    db.query(`
      UPDATE btcc_authority_requests
      SET decision = 'allowed', outcome = 'applied'
      WHERE request_ref = 'authority-ref-stop-done'
    `).run();
  } finally {
    db.close();
  }
}

type SeededRequestConfig = {
  requestRef: string;
  ownerSessionId: string;
  sourceWorkId: string;
  privateCommand: string;
  clientMessageId: string;
};

function insertAuthorityRequest(dbPath: string, config: SeededRequestConfig): void {
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO btcc_authority_requests (
        request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision,
        schedule_client_message_id, schedule_input_text, outcome,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `).run(
      `request-${config.requestRef}`,
      config.requestRef,
      config.requestRef,
      config.ownerSessionId,
      config.ownerSessionId,
      `turn-${config.requestRef}`,
      config.sourceWorkId,
      "workspace-command-seeded",
      `plan-${config.sourceWorkId}`,
      "run-seeded-command",
      1,
      "run_command",
      "workspace-command:.",
      JSON.stringify({
        command: config.privateCommand,
        cwd: ".",
        state_effect: "mutation",
      }),
      "openai/gpt-5.5",
      "low",
      "command",
      "Run one reviewed seeded command",
      "printf",
      1,
      "pending",
      config.clientMessageId,
      "Continue the approved operation exactly once.",
      "pending",
      "2026-08-23T09:00:00.000Z",
      "2026-08-23T09:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

function insertOpenWork(
  dbPath: string,
  input: { workId: string; sessionId: string },
): void {
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO btcc_guided_works (
        work_id, session_id, scope_kind, scope_ref, origin_turn_id,
        origin_message_id, objective, status, created_at, updated_at
      ) VALUES (?, ?, 'session', 'seeded', 'seeded-origin-turn',
        'seeded-origin-message', 'Seeded stop-close Work', 'open',
        '2026-08-23T08:00:00.000Z', '2026-08-23T08:00:00.000Z')
    `).run(input.workId, input.sessionId);
  } finally {
    db.close();
  }
}

type AuthorityRowSnapshot = {
  decision: string;
  outcome: string;
  schedule_client_message_id: string;
  close_reason: string | null;
  close_scope: string | null;
  closed_at: string | null;
  updated_at: string;
  outcome_receipt_json: string | null;
};

function readAuthorityRow(dbPath: string, requestRef: string): AuthorityRowSnapshot | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<AuthorityRowSnapshot, [string]>(`
      SELECT decision, outcome, schedule_client_message_id,
        close_reason, close_scope, closed_at, updated_at, outcome_receipt_json
      FROM btcc_authority_requests WHERE request_ref = ?
    `).get(requestRef) ?? null;
  } finally {
    db.close();
  }
}

const FULL_ROW_COLUMNS = [
  "request_id", "request_ref", "identity_sha256", "owner_session_id",
  "source_session_id", "source_turn_id", "source_work_id", "workspace_path",
  "plan_revision_id", "action_key", "authority_generation", "capability",
  "normalized_target", "normalized_input_json", "model_ref", "reasoning_effort",
  "category", "reason", "executable", "command_count", "decision",
  "schedule_client_message_id", "schedule_input_text",
  "private_alternative_input", "outcome", "outcome_receipt_json",
  "close_reason", "close_scope", "closed_at", "created_at", "updated_at",
] as const;

function readFullAuthorityRow(
  dbPath: string,
  requestRef: string,
): Record<string, unknown> | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<Record<string, unknown>, [string]>(`
      SELECT ${FULL_ROW_COLUMNS.join(", ")}
      FROM btcc_authority_requests WHERE request_ref = ?
    `).get(requestRef) ?? null;
  } finally {
    db.close();
  }
}

type MigrationRow = {
  request_ref: string;
  identity_sha256: string;
  owner_session_id: string;
  source_turn_id: string;
  source_work_id: string;
  plan_revision_id: string;
  decision: string;
  outcome: string;
  close_reason: string | null;
  close_scope: string | null;
  closed_at: string | null;
  outcome_receipt_json: string | null;
  created_at: string;
  updated_at: string;
  [column: string]: unknown;
};

function readAllAuthorityRows(dbPath: string): MigrationRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<MigrationRow, []>(`
      SELECT ${FULL_ROW_COLUMNS.join(", ")}
      FROM btcc_authority_requests ORDER BY rowid ASC
    `).all();
  } finally {
    db.close();
  }
}

function readTableDefinition(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ sql: string }, []>(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'btcc_authority_requests'
    `).get()?.sql ?? "";
  } finally {
    db.close();
  }
}

function queryScalar(dbPath: string, sql: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ count: number }, []>(sql).get()?.count ?? 0;
  } finally {
    db.close();
  }
}

function insertMigrationRow(db: Database, row: {
  ref: string;
  identity: string;
  decision: string;
  outcome: string;
  closeReason: string | null;
  closedAt: string | null;
  receiptJson: string | null;
}): void {
  db.query(`
    INSERT INTO btcc_authority_requests (
      request_id, request_ref, identity_sha256, owner_session_id,
      source_session_id, source_turn_id, source_work_id, workspace_path,
      plan_revision_id, action_key, authority_generation, capability,
      normalized_target, normalized_input_json, model_ref, reasoning_effort,
      category, reason, executable, command_count, decision,
      schedule_client_message_id, schedule_input_text, outcome,
      outcome_receipt_json, close_reason, close_scope, closed_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    `request-${row.ref}`,
    row.ref,
    row.identity,
    "butler/app-mig-owner",
    "butler/app-mig-owner",
    `turn-${row.ref}`,
    `work-${row.ref}`,
    "workspace-command-seeded",
    `plan-${row.ref}`,
    "run-seeded-command",
    1,
    "run_command",
    "workspace-command:.",
    JSON.stringify({
      command: "printf 'migration-stop-private-value'",
      cwd: ".",
      state_effect: "mutation",
    }),
    "openai/gpt-5.5",
    "low",
    "command",
    "Run one reviewed migration command",
    "printf",
    1,
    row.decision,
    `client-${row.ref}`,
    "Continue the approved operation exactly once.",
    row.outcome,
    row.receiptJson,
    row.closeReason,
    row.closeReason === null ? null : "self_session",
    row.closedAt,
    "2026-08-23T06:00:00.000Z",
    "2026-08-23T06:00:00.000Z",
  );
}

type TurnRowSnapshot = {
  turn_id: string;
  session_id: string;
  semantic_state: string;
  revision: number;
  execution_fence: number;
  final_disposition: string | null;
};

function readTurnRow(dbPath: string, turnId: string): TurnRowSnapshot | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<TurnRowSnapshot, [string]>(`
      SELECT turn_id, session_id, semantic_state, revision, execution_fence,
        final_disposition
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId) ?? null;
  } finally {
    db.close();
  }
}

function readBoundWorkId(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ work_id: string }, []>(`
      SELECT work_id FROM btcc_guided_turn_work_bindings
      WHERE is_current = 1 ORDER BY rowid DESC LIMIT 1
    `).get()?.work_id ?? null;
  } finally {
    db.close();
  }
}

function readWorkRow(
  dbPath: string,
  workId: string,
): { work_id: string; status: string } | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ work_id: string; status: string }, [string]>(`
      SELECT work_id, status FROM btcc_guided_works WHERE work_id = ?
    `).get(workId) ?? null;
  } finally {
    db.close();
  }
}

async function waitForQueueState(
  dbPath: string,
  clientMessageId: string,
  state: string,
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
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
    const queuedRow = db.query<
      {
        state: string;
        safe_error_code: string | null;
        turn_id: string | null;
      },
      [string]
    >(`
      SELECT state, safe_error_code, turn_id
      FROM session_queued_messages WHERE client_message_id = ?
    `).get(clientMessageId);
    const appTurn = queuedRow?.turn_id
      ? db.query<
        { state: string; safe_error_code: string | null },
        [string]
      >("SELECT state, safe_error_code FROM turns WHERE id = ?")
        .get(queuedRow.turn_id) ?? null
      : null;
    throw new Error(
      `Queue state did not become ${state} for ${clientMessageId}; ` +
        `queued=${JSON.stringify(queuedRow ?? null)} appTurn=${
          JSON.stringify(appTurn)
        }`,
    );
  } finally {
    db.close();
  }
}

async function waitForCancellationTerminal(
  dbPath: string,
  turnId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const outbox = db.query<{ state: string }, [string]>(
        "SELECT state FROM app_turn_cancel_outbox WHERE turn_id = ?",
      ).get(turnId)?.state;
      const turn = db.query<{ state: string }, [string]>(
        "SELECT state FROM turns WHERE id = ?",
      ).get(turnId)?.state;
      if (outbox === "completed" && turn === "cancelled") return;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Cancellation terminal projection did not settle for ${turnId}`);
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>) {
  return {
    id,
    name,
    arguments: argumentsValue,
    rawArguments: JSON.stringify(argumentsValue),
  };
}
