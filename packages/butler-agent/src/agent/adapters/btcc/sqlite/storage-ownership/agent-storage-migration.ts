import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
  AGENT_BTCC_STATEFUL_TABLES,
} from "./manifest.ts";
import {
  copyAndValidateStatefulTables,
  validateAgentBtccDatabase,
  validateCanonicalManifest,
  validateReceiptSnapshot,
  snapshotStatefulTables,
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
    target.transaction(() =>
      copyAndValidateStatefulTables(source, target!),
    ).immediate();
    const claimDisposition = parkLegacyClaims(target);
    const tables = snapshotStatefulTables(target);
    input.faultHook?.("after_copy");
    validateAgentBtccDatabase(target);
    const receipt: AgentBtccMigrationReceipt = {
      schema: "butler.agent-btcc-storage-migration.v1",
      manifestId: AGENT_BTCC_MIGRATION_MANIFEST_ID,
      sourceKind: source ? "legacy_app_db" : "fresh_install",
      sourceSchemaVersion: source ? pragmaUserVersion(source) : 0,
      sourceSizeBytes,
      fence: {
        ...fence,
        reconciledClaims: claimDisposition.reconciledClaims,
        parkedClaims: claimDisposition.parkedClaims,
        claimDispositionSha256: claimDisposition.sha256,
      },
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

function parkLegacyClaims(db: Database): {
  reconciledClaims: number;
  parkedClaims: number;
  sha256: string;
} {
  const claims = [
    ...db.query<{ claim_id: string; owner_id: string; status: string }, []>(`
      SELECT claim_id, owner_id, status FROM btcc_admission_claims ORDER BY claim_id
    `).all().map((row) => ({ kind: "admission", ...row })),
    ...db.query<{ claim_id: string; owner_id: string; status: string }, []>(`
      SELECT claim_id, owner_id, status FROM btcc_state_claims ORDER BY claim_id
    `).all().map((row) => ({ kind: "state", ...row })),
  ];
  const active = claims.filter((claim) => claim.status === "active");
  db.transaction(() => {
    db.query("UPDATE btcc_admission_claims SET status = 'relinquished' WHERE status = 'active'").run();
    db.query("UPDATE btcc_state_claims SET status = 'relinquished' WHERE status = 'active'").run();
    db.query(`
      UPDATE btcc_checkpoints SET active_claim_id = NULL
      WHERE active_claim_id IN (
        SELECT claim_id FROM btcc_state_claims WHERE status = 'relinquished'
      )
    `).run();
  }).immediate();
  const disposition = claims.map((claim) => ({
    kind: claim.kind,
    claimId: claim.claim_id,
    ownerId: claim.owner_id,
    status: claim.status === "active" ? "relinquished" : claim.status,
  }));
  return {
    reconciledClaims: claims.length,
    parkedClaims: active.length,
    sha256: createHash("sha256").update(JSON.stringify(disposition)).digest("hex"),
  };
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
    const receipt = decodeMigrationReceipt(row.receipt_json);
    validateCanonicalManifest(db);
    validateAgentBtccDatabase(db);
    if (!activationMarkerExists(db)) {
      validateReceiptSnapshot(db, receipt);
      if (receipt.fence.claimDispositionSha256) {
        const classified = classifyParkedClaims(db);
        if (classified.sha256 !== receipt.fence.claimDispositionSha256 ||
          classified.reconciledClaims !== receipt.fence.reconciledClaims ||
          classified.activeClaims !== 0) {
          throw new Error("agent_btcc_storage_claim_disposition_mismatch");
        }
      }
    }
    return receipt;
  } finally {
    db.close();
  }
}

function decodeMigrationReceipt(value: string): AgentBtccMigrationReceipt {
  let receipt: unknown;
  try {
    receipt = JSON.parse(value);
  } catch {
    throw new Error("agent_btcc_storage_receipt_invalid");
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("agent_btcc_storage_receipt_invalid");
  }
  const candidate = receipt as Partial<AgentBtccMigrationReceipt>;
  const fence = candidate.fence;
  const tableNames = candidate.tables?.map((table) => table?.name);
  if (
    candidate.schema !== "butler.agent-btcc-storage-migration.v1" ||
    candidate.manifestId !== AGENT_BTCC_MIGRATION_MANIFEST_ID ||
    (candidate.sourceKind !== "legacy_app_db" &&
      candidate.sourceKind !== "fresh_install") ||
    !nonNegativeInteger(candidate.sourceSchemaVersion) ||
    !nonNegativeInteger(candidate.sourceSizeBytes) ||
    !fence || typeof fence.fenceId !== "string" || !fence.fenceId.trim() ||
    !nonNegativeInteger(fence.reconciledClaims) ||
    !nonNegativeInteger(fence.parkedClaims) ||
    fence.parkedClaims > fence.reconciledClaims ||
    !sha256Digest(fence.claimDispositionSha256) ||
    !Array.isArray(candidate.tables) ||
    JSON.stringify(tableNames) !== JSON.stringify(AGENT_BTCC_STATEFUL_TABLES) ||
    candidate.tables.some((table) =>
      !table || !nonNegativeInteger(table.rowCount) ||
      !sha256Digest(table.contentSha256),
    ) ||
    typeof candidate.completedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.completedAt))
  ) {
    throw new Error("agent_btcc_storage_receipt_invalid");
  }
  return candidate as AgentBtccMigrationReceipt;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function classifyParkedClaims(db: Database): {
  reconciledClaims: number;
  activeClaims: number;
  sha256: string;
} {
  const claims = [
    ...db.query<{ claim_id: string; owner_id: string; status: string }, []>(`
      SELECT claim_id, owner_id, status FROM btcc_admission_claims ORDER BY claim_id
    `).all().map((row) => ({ kind: "admission", ...row })),
    ...db.query<{ claim_id: string; owner_id: string; status: string }, []>(`
      SELECT claim_id, owner_id, status FROM btcc_state_claims ORDER BY claim_id
    `).all().map((row) => ({ kind: "state", ...row })),
  ];
  const disposition = claims.map((claim) => ({
    kind: claim.kind, claimId: claim.claim_id, ownerId: claim.owner_id,
    status: claim.status,
  }));
  return {
    reconciledClaims: claims.length,
    activeClaims: claims.filter((claim) => claim.status === "active").length,
    sha256: createHash("sha256").update(JSON.stringify(disposition)).digest("hex"),
  };
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
