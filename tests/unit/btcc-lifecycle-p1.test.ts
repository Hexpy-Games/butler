import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { createTelegramTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/telegram/adapter.ts";
import { createNativeButlerProgressPublisher } from
  "../../packages/butler-agent/src/interfaces/gateway/native-butler/projection-and-lifecycle.ts";
import { createBtccTrustedWakeProjectionHost } from
  "../../packages/butler-agent/src/agent/btcc/projection/btcc-trusted-wake-producer.ts";
import { createBtccProgressProjectionHost } from
  "../../packages/butler-agent/src/agent/btcc/projection/btcc-progress-outbox-consumer.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import type { BtccTurnRequest } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import type { BtccWakeCompletionCandidate } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import { btccCompletionWakeCandidates } from
  "../../packages/butler-agent/src/agent/work/completion-router.ts";
import { buildTaskOriginContext } from
  "../../packages/butler-agent/src/agent/work/task-origin.ts";

test("worker completion becomes a wake candidate only with explicit continuation intent", () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-completion-wake-candidate-"));
  const taskDir = join(root, "tasks", "worker-explicit-continuation");
  try {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
    writeFileSync(join(taskDir, "request.md"), "run worker\n", "utf8");
    writeFileSync(join(taskDir, "result.md"), "trusted result\n", "utf8");
    writeFileSync(join(taskDir, "worker_activity_events.jsonl"), [
      JSON.stringify({
        semantic_phase: "executing",
        action_kind: "run_worker",
        status_line: "Worker completed the requested result.",
        evidence_refs: ["result.md"],
      }),
      JSON.stringify({
        semantic_phase: "verifying",
        action_kind: "verify_result",
        status_line: "Worker verified the requested result.",
        evidence_refs: ["result.md"],
      }),
    ].join("\n") + "\n", "utf8");
    writeFileSync(join(taskDir, "origin.json"), `${JSON.stringify(buildTaskOriginContext({
      sessionId: "session-source",
      taskSummary: "explicit continuation",
      project: null,
      btccContinuation: {
        requested: true,
        source_turn_id: "source-turn",
        authorization_ref: "authorization-1",
        result_scope_ref: "scope-1",
      },
    }), null, 2)}\n`, "utf8");

    expect(btccCompletionWakeCandidates({
      butlerData: root,
      consumer: "native",
    })).toMatchObject([{
      taskId: "worker-explicit-continuation",
      originSessionId: "session-source",
      sourceTurnId: "source-turn",
      authorizationRef: "authorization-1",
      resultScopeRef: "scope-1",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress outbox reopens all Turns with stable identity and retries after failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-progress-reconcile-"));
  const dbPath = join(root, "btcc.sqlite");
  const destination = {
    transport: "app",
    accountId: "local",
    peer: { kind: "dm" as const, id: "general" },
    replyToMessageId: "message-progress",
  };
  const first = openBtccSqliteStores({
    dbPath,
    ownerId: "progress-reconcile-1",
    storageProfile: "ephemeral",
  });
  let snapshot: Array<{ eventId: string; actionId: string; sessionSequence: number; turnSequence: number }> = [];
  try {
    const events = [
      first.progressEvents.append({
        sessionId: "session-progress",
        turnId: "turn-progress-a",
        destination,
        event: { kind: "turn.started" },
      }),
      first.progressEvents.append({
        sessionId: "session-progress",
        turnId: "turn-progress-b",
        destination,
        event: { kind: "turn.started" },
      }),
    ];
    snapshot = events.map(({ eventId, actionId, sessionSequence, turnSequence }) => ({
      eventId,
      actionId,
      sessionSequence,
      turnSequence,
    }));
  } finally {
    first.close();
  }

  const reopened = openBtccSqliteStores({
    dbPath,
    ownerId: "progress-reconcile-2",
    storageProfile: "ephemeral",
  });
  try {
    const host = createBtccProgressProjectionHost(reopened.progressEvents);
    const failed = await host.reconcile({
      publish() {
        throw new Error("projection unavailable");
      },
    });
    expect(failed).toMatchObject({ attempted: 2, published: 0, pending: 2 });
    const delivered: string[] = [];
    const success = await host.reconcile({
      publish(event) {
        delivered.push(event.eventId);
      },
    });
    expect(success).toMatchObject({ attempted: 2, published: 2, pending: 0 });
    expect(delivered).toEqual(snapshot.map((event) => event.eventId));
    expect(reopened.progressEvents.forTurn("turn-progress-a")[0]).toMatchObject(snapshot[0]!);
    expect(reopened.progressEvents.forTurn("turn-progress-b")[0]).toMatchObject(snapshot[1]!);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native progress policy publishes App and Telegram while unknown stays pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-progress-policy-"));
  const dbPath = join(root, "btcc.sqlite");
  const telegramMessages: string[] = [];
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "progress-policy",
    storageProfile: "ephemeral",
  });
  const destination = (transport: string) => ({
    transport,
    accountId: "local",
    peer: { kind: "dm" as const, id: "general" },
    replyToMessageId: "message-progress-policy",
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [
      createAppTransportAdapter(),
      createTelegramTransportAdapter({
        sendTelegram: async (input) => {
          telegramMessages.push(input.text);
          return { ok: true, transportMessageId: "telegram-progress" };
        },
      }),
    ],
    butlerData: root,
  });
  try {
    stores.progressEvents.append({
      sessionId: "session-app-progress",
      turnId: "turn-app-progress",
      destination: destination("app"),
      event: { kind: "turn.started" },
    });
    stores.progressEvents.append({
      sessionId: "session-telegram-progress",
      turnId: "turn-telegram-progress",
      destination: destination("telegram"),
      event: { kind: "turn.started" },
    });
    stores.progressEvents.append({
      sessionId: "session-unknown-progress",
      turnId: "turn-unknown-progress",
      destination: destination("unknown"),
      event: { kind: "turn.started" },
    });

    const host = createBtccProgressProjectionHost(stores.progressEvents);
    const summary = await host.reconcile({
      publish: createNativeButlerProgressPublisher({
        deliver: (sessionId, action, metadata) =>
          deliveryGuard.deliver(sessionId, action, metadata),
      }).publish,
    });

    expect(summary).toMatchObject({ attempted: 3, published: 2, pending: 1 });
    expect(stores.progressEvents.forTurn("turn-app-progress")[0]?.status).toBe("published");
    expect(stores.progressEvents.forTurn("turn-telegram-progress")[0]?.status).toBe("published");
    expect(stores.progressEvents.pending().map((event) => event.turnId)).toEqual([
      "turn-unknown-progress",
    ]);
    expect(telegramMessages).toEqual([]);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted worker completion requires a pre-recorded exact wake tuple", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-trusted-wake-"));
  const facts = new Set(["source-turn\0authorization-1\0scope-1"]);
  const validationCalls: string[] = [];
  const dispatched: BtccTurnRequest[] = [];
  const source = sourceTurn();
  try {
    const host = createBtccTrustedWakeProjectionHost({
      turns: { findTurn: async (turnId) => turnId === source.turnId ? source : null },
      wakeAuthorizations: {
        validateWake(input) {
          validationCalls.push(factKey(input));
          return facts.has(factKey(input));
        },
      },
      dispatch: async (request) => {
        expect(facts.has(factKey({
          sourceTurnId: request.trigger.kind === "authorized_wake"
            ? request.trigger.sourceTurnId
            : "",
          authorizationRef: request.trigger.kind === "authorized_wake"
            ? request.trigger.authorizationRef
            : "",
          resultScopeRef: request.trigger.kind === "authorized_wake"
            ? request.trigger.resultScopeRef
            : undefined,
        }))).toBe(true);
        dispatched.push(request);
        return {
          kind: "delivered",
          turnId: request.turnId,
          messageId: `assistant:${request.turnId}`,
          content: "continued",
        };
      },
      queueDir: join(root, "wake-outbox"),
    });
    const candidate = validCandidate();

    const first = await host.reconcile([candidate]);
    expect(first).toMatchObject({
      candidates: 1,
      authorized: 1,
      rejected: 0,
      dispatched: 1,
      pending: 0,
    });
    expect(facts.has("source-turn\0authorization-1\0scope-1")).toBe(true);
    expect(validationCalls).toEqual([
      "source-turn\0authorization-1\0scope-1",
      "source-turn\0authorization-1\0scope-1",
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.trigger).toEqual({
      kind: "authorized_wake",
      triggerId: "btcc-wake-trigger:worker-1",
      sourceTurnId: "source-turn",
      authorizationRef: "authorization-1",
      resultScopeRef: "scope-1",
    });
    expect(dispatched[0]?.progressDestination).toEqual(source.progressDestination);
    const queueFiles = Array.from(new Bun.Glob("*.json").scanSync(join(root, "wake-outbox")));
    expect(queueFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, "wake-outbox", queueFiles[0]!), "utf8"))).toMatchObject({
      status: "delivered",
      sourceTurnId: "source-turn",
      authorizationRef: "authorization-1",
      resultScopeRef: "scope-1",
    });

    const replay = await host.reconcile([candidate]);
    expect(replay.dispatched).toBe(0);
    expect(dispatched).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted wake production rejects missing, mismatched, and raw-only authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-trusted-wake-reject-"));
  let dispatches = 0;
  const source = sourceTurn();
  try {
    const host = createBtccTrustedWakeProjectionHost({
      turns: {
        findTurn: async (turnId) => turnId === source.turnId ? source : null,
      },
      wakeAuthorizations: {
        validateWake() {
          return false;
        },
      },
      dispatch: async () => {
        dispatches += 1;
        return { kind: "delivered", turnId: "unexpected", messageId: "unexpected", content: "unexpected" };
      },
      queueDir: join(root, "wake-outbox"),
    });
    const result = await host.reconcile([
      { ...validCandidate(), authorizationRef: "" },
      { ...validCandidate(), taskId: "worker-missing-source", sourceTurnId: "missing-source" },
      { ...validCandidate(), taskId: "worker-wrong-session", originSessionId: "other-session" },
      { ...validCandidate(), taskId: "worker-unrecorded" },
    ]);
    expect(result.authorized).toBe(0);
    expect(result.rejected).toBe(4);
    expect(result.dispatched).toBe(0);
    expect(dispatches).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted wake rejects a tampered queued request on revalidation", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-trusted-wake-tamper-"));
  const source = sourceTurn();
  const facts = new Set(["source-turn\0authorization-1\0scope-1"]);
  let dispatches = 0;
  try {
    const host = createBtccTrustedWakeProjectionHost({
      turns: { findTurn: async (turnId) => turnId === source.turnId ? source : null },
      wakeAuthorizations: {
        validateWake(input) {
          return facts.has(factKey(input));
        },
      },
      dispatch: async (request) => {
        dispatches += 1;
        return { kind: "fenced_pending_persistence", turnId: request.turnId };
      },
      queueDir: join(root, "wake-outbox"),
    });

    const first = await host.reconcile([validCandidate()]);
    expect(first).toMatchObject({ authorized: 1, dispatched: 0, pending: 1 });
    const queueFiles = Array.from(new Bun.Glob("*.json").scanSync(join(root, "wake-outbox")));
    const queuePath = join(root, "wake-outbox", queueFiles[0]!);
    const queued = JSON.parse(readFileSync(queuePath, "utf8")) as {
      request: { trigger: { authorizationRef: string } };
    };
    queued.request.trigger.authorizationRef = "tampered-authorization";
    writeFileSync(queuePath, `${JSON.stringify(queued, null, 2)}\n`, "utf8");

    const second = await host.reconcile([]);
    expect(second).toMatchObject({ rejected: 1, dispatched: 0, pending: 0 });
    expect(dispatches).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function validCandidate(): BtccWakeCompletionCandidate {
  return {
    taskId: "worker-1",
    originSessionId: "session-source",
    sourceTurnId: "source-turn",
    authorizationRef: "authorization-1",
    resultScopeRef: "scope-1",
    resultText: "The trusted worker result is ready.",
  };
}

function sourceTurn(): TurnRecord {
  return {
    turnId: "source-turn",
    sessionId: "session-source",
    inboxId: "inbox-source",
    triggerKey: "trigger-source",
    originalMessageId: "message-source",
    originalMessage: "start worker",
    progressDestination: {
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      replyToMessageId: "message-source",
    },
    modelSelection: {
      provider: "fake",
      model: "fake",
      reasoningEffort: "none",
      controls: {},
      controlsHash: "fake",
    },
    context: {
      userRef: "user",
      projectRef: "project",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath: "/workspace",
      },
    },
    semanticState: "delivered",
    revision: 2,
    executionFence: 1,
    finalDisposition: "completed",
  };
}

function factKey(input: {
  sourceTurnId: string;
  authorizationRef: string;
  resultScopeRef?: string;
}): string {
  return [input.sourceTurnId, input.authorizationRef, input.resultScopeRef ?? ""].join("\0");
}
