import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cutoverLegacyBtccTurns,
  R2_ONLY_NONTERMINAL_TURN_STATES,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/legacy-turn-cutover/index.ts";
import { digest } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/identity.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";
import {
  createGuidedEffectService,
} from "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { createGuidedTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/guided-turn/index.ts";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/index.ts";
import type { EffectAdapter } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { seedLegacySessionWork } from
  "./support/btcc-r3-legacy-session-work-fixture.ts";
import {
  createLegacyR2BtccDatabase,
  installCutoverStorageFailure,
  installOneShotCutoverCasConflict,
  seedExistingCanonicalDelivery,
  seedLegacyR2Turn,
  seedPendingLegacyOperation,
} from "./support/btcc-r2-legacy-turn-cutover-fixture.ts";

const CUTOVER_AT = new Date("2026-07-31T02:03:04.000Z");
const ENGLISH_LIMITATION =
  "This request stopped in the previous BTCC runtime. I did not automatically repeat its tools or external effects. Send a new message to continue from the saved Work and verified results.";

test("real R2 nonterminal Turns settle through limitation delivery without model or effect replay", async () => {
  const fixture = createFixture("btcc-r3-cutover-known-");
  const legacy = createLegacyR2BtccDatabase(fixture.dbPath);
  const turnIds = R2_ONLY_NONTERMINAL_TURN_STATES.map((state, index) => {
    const turnId = `turn-${String(index).padStart(2, "0")}`;
    seedLegacyR2Turn(legacy, {
      turnId,
      semanticState: state,
      originalMessage: `Continue work from ${state}`,
    });
    return turnId;
  });
  legacy.close();

  const stores = openBtccSqliteStores({
    dbPath: fixture.dbPath,
    ownerId: "cutover-known-owner",
    storageProfile: "ephemeral",
  });
  let modelCalls = 0;
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run() {
        modelCalls += 1;
        return { route: "managed", content: "must not run" };
      },
    },
  });
  try {
    expect(stores.legacyCutover).toEqual({
      kind: "completed",
      convertedTurnIds: turnIds,
      replayedTurnIds: [],
      preservedTurnIds: [],
      quarantinedTurnIds: [],
      blockers: [],
      diagnostics: [],
    });
    for (const turnId of turnIds) {
      expect((await stores.turns.findTurn(turnId))?.semanticState)
        .toBe("delivery_committed");
      expect(await runtime.runTurn({ kind: "resume", turnId })).toMatchObject({
        kind: "delivered",
        turnId,
        content: ENGLISH_LIMITATION,
      });
    }
    expect(modelCalls).toBe(0);
  } finally {
    stores.close();
  }

  const settled = new Database(fixture.dbPath, { readonly: true });
  try {
    expect(count(settled, "btcc_r3_legacy_turn_cutovers")).toBe(turnIds.length);
    expect(countWhere(
      settled,
      "btcc_turns",
      "semantic_state = 'delivered'",
    )).toBe(turnIds.length);
    expect(countWhere(
      settled,
      "btcc_messages",
      "role = 'assistant'",
    )).toBe(turnIds.length);
    expect(count(settled, "btcc_guided_tool_calls")).toBe(0);
    expect(count(settled, "btcc_guided_effects")).toBe(0);
    expect(countWhere(
      settled,
      "btcc_checkpoints",
      "kind = 'phase' AND is_active = 1",
    )).toBe(0);
    expect(countWhere(
      settled,
      "btcc_checkpoints",
      "kind = 'runtime' AND semantic_state = 'delivery_committed'",
    )).toBe(turnIds.length);

    const stored = settled.query<{
      evidence_json: string;
      evidence_sha256: string;
    }, []>(`
      SELECT evidence_json, evidence_sha256
      FROM btcc_r3_legacy_turn_cutovers WHERE turn_id = 'turn-00'
    `).get()!;
    expect(stored.evidence_sha256).toBe(digest(stored.evidence_json));
    expect(JSON.parse(stored.evidence_json)).toMatchObject({
      schema: "btcc.r3.legacy-turn-cutover.v2",
      turnId: "turn-00",
      source: {
        semanticState: R2_ONLY_NONTERMINAL_TURN_STATES[0],
        turnRevision: 7,
        executionFence: 11,
        activeCheckpointId: "checkpoint-turn-00",
        activeCheckpointRevision: 3,
      },
      target: {
        semanticState: "delivery_committed",
        turnRevision: 8,
        executionFence: 12,
        checkpointRevision: 0,
        checkpointKind: "runtime",
      },
      safetyBlockers: [],
    });
  } finally {
    settled.close();
    fixture.cleanup();
  }
});

