import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BTCC_SUCCESSOR_SCHEMA } from "../schema.ts";
import { migrateBtccSchema } from "../schema/migrate-schema.ts";
import type {
  AgentBtccMigrationReceipt,
  AgentBtccStoragePaths,
  PrepareAgentBtccStorageResult,
} from "./contracts.ts";
import {
  AGENT_BTCC_MIGRATION_MANIFEST_ID,
} from "./manifest.ts";
import {
  copyAndValidateStatefulTables,
  rejectUnknownSourceTables,
  validateAgentBtccDatabase,
  validateCanonicalManifest,
  validateReceiptSnapshot,
} from "./migration-table-copy.ts";

const STORAGE_METADATA_SCHEMA = `
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
`;

export function agentBtccStoragePaths(butlerData: string): AgentBtccStoragePaths {
  const agentBtccDbPath = join(butlerData, "agent-runtime", "btcc.sqlite");
  return {
    legacyAppDbPath: join(butlerData, "app-server", "butler-client.sqlite"),
    agentBtccDbPath,
    temporaryAgentBtccDbPath: `${agentBtccDbPath}.migration.tmp`,
  };
}

export async function prepareAgentBtccStorage(input: {
  butlerData: string;
  quiesceLegacyWriter: () => Promise<{
    fenceId: string;
    reconciledClaims: number;
    parkedClaims: number;
  }>;
  faultHook?: (point: "after_copy" | "before_publish") => void;
  now?: () => Date;
}): Promise<PrepareAgentBtccStorageResult> {
  const paths = agentBtccStoragePaths(input.butlerData);
  if (existsSync(paths.agentBtccDbPath)) {
    return { kind: "existing", receipt: readValidatedReceipt(paths.agentBtccDbPath) };
  }
  const fence = await input.quiesceLegacyWriter();
  validateFence(fence);
  mkdirSync(dirname(paths.agentBtccDbPath), { recursive: true });
  rmIncompleteTemporaryTarget(paths);
  const sourceExists = existsSync(paths.legacyAppDbPath);
  const sourceSizeBytes = sourceExists ? statSync(paths.legacyAppDbPath).size : 0;
  let source: Database | undefined;
  let target: Database | undefined;
  try {
    source = sourceExists
      ? new Database(paths.legacyAppDbPath, { readonly: true, strict: true })
      : undefined;
    source?.exec("BEGIN");
    target = new Database(paths.temporaryAgentBtccDbPath, { create: true, strict: true });
    target.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(target);
    target.exec(STORAGE_METADATA_SCHEMA);
    validateCanonicalManifest(target);
    if (source) rejectUnknownSourceTables(source);
    const tables = target.transaction(() =>
      copyAndValidateStatefulTables(source, target!),
    ).immediate();
    input.faultHook?.("after_copy");
    validateAgentBtccDatabase(target);
    const receipt: AgentBtccMigrationReceipt = {
      schema: "butler.agent-btcc-storage-migration.v1",
      manifestId: AGENT_BTCC_MIGRATION_MANIFEST_ID,
      sourceKind: source ? "legacy_app_db" : "fresh_install",
      sourceSchemaVersion: source ? pragmaUserVersion(source) : 0,
      sourceSizeBytes,
      fence,
      tables,
      completedAt: (input.now?.() ?? new Date()).toISOString(),
    };
    target.query(`
      INSERT INTO agent_storage_migration_receipt
        (singleton, manifest_id, receipt_json) VALUES (1, ?, ?)
    `).run(receipt.manifestId, JSON.stringify(receipt));
    validateAgentBtccDatabase(target);
    target.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    target.close();
    target = undefined;
    source?.exec("COMMIT");
    source?.close();
    source = undefined;
    fsyncPath(paths.temporaryAgentBtccDbPath);
    input.faultHook?.("before_publish");
    if (existsSync(paths.agentBtccDbPath)) {
      throw new Error("agent_btcc_storage_publish_target_exists");
    }
    renameSync(paths.temporaryAgentBtccDbPath, paths.agentBtccDbPath);
    fsyncDirectory(dirname(paths.agentBtccDbPath));
    return {
      kind: sourceExists ? "migrated" : "fresh",
      receipt: readValidatedReceipt(paths.agentBtccDbPath),
    };
  } catch (error) {
    if (source?.inTransaction) source.exec("ROLLBACK");
    source?.close();
    target?.close();
    rmSync(paths.temporaryAgentBtccDbPath, { force: true });
    rmSync(`${paths.temporaryAgentBtccDbPath}-wal`, { force: true });
    rmSync(`${paths.temporaryAgentBtccDbPath}-shm`, { force: true });
    throw error;
  }
}

export function readValidatedReceipt(dbPath: string): AgentBtccMigrationReceipt {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const metadataPresent = db.query<{ present: number }, []>(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'agent_storage_migration_receipt'
    `).get();
    if (!metadataPresent) throw new Error("agent_btcc_storage_unreceipted_target");
    const row = db.query<{ manifest_id: string; receipt_json: string }, []>(`
      SELECT manifest_id, receipt_json FROM agent_storage_migration_receipt
      WHERE singleton = 1
    `).get();
    if (!row) throw new Error("agent_btcc_storage_unreceipted_target");
    if (row.manifest_id !== AGENT_BTCC_MIGRATION_MANIFEST_ID) {
      throw new Error("agent_btcc_storage_manifest_mismatch");
    }
    const receipt = JSON.parse(row.receipt_json) as AgentBtccMigrationReceipt;
    if (receipt.schema !== "butler.agent-btcc-storage-migration.v1" ||
      receipt.manifestId !== AGENT_BTCC_MIGRATION_MANIFEST_ID) {
      throw new Error("agent_btcc_storage_receipt_invalid");
    }
    validateCanonicalManifest(db);
    validateAgentBtccDatabase(db);
    if (!activationMarkerExists(db)) {
      validateReceiptSnapshot(db, receipt);
    }
    return receipt;
  } finally {
    db.close();
  }
}

function activationMarkerExists(db: Database): boolean {
  return Boolean(db.query<{ present: number }, []>(`
    SELECT 1 AS present FROM agent_storage_activation_marker WHERE singleton = 1
  `).get());
}

function pragmaUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

function validateFence(fence: { fenceId: string; reconciledClaims: number; parkedClaims: number }): void {
  if (!fence.fenceId.trim() || !Number.isSafeInteger(fence.reconciledClaims) ||
    fence.reconciledClaims < 0 || !Number.isSafeInteger(fence.parkedClaims) || fence.parkedClaims < 0) {
    throw new Error("agent_btcc_migration_invalid_writer_fence");
  }
}

function rmIncompleteTemporaryTarget(paths: AgentBtccStoragePaths): void {
  rmSync(paths.temporaryAgentBtccDbPath, { force: true });
  rmSync(`${paths.temporaryAgentBtccDbPath}-wal`, { force: true });
  rmSync(`${paths.temporaryAgentBtccDbPath}-shm`, { force: true });
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
