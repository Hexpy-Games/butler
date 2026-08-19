import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  AGENT_BTCC_STATEFUL_TABLES,
  agentBtccStoragePaths,
  prepareAgentBtccStorage,
  validateAgentBtccStorageForReadiness,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/storage-ownership/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";

const roots: string[] = [];
const HISTORICAL_STATEFUL_TABLES = AGENT_BTCC_STATEFUL_TABLES.filter((table) =>
  ![
    "btcc_authority_requests",
    "btcc_session_relations",
    "btcc_steward_results",
    "btcc_subsession_delegations",
    "btcc_subsession_outbox",
  ].includes(table),
);
const HISTORICAL_MANIFEST_ID = "0ccdc30dc007152084907cd49f55a79a611204aa0ed9446905e6719e9d1652ed";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function historicalReceipt() {
  return {
    schema: "butler.agent-btcc-storage-migration.v1",
    manifestId: HISTORICAL_MANIFEST_ID,
    sourceKind: "legacy_app_db",
    sourceSchemaVersion: 0,
    sourceSizeBytes: 0,
    fence: {
      fenceId: "historical-fence",
      reconciledClaims: 0,
      parkedClaims: 0,
      claimDispositionSha256: createHash("sha256").update("[]").digest("hex"),
    },
    tables: HISTORICAL_STATEFUL_TABLES.map((name) => ({
      name,
      rowCount: 0,
      contentSha256: "0".repeat(64),
    })),
    completedAt: "2026-08-19T00:00:00.000Z",
  };
}

function createPreviouslyActivatedDatabase(options: { additiveTables?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "btcc-agent-manifest-upgrade-"));
  roots.push(root);
  const paths = agentBtccStoragePaths(root);
  mkdirSync(join(root, "agent-runtime"), { recursive: true });
  const db = new Database(paths.agentBtccDbPath, { create: true, strict: true });
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  migrateBtccSchema(db);
  if (options.additiveTables === false) {
    db.exec(`
      DROP TABLE btcc_subsession_outbox;
      DROP TABLE btcc_steward_results;
      DROP TABLE btcc_subsession_delegations;
      DROP TABLE btcc_session_relations;
      DROP TABLE btcc_authority_requests;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_storage_migration_receipt (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      manifest_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_storage_activation_marker (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      manifest_id TEXT NOT NULL,
      marker_json TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO btcc_messages
      (message_id, session_id, turn_id, role, content, idempotency_key, created_at)
    VALUES ('preserved-message', 'session-1', 'turn-1', 'assistant', 'preserve me',
      'idempotency-1', '2026-08-19T00:00:00.000Z');
  `);
  if (options.additiveTables !== false) {
    db.exec(`
      INSERT INTO btcc_session_relations
        (relation_id, parent_session_id, parent_turn_id, child_session_id,
         anchor_message_id, ordinal, safe_title, created_at)
      VALUES ('relation-1', 'session-1', 'turn-1', 'session-steward-1',
        'preserved-message', 0, 'Steward', '2026-08-19T00:00:00.000Z');
    `);
  }
  const receipt = historicalReceipt();
  db.query(`
    INSERT INTO agent_storage_migration_receipt
      (singleton, manifest_id, receipt_json) VALUES (1, ?, ?)
  `).run(
    HISTORICAL_MANIFEST_ID,
    JSON.stringify(receipt),
  );
  db.query(`
    INSERT INTO agent_storage_activation_marker
      (singleton, manifest_id, marker_json) VALUES (1, ?, ?)
  `).run(
    HISTORICAL_MANIFEST_ID,
    JSON.stringify({
      schema: "butler.agent-btcc-storage-activation.v1",
      manifestId: HISTORICAL_MANIFEST_ID,
      storageContract: "split-v1",
      runtimeVersion: "0.0.17",
      firstActivatedAt: "2026-08-19T00:00:00.000Z",
      activatedAt: "2026-08-19T00:00:00.000Z",
    }),
  );
  db.close();
  return { root, paths };
}

test("upgrades an activated historical manifest after additive Steward tables exist", async () => {
  const { root, paths } = createPreviouslyActivatedDatabase();

  const result = await prepareAgentBtccStorage({
    butlerData: root,
    quiesceLegacyWriter: async () => ({ fenceId: "unused", reconciledClaims: 0, parkedClaims: 0 }),
  });

  expect(result.kind).toBe("existing");
  expect(result.receipt.manifestId).not.toBe(HISTORICAL_MANIFEST_ID);
  expect(result.receipt.tables.map((table) => table.name)).toEqual([...AGENT_BTCC_STATEFUL_TABLES]);
  expect(validateAgentBtccStorageForReadiness({ butlerData: root }).manifestId)
    .toBe(result.receipt.manifestId);

  const db = new Database(paths.agentBtccDbPath, { readonly: true, strict: true });
  try {
    expect(db.query("SELECT content FROM btcc_messages WHERE message_id = 'preserved-message'").get())
      .toEqual({ content: "preserve me" });
    expect(db.query("SELECT relation_id FROM btcc_session_relations").get())
      .toEqual({ relation_id: "relation-1" });
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name LIKE 'btcc_%'
    `).get()).toEqual({ count: AGENT_BTCC_STATEFUL_TABLES.length });
  } finally {
    db.close();
  }
});

test("creates accepted additive tables for a pre-additive activated database", async () => {
  const { root, paths } = createPreviouslyActivatedDatabase({ additiveTables: false });

  const result = await prepareAgentBtccStorage({
    butlerData: root,
    quiesceLegacyWriter: async () => ({ fenceId: "unused", reconciledClaims: 0, parkedClaims: 0 }),
  });

  expect(result.kind).toBe("existing");
  const db = new Database(paths.agentBtccDbPath, { readonly: true, strict: true });
  try {
    expect(db.query("SELECT content FROM btcc_messages WHERE message_id = 'preserved-message'").get())
      .toEqual({ content: "preserve me" });
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name LIKE 'btcc_%'
    `).get()).toEqual({ count: AGENT_BTCC_STATEFUL_TABLES.length });
  } finally {
    db.close();
  }
});

test("rejects unknown tables before changing a historical receipt", async () => {
  const { root, paths } = createPreviouslyActivatedDatabase();
  const db = new Database(paths.agentBtccDbPath);
  db.exec("CREATE TABLE btcc_unknown_state (id TEXT PRIMARY KEY)");
  const before = createHash("sha256").update(readFileSync(paths.agentBtccDbPath)).digest("hex");
  db.close();

  await expect(prepareAgentBtccStorage({
    butlerData: root,
    quiesceLegacyWriter: async () => ({ fenceId: "unused", reconciledClaims: 0, parkedClaims: 0 }),
  })).rejects.toThrow("agent_btcc_canonical_manifest_mismatch");

  const after = createHash("sha256").update(readFileSync(paths.agentBtccDbPath)).digest("hex");
  expect(after).toBe(before);
});