test("blockers and incompatible R2 rows settle visibly while startup and new admission continue", async () => {
  const fixture = createFixture("btcc-r3-cutover-diagnostics-");
  const legacy = createLegacyR2BtccDatabase(fixture.dbPath);
  seedLegacyR2Turn(legacy, {
    turnId: "turn-blocked",
    semanticState: "task_execution",
    originalMessage: "Publish the pending result",
  });
  seedPendingLegacyOperation(legacy, {
    turnId: "turn-blocked",
    requestId: "external-request",
    kind: "external_effect",
  });
  seedLegacyR2Turn(legacy, {
    turnId: "turn-existing-delivery",
    semanticState: "reporting",
    originalMessage: "Report the completed result",
  });
  seedExistingCanonicalDelivery(legacy, {
    turnId: "turn-existing-delivery",
    content: "The earlier result was already delivered.",
  });
  seedLegacyR2Turn(legacy, {
    turnId: "turn-unknown",
    semanticState: "future_runtime_state",
    originalMessage: "Continue an unknown state",
  });
  legacy.close();

  const stores = openBtccSqliteStores({
    dbPath: fixture.dbPath,
    ownerId: "cutover-diagnostic-owner",
    storageProfile: "ephemeral",
  });
  let modelCalls = 0;
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run() {
        modelCalls += 1;
        return { route: "managed", content: "must not run" };
      },
    },
  });
  try {
    expect(stores.legacyCutover).toEqual({
      kind: "completed",
      convertedTurnIds: ["turn-blocked"],
      replayedTurnIds: [],
      preservedTurnIds: [],
      quarantinedTurnIds: ["turn-existing-delivery", "turn-unknown"],
      blockers: [{
        turnId: "turn-blocked",
        kind: "pending_external_effect",
        referenceId: "external-request",
        detail: "A legacy external effect request has no committed result.",
      }],
      diagnostics: [
        {
          turnId: "turn-existing-delivery",
          code: "legacy_delivery_state_conflict",
          semanticState: "reporting",
          detail:
            "An R2-only Turn already owns delivery authority and requires isolated recovery.",
        },
        {
          turnId: "turn-unknown",
          code: "unknown_semantic_state",
          semanticState: "future_runtime_state",
          detail: "The Turn state is not a known R2 cutover or R3 preserved state.",
        },
      ],
    });

    expect(await runtime.runTurn({
      kind: "resume",
      turnId: "turn-blocked",
    })).toMatchObject({ kind: "delivered", content: ENGLISH_LIMITATION });
    expect(await runtime.runTurn({
      kind: "resume",
      turnId: "turn-unknown",
    })).toMatchObject({ kind: "delivered", content: ENGLISH_LIMITATION });
    expect(await runtime.runTurn({
      kind: "resume",
      turnId: "turn-existing-delivery",
    })).toMatchObject({
      kind: "delivered",
      content: "The earlier result was already delivered.",
    });
    expect(modelCalls).toBe(0);

    const command = freshRunCommand(fixture.root, "turn-fresh");
    const inbox = await stores.admission.recordInbound({
      command,
      admissionInputHash: "fresh-admission-hash",
    });
    const claim = await stores.admission.acquireAdmissionConstructionClaim(inbox);
    const fresh = await stores.admission.constructTurn(inbox, claim);
    expect(fresh).toMatchObject({
      turnId: "turn-fresh",
      semanticState: "admitted",
      revision: 0,
    });
  } finally {
    stores.close();
  }

  const settled = new Database(fixture.dbPath, { readonly: true });
  try {
    const evidence = JSON.parse(settled.query<{ evidence_json: string }, []>(`
      SELECT evidence_json FROM btcc_r3_legacy_turn_cutovers
      WHERE turn_id = 'turn-blocked'
    `).get()!.evidence_json);
    expect(evidence.safetyBlockers).toEqual([{
      turnId: "turn-blocked",
      kind: "pending_external_effect",
      referenceId: "external-request",
      detail: "A legacy external effect request has no committed result.",
    }]);
    const quarantines = settled.query<{
      turn_id: string;
      reason_json: string;
      reason_sha256: string;
    }, []>(`
      SELECT turn_id, reason_json, reason_sha256
      FROM btcc_r3_legacy_turn_quarantine ORDER BY turn_id
    `).all();
    expect(quarantines.map((row) => row.turn_id)).toEqual([
      "turn-existing-delivery",
      "turn-unknown",
    ]);
    for (const row of quarantines) {
      expect(row.reason_sha256).toBe(digest(row.reason_json));
    }
    expect(countWhere(
      settled,
      "btcc_messages",
      "role = 'assistant'",
    )).toBe(3);
    expect(count(settled, "btcc_guided_tool_calls")).toBe(0);
    expect(settled.query<{ pending_operation_json: string }, []>(`
      SELECT pending_operation_json FROM btcc_phase_checkpoint_revisions
      WHERE checkpoint_id = 'checkpoint-turn-blocked'
    `).get()?.pending_operation_json).toContain("external-request");
  } finally {
    settled.close();
    fixture.cleanup();
  }
});

