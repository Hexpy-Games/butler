import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTurnExecutionControls,
  verifyTurnExecutionControls,
  type TurnControlResolution,
} from "../../packages/butler-agent/src/gateways/core/turn-execution-controls.ts";
import { createAppInboundEnvelope } from "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import {
  migrateAppStoreSchema,
  seedAppStoreDefaults,
} from "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { AppTurnRecordStore } from "../../packages/butler-agent/src/gateways/app/domain/sessions/turn-record-store.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { buildModelRoute } from
  "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { createTurnRuntime } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";

const resolution: TurnControlResolution = {
  controls: {
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "medium",
    access_mode: "full_access",
    plan_mode: false,
  },
  source: "session_override",
  sessionControlRevision: 7,
  catalogGeneration: "catalog-generation-a",
};

describe("immutable turn execution controls", () => {
  test("persists and projects the exact admission snapshot", () => {
    const db = new Database(":memory:");
    migrateAppStoreSchema(db);
    seedAppStoreDefaults(db);
    const turns = new AppTurnRecordStore(db, () => false);

    const turn = turns.insertTurn(
      "general",
      "accepted",
      "Accepted",
      resolution,
    );
    const persisted = db
      .query<{ execution_controls_json: string }, [string]>(
        "SELECT execution_controls_json FROM turns WHERE id = ?",
      )
      .get(turn.id);

    expect(turn.execution_controls).toMatchObject({
      turn_id: turn.id,
      session_id: "general",
      model_ref: "openai/gpt-5.6-sol",
      reasoning_effort: "medium",
      session_control_revision: 7,
      catalog_generation: "catalog-generation-a",
    });
    expect(
      verifyTurnExecutionControls(JSON.parse(persisted!.execution_controls_json)),
    ).toEqual(turn.execution_controls!);
    expect(turn.execution_model).toBeUndefined();
    db.close();
  });

  test("carries the verified snapshot through the app envelope", () => {
    const controls = createTurnExecutionControls({
      turnId: "turn-a",
      sessionId: "general",
      resolution,
      resolvedAt: "2026-07-14T00:00:00.000Z",
    });
    const envelope = createAppInboundEnvelope({
      chatId: "general",
      messageId: "message-a",
      turnId: "turn-a",
      text: "continue",
      timestamp: "2026-07-14T00:00:00.000Z",
      sessionId: "general",
      executionControls: controls,
    });

    expect(envelope.executionControls).toEqual(controls);
    expect(envelope.executionControls).not.toBe(controls);
  });

  test("does not project a provider identity observed before response acceptance", async () => {
    const fixture = createExecutionModelProjectionFixture();
    const runtime = createTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      agent: {
        async run({ onProviderResponseIdentity }) {
          onProviderResponseIdentity?.(providerIdentity);
          return { route: "direct" as const, content: "accepted later" };
        },
      },
    });
    try {
      await runtime.runTurn(fixture.command);
      expect(readExecutionModel(fixture.dbPath, fixture.turnId)).toBeNull();
      expect(readAcceptanceCount(fixture.dbPath, fixture.turnId)).toBe(0);
    } finally {
      fixture.stores.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("atomically projects the canonical accepted identity and preserves it after restart", async () => {
    const fixture = createExecutionModelProjectionFixture();
    const runtime = createTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      agent: {
        async run({ recordModelRoundAcceptance }) {
          await recordModelRoundAcceptance?.({
            roundId: "projection-round",
            candidateIndex: 0,
            transportAttempt: 1,
            modelRef: "openai/gpt-5.6-sol",
            result: {
              text: "accepted answer",
              toolCalls: [],
              providerIdentity,
            },
          });
          return { route: "direct" as const, content: "accepted answer" };
        },
      },
    });
    try {
      await runtime.runTurn(fixture.command);
      expect(readAcceptanceCount(fixture.dbPath, fixture.turnId)).toBe(1);
      expect(readExecutionModel(fixture.dbPath, fixture.turnId)).toEqual({
        requested_model_ref: "openai/gpt-5.6-sol",
        adapter_effective_model_ref: "openai/gpt-5.6-sol",
        provider_reported_model_ref: "openai/gpt-5.6-sol-served",
      });
    } finally {
      fixture.stores.close();
    }
    const restartedStores = openBtccSqliteStores({
      dbPath: fixture.dbPath,
      ownerId: `execution-model-restart-${crypto.randomUUID()}`,
      storageProfile: "ephemeral",
    });
    try {
      expect(readExecutionModel(fixture.dbPath, fixture.turnId)).toEqual({
        requested_model_ref: "openai/gpt-5.6-sol",
        adapter_effective_model_ref: "openai/gpt-5.6-sol",
        provider_reported_model_ref: "openai/gpt-5.6-sol-served",
      });
    } finally {
      restartedStores.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rolls back accepted response and App projection when projection fails", async () => {
    const fixture = createExecutionModelProjectionFixture({ failProjection: true });
    const runtime = createTurnRuntime({
      admission: fixture.stores.admission,
      turns: fixture.stores.turns,
      messages: fixture.stores.messages,
      agent: {
        async run({ recordModelRoundAcceptance }) {
          await recordModelRoundAcceptance?.({
            roundId: "projection-failure-round",
            candidateIndex: 0,
            transportAttempt: 1,
            modelRef: "openai/gpt-5.6-sol",
            result: {
              text: "must roll back",
              toolCalls: [],
              providerIdentity,
            },
          });
          return { route: "direct" as const, content: "unreachable" };
        },
      },
    });
    try {
      await expect(runtime.runTurn(fixture.command)).rejects.toMatchObject({
        code: "model_route_durability_failure",
      });
      expect(readAcceptanceCount(fixture.dbPath, fixture.turnId)).toBe(0);
      expect(readExecutionModel(fixture.dbPath, fixture.turnId)).toBeNull();
    } finally {
      fixture.stores.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("round-trips the snapshot through the durable inbound queue", () => {
    const butlerData = mkdtempSync(join(tmpdir(), "butler-turn-controls-"));
    try {
      const controls = createTurnExecutionControls({
        turnId: "turn-queue",
        sessionId: "general",
        resolution,
      });
      const envelope = createAppInboundEnvelope({
        chatId: "general",
        messageId: "message-queue",
        turnId: "turn-queue",
        text: "queue this",
        timestamp: "2026-07-14T00:00:00.000Z",
        sessionId: "butler/app-general",
        executionControls: controls,
      });
      const queue = new NativeInboundQueue(butlerData);

      queue.enqueue(envelope);
      const [claimed] = queue.claim(1);

      expect(claimed?.envelope.executionControls).toEqual(controls);
      expect(
        verifyTurnExecutionControls(claimed?.envelope.executionControls),
      ).toEqual(controls);
    } finally {
      rmSync(butlerData, { recursive: true, force: true });
    }
  });

  test("rejects mutated snapshots instead of silently changing execution", () => {
    const controls = createTurnExecutionControls({
      turnId: "turn-a",
      sessionId: "general",
      resolution,
    });
    const mutated = {
      ...controls,
      model_ref: "openai/gpt-5.5" as const,
    };

    expect(() => verifyTurnExecutionControls(mutated)).toThrow(
      "turn_execution_controls_integrity_mismatch",
    );
  });
});

const providerIdentity = {
  provider: "openai",
  configuredModel: "openai/gpt-5.6-sol",
  reportedModel: "gpt-5.6-sol-served",
};

function createExecutionModelProjectionFixture(options?: { failProjection?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "butler-execution-model-"));
  const dbPath = join(root, "app.sqlite");
  const appDb = new Database(dbPath);
  migrateAppStoreSchema(appDb);
  seedAppStoreDefaults(appDb);
  const appTurns = new AppTurnRecordStore(appDb, () => false);
  const turn = appTurns.insertTurn("general", "thinking", "Working", resolution);
  if (options?.failProjection) {
    appDb.exec(`
      CREATE TRIGGER fail_execution_model_projection
      BEFORE UPDATE OF execution_model_json ON turns
      BEGIN
        SELECT RAISE(ABORT, 'execution_model_projection_failure');
      END;
    `);
  }
  appDb.close();

  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: `execution-model-${crypto.randomUUID()}`,
    storageProfile: "ephemeral",
  });
  const modelRoute = buildModelRoute({
    primaryModelRef: "openai/gpt-5.6-sol",
    reasoningEffort: "medium",
    catalogGeneration: "execution-model-catalog",
  });
  return {
    root,
    dbPath,
    stores,
    turnId: turn.id,
    command: {
      kind: "run" as const,
      turnId: turn.id,
      sessionId: "general",
      triggerKey: `message:${turn.id}`,
      message: { messageId: `message:${turn.id}`, content: "hello" },
      modelSelection: {
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium" as const,
        controls: {},
        controlsHash: `controls:${turn.id}`,
        modelRoute,
      },
      context: {
        userRef: "local-user",
        profileRefs: [],
        recentFeedbackRefs: [],
        mandatoryHotCacheRefs: [],
        optionalHotCacheRefs: [],
        baselineObservationScopeRefs: [],
      },
    },
  };
}

function readExecutionModel(dbPath: string, turnId: string): Record<string, string> | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query<{ execution_model_json: string | null }, [string]>(
      "SELECT execution_model_json FROM turns WHERE id = ?",
    ).get(turnId);
    return row?.execution_model_json
      ? JSON.parse(row.execution_model_json) as Record<string, string>
      : null;
  } finally {
    db.close();
  }
}

function readAcceptanceCount(dbPath: string, turnId: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM btcc_model_round_acceptances WHERE turn_id = ?",
    ).get(turnId)?.count ?? 0;
  } finally {
    db.close();
  }
}
