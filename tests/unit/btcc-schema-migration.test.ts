import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { admitTurn } from
  "../../packages/butler-agent/src/agent/btcc/turn/admission/admit-turn.ts";
import type { BtccRunCommand } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";

test("opening an existing R3 database migrates Work columns and anchors idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-schema-migration-"));
  const dbPath = join(root, "btcc.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(
    BTCC_SUCCESSOR_SCHEMA.replace(
      "  source_authority TEXT NOT NULL CHECK (\n" +
      "    source_authority IN ('session_sqlite', 'project_ledger')\n" +
      "  ),\n  source_revision TEXT NOT NULL,\n",
      "",
    )
      .replace("  governing_refs_json TEXT NOT NULL,\n", "")
      .replace("  plan_revision_id TEXT NOT NULL,\n", "")
      .replace("  action_states_json TEXT NOT NULL,\n", ""),
  );
  for (const [turnId, message] of [
    ["turn-migration-origin", "Build the original requested report"],
    ["turn-migration-resume", "Continue the report"],
  ]) {
    legacy.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, revision, execution_fence
      ) VALUES (?, 'session-migration', ?, ?, ?, ?, 'snapshot', '{}', '{}',
        'admitted', 1, 1)
    `).run(
      turnId,
      `inbox-${turnId}`,
      `trigger-${turnId}`,
      `message-${turnId}`,
      message,
    );
  }
  legacy.query(`
    INSERT INTO btcc_guided_works (
      work_id, session_id, scope_kind, scope_ref, origin_turn_id,
      origin_message_id, objective, status, current_plan_revision_id,
      created_at, updated_at
    ) VALUES (
      'work-migration', 'session-migration', 'session', 'session-migration',
      'turn-migration-origin', 'message-turn-migration-origin',
      'drifted later objective', 'open', 'plan-migration-2',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:03:00.000Z'
    )
  `).run();
  legacy.query(`
    INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at)
    VALUES ('session-migration', 'work-migration', '2026-08-01T00:03:00.000Z')
  `).run();
  legacy.query(`
    INSERT INTO btcc_guided_work_plan_revisions (
      plan_revision_id, work_id, revision, objective, actions_json, checks_json,
      origin_turn_id, created_at
    ) VALUES
      ('plan-migration-1', 'work-migration', 1, 'original stable objective',
        '[{"actionKey":"old-action","description":"Old action","dependencyKeys":[]}]',
        '[]', 'turn-migration-origin', '2026-08-01T00:00:00.000Z'),
      ('plan-migration-2', 'work-migration', 2, 'drifted later objective',
        '[{"actionKey":"new-action","description":"New action","dependencyKeys":[]}]',
        '[]', 'turn-migration-origin', '2026-08-01T00:02:00.000Z')
  `).run();
  legacy.query(`
    INSERT INTO btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id, work_id, revision, stage, public_summary,
      next_step, result_sequence, origin_turn_id, created_at
    ) VALUES (
      'checkpoint-migration-1', 'work-migration', 1, 'execution',
      'Old Plan execution', 'Replace the Plan', 0, 'turn-migration-origin',
      '2026-08-01T00:01:00.000Z'
    )
  `).run();
  legacy.close();

  const first = openBtccSqliteStores({ dbPath, ownerId: "migration-owner-1" });
  expect(await first.durableWork.bindOpenWork({
    turnId: "turn-migration-resume",
    sessionId: "session-migration",
  })).toMatchObject({
    objective: "original stable objective",
    currentStage: "planning",
    allowedNextStages: ["review"],
    actionProgress: [{ actionKey: "new-action", status: "pending" }],
    currentPlan: { planRevisionId: "plan-migration-2" },
  });
  first.close();
  const second = openBtccSqliteStores({ dbPath, ownerId: "migration-owner-2" });
  second.close();

  const migrated = new Database(dbPath);
  const importColumns = migrated.query<{
    name: string;
    notnull: number;
    dflt_value: string;
  }, []>("PRAGMA table_info(btcc_guided_work_legacy_imports)").all();
  expect(importColumns.find((column) => column.name === "source_authority"))
    .toMatchObject({ notnull: 1, dflt_value: "'session_sqlite'" });
  expect(importColumns.find((column) => column.name === "source_revision"))
    .toMatchObject({ notnull: 1, dflt_value: "'unknown'" });
  const planColumns = migrated.query<{
    name: string;
    notnull: number;
    dflt_value: string;
  }, []>("PRAGMA table_info(btcc_guided_work_plan_revisions)").all();
  expect(planColumns.find((column) => column.name === "governing_refs_json"))
    .toMatchObject({ notnull: 1, dflt_value: "'[]'" });
  const checkpointColumns = migrated.query<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }, []>("PRAGMA table_info(btcc_guided_work_checkpoint_revisions)").all();
  expect(checkpointColumns.find((column) => column.name === "plan_revision_id"))
    .toMatchObject({ notnull: 0, dflt_value: null });
  expect(checkpointColumns.find((column) => column.name === "action_states_json"))
    .toMatchObject({ notnull: 1, dflt_value: "'[]'" });
  migrated.close();
  rmSync(root, { recursive: true, force: true });
});

test("BTCC progress and wake facts keep stable identities across SQLite reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-lifecycle-facts-"));
  const dbPath = join(root, "btcc.sqlite");
  const destination = {
    transport: "app",
    accountId: "local",
    peer: { kind: "dm" as const, id: "general" },
    replyToMessageId: "message-facts",
  };
  let startedEventId = "";
  let startedActionId = "";
  const first = openBtccSqliteStores({
    dbPath,
    ownerId: "lifecycle-facts-1",
    storageProfile: "ephemeral",
  });
  try {
    const started = first.progressEvents.append({
      sessionId: "session-facts",
      turnId: "turn-facts",
      destination,
      event: { kind: "turn.started", createdAt: "2026-08-03T00:00:00.000Z" },
    });
    const replayedStarted = first.progressEvents.append({
      sessionId: "session-facts",
      turnId: "turn-facts",
      destination,
      event: { kind: "turn.started", createdAt: "2026-08-03T00:02:00.000Z" },
    });
    const note = first.progressEvents.append({
      sessionId: "session-facts",
      turnId: "turn-facts",
      destination,
      event: {
        kind: "assistant.public_note",
        payload: { note: "stable" },
      },
    });
    startedEventId = started.eventId;
    startedActionId = started.actionId;
    expect(replayedStarted).toMatchObject({
      eventId: started.eventId,
      actionId: started.actionId,
      turnSequence: started.turnSequence,
    });
    expect(note.turnSequence).toBe(started.turnSequence + 1);
    expect(first.progressEvents.pending("turn-facts").map((event) => event.eventId))
      .toEqual([started.eventId, note.eventId]);
  } finally {
    first.close();
  }

  const reopened = openBtccSqliteStores({
    dbPath,
    ownerId: "lifecycle-facts-2",
    storageProfile: "ephemeral",
  });
  try {
    const pending = reopened.progressEvents.pending("turn-facts");
    expect(pending).toHaveLength(2);
    expect(pending.map((event) => event.eventId)).toContain(startedEventId);
    expect(pending.map((event) => event.actionId)).toContain(startedActionId);
    reopened.wakeAuthorizations.recordAuthorization({
      sourceTurnId: "source-facts",
      authorizationRef: "authorization-facts",
      resultScopeRef: "scope-facts",
    });
    expect(reopened.wakeAuthorizations.validateWake({
      sourceTurnId: "source-facts",
      authorizationRef: "authorization-facts",
      resultScopeRef: "scope-facts",
    })).toBe(true);
    expect(reopened.wakeAuthorizations.validateWake({
      sourceTurnId: "source-facts",
      authorizationRef: "authorization-facts",
      resultScopeRef: "scope-other",
    })).toBe(false);
    expect(reopened.wakeAuthorizations.validateWake({
      sourceTurnId: "source-other",
      authorizationRef: "authorization-facts",
      resultScopeRef: "scope-facts",
    })).toBe(false);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite admission persists the exact authorized wake identity for replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-wake-facts-"));
  const dbPath = join(root, "btcc.sqlite");
  const command: Extract<BtccRunCommand, { kind: "wake" }> = {
    kind: "wake",
    turnId: "turn-wake-fact",
    sessionId: "session-wake-fact",
    triggerKey: "event-wake-fact",
    trigger: {
      triggerId: "trigger-wake-fact",
      sourceTurnId: "source-wake-fact",
      authorizationRef: "authorization-wake-fact",
      resultScopeRef: "scope-wake-fact",
      content: "use the authorized worker result",
    },
    modelSelection: {
      provider: "fake",
      model: "fake",
      reasoningEffort: "none",
      controls: {},
      controlsHash: "wake-fact-controls",
    },
    context: {
      userRef: "wake-fact-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["scope-wake-fact"],
    },
  };
  const first = openBtccSqliteStores({
    dbPath,
    ownerId: "wake-facts-1",
    storageProfile: "ephemeral",
  });
  try {
    await admitTurn(command, first.admission, first.turns);
  } finally {
    first.close();
  }
  const reopened = openBtccSqliteStores({
    dbPath,
    ownerId: "wake-facts-2",
    storageProfile: "ephemeral",
  });
  try {
    expect(await reopened.turns.findTurn(command.turnId)).toMatchObject({
      wakeIdentity: {
        triggerId: command.trigger.triggerId,
        sourceTurnId: command.trigger.sourceTurnId,
        authorizationRef: command.trigger.authorizationRef,
        resultScopeRef: command.trigger.resultScopeRef,
      },
    });
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