test("an imported Work reconciles its exact R2 effect target before any R3 dispatch", async () => {
  const fixture = createFixture("btcc-r3-cutover-effect-blocker-");
  const legacy = createLegacyR2BtccDatabase(fixture.dbPath);
  seedLegacySessionWork(legacy);
  seedLegacyR2Turn(legacy, {
    turnId: "turn-effect-uncertain",
    sessionId: "session-fixture",
    semanticState: "task_execution",
    originalMessage: "Finish the interrupted exact-target effect",
  });
  legacy.query(`
    UPDATE btcc_turns SET managed_state_json = ?
    WHERE turn_id = 'turn-effect-uncertain'
  `).run(JSON.stringify({ programId: "program-session" }));
  seedPendingLegacyOperation(legacy, {
    turnId: "turn-effect-uncertain",
    requestId: "legacy-write-report",
    kind: "external_effect",
    capabilityRef: "workspace.file",
    targetScopeRef: "/private/report.md",
    occurrenceKey: "write-report-once",
    effectIntentRef: {
      id: "legacy-effect-intent",
      sha256: "legacy-effect-intent-sha256",
    },
    payload: { content: "alpha", format: "markdown" },
  });
  legacy.close();

  const stores = openBtccSqliteStores({
    dbPath: fixture.dbPath,
    ownerId: "cutover-effect-blocker-owner",
    storageProfile: "ephemeral",
  });
  try {
    expect(stores.legacyCutover.blockers).toEqual([{
      turnId: "turn-effect-uncertain",
      kind: "pending_external_effect",
      referenceId: "legacy-write-report",
      detail: "A legacy external effect request has no committed result.",
      capability: "workspace.file",
      target: "/private/report.md",
    }]);
    const command = freshRunCommand(
      fixture.root,
      "turn-effect-continuation",
      "session-fixture",
    );
    const inbox = await stores.admission.recordInbound({
      command,
      admissionInputHash: "effect-continuation-admission",
    });
    const claim = await stores.admission.acquireAdmissionConstructionClaim(inbox);
    await stores.admission.constructTurn(inbox, claim);
    const scope = {
      turnId: command.turnId,
      sessionId: command.sessionId,
    };
    const imported = await stores.durableWork.importOpenLegacyWork(scope);
    expect(imported?.work).toMatchObject({
      status: "blocked",
      effectBlockers: [{
        capability: "workspace.file",
        target: "/private/report.md",
        sourceTurnId: "turn-effect-uncertain",
      }],
    });
    const planned = await stores.durableWork.replacePlan({
      ...scope,
      mutationCallId: "continued-effect-plan",
      objective: "Finish the exact target safely",
      actions: [{
        actionKey: "write-report",
        description: "Write the report once",
        dependencyKeys: [],
        effect: {
          capability: "workspace.file",
          target: "/private/report.md",
        },
      }, {
        actionKey: "write-other",
        description: "Write an unrelated target",
        dependencyKeys: [],
        effect: {
          capability: "workspace.file",
          target: "/private/other.md",
        },
      }, {
        actionKey: "publish-report",
        description: "Publish the same target through another capability",
        dependencyKeys: [],
        effect: {
          capability: "repository.publish",
          target: "/private/report.md",
        },
      }],
      checks: ["The exact target is observed."],
    });
    const reviewed = await stores.durableWork.recordReview({
      ...scope,
      mutationCallId: "continued-effect-plan-review",
      subject: "plan",
      verdict: "accept",
      summary: "The exact target is correct.",
      corrections: [],
    });
    expect(planned.status).toBe("blocked");
    expect(reviewed.status).toBe("blocked");

    const legacyIdempotencyKey =
      "legacy-effect-intent:legacy-effect-intent-sha256:write-report-once";
    const observedResult: {
      target: string;
      payload: Record<string, unknown>;
    } = {
      target: "/private/report.md",
      payload: { content: "alpha", format: "markdown" },
    };
    let dispatchCalls = 0;
    const reconcileKeys: string[] = [];
    let legacyReconciliation: "uncertain" | "applied" = "uncertain";
    const adapter: EffectAdapter<Record<string, unknown>, typeof observedResult> = {
      capability: "workspace.file",
      normalizeTarget: normalizeFixtureTarget,
      sanitizeTarget: normalizeFixtureTarget,
      normalizeInput(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("effect input must be an object");
        }
        return value as Record<string, unknown>;
      },
      async dispatch(input) {
        dispatchCalls += 1;
        return {
          status: "applied",
          result: {
            target: input.normalizedTarget,
            payload: input.normalizedInput,
          },
        };
      },
      async reconcile(input) {
        if (input.idempotencyKey !== legacyIdempotencyKey) {
          return { status: "not_applied" };
        }
        reconcileKeys.push(input.idempotencyKey);
        return legacyReconciliation === "applied"
          ? { status: "applied", result: observedResult }
          : {
              status: "uncertain",
              error: {
                code: "target_observation_inconclusive",
                message: "The target cannot yet prove the prior outcome.",
              },
            };
      },
    };
    const service = createGuidedEffectService(
      stores.guidedEffectJournal,
    );
    const request = {
      work: reviewed,
      accessMode: "full_access" as const,
      signal: new AbortController().signal,
      target: "/private/report.md",
      input: { format: "markdown", content: "alpha" },
      adapter,
    };
    expect(await service.execute({
      ...request,
      target: "/private/other.md",
      input: { content: "unrelated" },
    })).toMatchObject({
      ok: true,
      status: "applied",
      result: { target: "/private/other.md" },
    });
    expect(dispatchCalls).toBe(1);

    const publishAdapter = {
      ...adapter,
      capability: "repository.publish",
    };
    expect(await service.execute({
      ...request,
      adapter: publishAdapter,
    })).toMatchObject({
      ok: true,
      status: "applied",
      result: { target: "/private/report.md" },
    });
    expect(dispatchCalls).toBe(2);

    expect(await service.execute(request)).toMatchObject({
      ok: false,
      status: "uncertain",
      error: { code: "effect_reconciliation_required" },
    });
    expect(dispatchCalls).toBe(2);
    expect((await stores.durableWork.boundWorkForTurn(scope.turnId))
      ?.effectBlockers).toHaveLength(1);

    legacyReconciliation = "applied";
    let crashAfterReceipt = true;
    const crashingService = createGuidedEffectService(
      stores.guidedEffectJournal,
      {
        faultHook(point) {
          if (crashAfterReceipt && point === "after_receipt") {
            crashAfterReceipt = false;
            throw new Error("crash after adopted legacy receipt");
          }
        },
      },
    );
    await expect(crashingService.execute(request))
      .rejects.toThrow("crash after adopted legacy receipt");
    expect(dispatchCalls).toBe(2);
    expect(await stores.durableWork.boundWorkForTurn(scope.turnId))
      .toMatchObject({ status: "open" });
    expect((await stores.durableWork.boundWorkForTurn(scope.turnId))
      ?.effectBlockers).toBeUndefined();

    const outcome = await service.execute(request);
    expect(outcome).toMatchObject({
      ok: true,
      status: "applied",
      replayed: true,
      result: observedResult,
    });
    expect(dispatchCalls).toBe(2);
    expect(reconcileKeys).toEqual([
      legacyIdempotencyKey,
      legacyIdempotencyKey,
    ]);
    expect(await stores.durableWork.boundWorkForTurn(scope.turnId))
      .toMatchObject({ status: "open" });
    expect((await stores.durableWork.boundWorkForTurn(scope.turnId))
      ?.effectBlockers).toBeUndefined();
  } finally {
    stores.close();
    fixture.cleanup();
  }
});

