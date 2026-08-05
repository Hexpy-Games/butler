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

  test("projects the accepted provider identity into the durable App turn", () => {
    const root = mkdtempSync(join(tmpdir(), "butler-execution-model-"));
    const dbPath = join(root, "app.sqlite");
    const appDb = new Database(dbPath);
    migrateAppStoreSchema(appDb);
    seedAppStoreDefaults(appDb);
    const appTurns = new AppTurnRecordStore(appDb, () => false);
    const turn = appTurns.insertTurn("general", "thinking", "Working", resolution);
    appDb.close();

    const stores = openBtccSqliteStores({
      dbPath,
      ownerId: "execution-model-test",
      storageProfile: "ephemeral",
    });
    try {
      stores.turns.recordProviderResponseIdentity?.({
        turnId: turn.id,
        provider: "openai",
        configuredModel: "openai/gpt-5.6-luna",
        reportedModel: "gpt-5.6-luna-2026-08-01",
      });
      const projectedDb = new Database(dbPath, { readonly: true });
      const projected = projectedDb.query<{
        execution_model_json: string | null;
      }, [string]>(
        "SELECT execution_model_json FROM turns WHERE id = ?",
      ).get(turn.id);
      projectedDb.close();
      expect(JSON.parse(projected!.execution_model_json!)).toEqual({
        requested_model_ref: "openai/gpt-5.6-sol",
        adapter_effective_model_ref: "openai/gpt-5.6-luna",
        provider_reported_model_ref: "openai/gpt-5.6-luna-2026-08-01",
      });
    } finally {
      stores.close();
      rmSync(root, { recursive: true, force: true });
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