test("starting unrelated Work leaves a legacy effect blocker on its imported Work", async () => {
  const fixture = createFixture("btcc-r3-cutover-effect-binding-");
  const legacy = createLegacyR2BtccDatabase(fixture.dbPath);
  seedLegacySessionWork(legacy);
  seedLegacyR2Turn(legacy, {
    turnId: "turn-effect-source",
    sessionId: "session-fixture",
    semanticState: "task_execution",
    originalMessage: "Finish the interrupted legacy effect",
  });
  legacy.query(`
    UPDATE btcc_turns SET managed_state_json = ?
    WHERE turn_id = 'turn-effect-source'
  `).run(JSON.stringify({ programId: "program-session" }));
  seedPendingLegacyOperation(legacy, {
    turnId: "turn-effect-source",
    requestId: "legacy-write-report",
    kind: "external_effect",
    capabilityRef: "workspace.file",
    targetScopeRef: "/private/legacy-report.md",
    occurrenceKey: "legacy-write-once",
    effectIntentRef: {
      id: "legacy-effect-intent",
      sha256: "legacy-effect-intent-sha256",
    },
    payload: { content: "legacy" },
  });
  legacy.close();

  const stores = openBtccSqliteStores({
    dbPath: fixture.dbPath,
    ownerId: "cutover-effect-binding-owner",
    storageProfile: "ephemeral",
  });
  try {
    const continuation = freshRunCommand(
      fixture.root,
      "turn-import-legacy-work",
      "session-fixture",
    );
    const continuationInbox = await stores.admission.recordInbound({
      command: continuation,
      admissionInputHash: "legacy-work-import-admission",
    });
    const continuationClaim = await stores.admission
      .acquireAdmissionConstructionClaim(continuationInbox);
    await stores.admission.constructTurn(continuationInbox, continuationClaim);
    const scope = {
      turnId: continuation.turnId,
      sessionId: continuation.sessionId,
    };
    const imported = await stores.durableWork.importOpenLegacyWork(scope);
    const importedWorkId = imported?.work.workId ?? "";
    expect(imported?.work).toMatchObject({
      workId: importedWorkId,
      status: "blocked",
      effectBlockers: [{
        sourceTurnId: "turn-effect-source",
        capability: "workspace.file",
        target: "/private/legacy-report.md",
      }],
    });

    const unrelated = await stores.durableWork.replacePlan({
      ...scope,
      mutationCallId: "start-unrelated-work",
      startNew: true,
      objective: "Create an unrelated local note",
      actions: [{
        actionKey: "write-note",
        description: "Write a different local note",
        dependencyKeys: [],
        effect: {
          capability: "workspace.file",
          target: "/private/unrelated-note.md",
        },
      }],
      checks: ["The unrelated note exists."],
    });
    expect(unrelated).toMatchObject({
      status: "open",
      objective: "Create an unrelated local note",
    });
    expect(unrelated.effectBlockers).toBeUndefined();
    expect(unrelated.workId).not.toBe(importedWorkId);

    const audit = new Database(fixture.dbPath, { readonly: true });
    try {
      const blocker = audit.query<{
        work_id: string | null;
      }, []>(`
        SELECT work_id FROM btcc_guided_work_effect_blockers
        WHERE source_turn_id = 'turn-effect-source'
      `).get();
      expect(blocker?.work_id).toBe(importedWorkId);
      expect(audit.query<{ status: string }, [string]>(`
        SELECT status FROM btcc_guided_works WHERE work_id = ?
      `).get(importedWorkId)?.status).toBe("abandoned");
    } finally {
      audit.close();
    }

    const answerCommand = freshRunCommand(
      fixture.root,
      "turn-independent-answer",
      "session-fixture",
    );
    const answerInbox = await stores.admission.recordInbound({
      command: answerCommand,
      admissionInputHash: "independent-answer-admission",
    });
    const answerClaim = await stores.admission
      .acquireAdmissionConstructionClaim(answerInbox);
    await stores.admission.constructTurn(answerInbox, answerClaim);
    const runtime = createGuidedTurnRuntime({
      admission: stores.admission,
      turns: stores.turns,
      messages: stores.messages,
      agent: {
        async run() {
          return {
            route: "direct",
            content: "The unrelated answer is available.",
          };
        },
      },
    });
    expect(await runtime.runTurn({
      kind: "resume",
      turnId: answerCommand.turnId,
    })).toMatchObject({
      kind: "delivered",
      content: "The unrelated answer is available.",
    });
  } finally {
    stores.close();
    fixture.cleanup();
  }
});

test("fresh R3 Turns remain byte-stable and legacy replay is idempotent", async () => {
  const fixture = createFixture("btcc-r3-cutover-replay-");
  const legacy = createLegacyR2BtccDatabase(fixture.dbPath);
  seedLegacyR2Turn(legacy, {
    turnId: "turn-legacy",
    semanticState: "planning",
  });
  legacy.close();

  const first = openBtccSqliteStores({
    dbPath: fixture.dbPath,
    ownerId: "cutover-replay-first",
    storageProfile: "ephemeral",
  });
  try {
    expect(first.legacyCutover.convertedTurnIds).toEqual(["turn-legacy"]);
    const command = freshRunCommand(fixture.root, "turn-fresh");
    const inbox = await first.admission.recordInbound({
      command,
      admissionInputHash: "fresh-replay-hash",
    });
    const claim = await first.admission.acquireAdmissionConstructionClaim(inbox);
    expect(await first.admission.constructTurn(inbox, claim)).toMatchObject({
      turnId: "turn-fresh",
      semanticState: "admitted",
    });
  } finally {
    first.close();
  }
  const freshBefore = selectTurn(fixture.dbPath, "turn-fresh");

  for (const ownerId of [
    "cutover-replay-second",
    "cutover-replay-third",
  ]) {
    const reopened = openBtccSqliteStores({
      dbPath: fixture.dbPath,
      ownerId,
      storageProfile: "ephemeral",
    });
    try {
      expect(reopened.legacyCutover).toEqual({
        kind: "completed",
        convertedTurnIds: [],
        replayedTurnIds: ["turn-legacy"],
        preservedTurnIds: ["turn-fresh"],
        quarantinedTurnIds: [],
        blockers: [],
        diagnostics: [],
      });
      expect(await reopened.turns.findTurn("turn-fresh")).toMatchObject({
        semanticState: "admitted",
        revision: 0,
      });
    } finally {
      reopened.close();
    }
    expect(selectTurn(fixture.dbPath, "turn-fresh")).toEqual(freshBefore);
  }

  const replayed = new Database(fixture.dbPath, { readonly: true });
  try {
    expect(count(replayed, "btcc_r3_legacy_turn_cutovers")).toBe(1);
    expect(countWhere(
      replayed,
      "btcc_delivery_outbox",
      "turn_id = 'turn-legacy'",
    )).toBe(1);
    expect(count(replayed, "btcc_r3_legacy_turn_quarantine")).toBe(0);
  } finally {
    replayed.close();
    fixture.cleanup();
  }
});

test("a storage failure rolls back every cutover write after real R2 migration", () => {
  const fixture = createFixture("btcc-r3-cutover-failure-");
  const legacy = createLegacyR2BtccDatabase(fixture.dbPath);
  seedLegacyR2Turn(legacy, {
    turnId: "turn-a",
    semanticState: "planning",
  });
  seedLegacyR2Turn(legacy, {
    turnId: "turn-b",
    semanticState: "reporting",
  });
  installCutoverStorageFailure(legacy, "turn-b");
  legacy.close();

  const migrated = new Database(fixture.dbPath);
  try {
    migrated.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(migrated);
    expect(() => cutoverLegacyBtccTurns(migrated, { now: CUTOVER_AT }))
      .toThrow("synthetic cutover storage failure");
    expect(migrated.query<{
      turn_id: string;
      semantic_state: string;
      revision: number;
      execution_fence: number;
    }, []>(`
      SELECT turn_id, semantic_state, revision, execution_fence
      FROM btcc_turns ORDER BY turn_id
    `).all()).toEqual([
      {
        turn_id: "turn-a",
        semantic_state: "planning",
        revision: 7,
        execution_fence: 11,
      },
      {
        turn_id: "turn-b",
        semantic_state: "reporting",
        revision: 7,
        execution_fence: 11,
      },
    ]);
    expect(count(migrated, "btcc_r3_legacy_turn_cutovers")).toBe(0);
    expect(count(migrated, "btcc_r3_legacy_turn_quarantine")).toBe(0);
    expect(count(migrated, "btcc_delivery_outbox")).toBe(0);
    expect(countWhere(
      migrated,
      "btcc_records",
      "kind = 'final_payload'",
    )).toBe(0);
    expect(countWhere(
      migrated,
      "btcc_checkpoints",
      "kind = 'phase' AND is_active = 1",
    )).toBe(2);
    expect(countWhere(
      migrated,
      "btcc_checkpoints",
      "kind = 'runtime'",
    )).toBe(0);
  } finally {
    migrated.close();
    fixture.cleanup();
  }
});

test("a CAS conflict rolls back partial conversion before atomic quarantine settlement", async () => {
  const fixture = createFixture("btcc-r3-cutover-cas-");
  const legacy = createLegacyR2BtccDatabase(fixture.dbPath);
  seedLegacyR2Turn(legacy, {
    turnId: "turn-a-safe",
    semanticState: "planning",
  });
  seedLegacyR2Turn(legacy, {
    turnId: "turn-z-cas",
    semanticState: "reporting",
  });
  installOneShotCutoverCasConflict(legacy, "turn-z-cas");
  legacy.close();

  const stores = openBtccSqliteStores({
    dbPath: fixture.dbPath,
    ownerId: "cutover-cas-owner",
    storageProfile: "ephemeral",
  });
  let modelCalls = 0;
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    agent: {
      async run() {
        modelCalls += 1;
        return { route: "managed", content: "must not run" };
      },
    },
  });
  try {
    expect(stores.legacyCutover).toEqual({
      kind: "completed",
      convertedTurnIds: [],
      replayedTurnIds: [],
      preservedTurnIds: [],
      quarantinedTurnIds: ["turn-a-safe", "turn-z-cas"],
      blockers: [],
      diagnostics: [
        {
          turnId: "turn-a-safe",
          code: "cutover_cas_conflict",
          semanticState: "planning",
          detail:
            "Legacy Turn settlement was quarantined after a concurrent cutover conflict.",
        },
        {
          turnId: "turn-z-cas",
          code: "cutover_cas_conflict",
          semanticState: "reporting",
          detail: "Legacy Turn cutover lost its exact CAS: turn-z-cas",
        },
      ],
    });
    for (const turnId of ["turn-a-safe", "turn-z-cas"]) {
      expect(await runtime.runTurn({ kind: "resume", turnId })).toMatchObject({
        kind: "delivered",
        content: ENGLISH_LIMITATION,
      });
    }
    expect(modelCalls).toBe(0);
  } finally {
    stores.close();
  }

  const settled = new Database(fixture.dbPath, { readonly: true });
  try {
    expect(count(settled, "btcc_r3_legacy_turn_cutovers")).toBe(0);
    expect(count(settled, "btcc_r3_legacy_turn_quarantine")).toBe(2);
    expect(count(settled, "btcc_delivery_outbox")).toBe(2);
    expect(countWhere(
      settled,
      "btcc_records",
      "kind = 'final_payload'",
    )).toBe(2);
    expect(countWhere(
      settled,
      "btcc_checkpoints",
      "kind = 'phase' AND is_active = 1",
    )).toBe(0);
    expect(countWhere(
      settled,
      "btcc_checkpoints",
      "kind = 'runtime' AND semantic_state = 'delivery_committed'",
    )).toBe(2);
  } finally {
    settled.close();
    fixture.cleanup();
  }
});

function createFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    dbPath: join(root, "btcc.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function freshRunCommand(
  root: string,
  turnId: string,
  sessionId = "fresh-session",
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId,
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "Start a fresh R3 request",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "fresh-controls",
    },
    context: {
      userRef: "local-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${root}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath: root,
      },
    },
  };
}

function selectTurn(
  dbPath: string,
  turnId: string,
): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query<Record<string, unknown>, [string]>(`
      SELECT * FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    if (!row) throw new Error(`Turn is missing: ${turnId}`);
    return row;
  } finally {
    db.close();
  }
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

function countWhere(
  db: Database,
  table: string,
  condition: string,
): number {
  return (db.query(`
    SELECT COUNT(*) AS count FROM ${table} WHERE ${condition}
  `).get() as { count: number }).count;
}

function normalizeFixtureTarget(value: string): string {
  return `/${value.trim().replace(/^\.?\/*/u, "").replace(/\/+/gu, "/")}`;
}
