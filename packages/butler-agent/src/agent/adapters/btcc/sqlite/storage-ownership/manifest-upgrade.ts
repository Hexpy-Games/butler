import { Database } from "bun:sqlite";
import type {
  AgentBtccActivationMarker,
  AgentBtccMigrationReceipt,
} from "./contracts.ts";
import {
  ACCEPTED_HISTORICAL_MANIFEST_IDS,
  AGENT_BTCC_MIGRATION_MANIFEST_ID,
  AGENT_BTCC_STATEFUL_TABLES,
  agentBtccManifestId,
} from "./manifest.ts";
import {
  snapshotStatefulTables,
  validateAgentBtccDatabase,
  validateCanonicalManifest,
} from "./migration-table-copy.ts";
import { migrateBtccSchema } from "../schema/migrate-schema.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../schema.ts";

type ReceiptRow = { manifest_id: string; receipt_json: string };
type MarkerRow = { manifest_id: string; marker_json: string };

export function upgradeActivatedStorageManifest(
  dbPath: string,
  now: () => Date = () => new Date(),
): void {
  const db = new Database(dbPath, { strict: true });
  try {
    const receiptRow = readReceiptRow(db);
    if (receiptRow.manifest_id === AGENT_BTCC_MIGRATION_MANIFEST_ID) return;
    if (!ACCEPTED_HISTORICAL_MANIFEST_IDS.has(receiptRow.manifest_id)) {
      throw new Error("agent_btcc_storage_manifest_mismatch");
    }
    const receipt = decodeHistoricalReceipt(receiptRow);
    const marker = decodeHistoricalMarker(readMarkerRow(db), receiptRow.manifest_id);
    validatePreUpgradeTables(db, receipt.tables.map((table) => table.name));

    // Existing schema migration is independently atomic and restartable. The
    // receipt/activation pair is then advanced together below.
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    migrateBtccSchema(db);
    validateCanonicalManifest(db);
    validateAgentBtccDatabase(db);
    const upgradedReceipt: AgentBtccMigrationReceipt = {
      ...receipt,
      manifestId: AGENT_BTCC_MIGRATION_MANIFEST_ID,
      tables: snapshotStatefulTables(db),
    };
    const upgradedMarker: AgentBtccActivationMarker = {
      ...marker,
      manifestId: AGENT_BTCC_MIGRATION_MANIFEST_ID,
      activatedAt: now().toISOString(),
    };
    db.transaction(() => {
      db.query(`
        UPDATE agent_storage_migration_receipt
        SET manifest_id = ?, receipt_json = ? WHERE singleton = 1
      `).run(
        AGENT_BTCC_MIGRATION_MANIFEST_ID,
        JSON.stringify(upgradedReceipt),
      );
      db.query(`
        UPDATE agent_storage_activation_marker
        SET manifest_id = ?, marker_json = ? WHERE singleton = 1
      `).run(
        AGENT_BTCC_MIGRATION_MANIFEST_ID,
        JSON.stringify(upgradedMarker),
      );
    }).immediate();
  } finally {
    db.close();
  }
}

function readReceiptRow(db: Database): ReceiptRow {
  const tablePresent = db.query<{ present: number }, []>(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = 'agent_storage_migration_receipt'
  `).get();
  if (!tablePresent) throw new Error("agent_btcc_storage_unreceipted_target");
  const row = db.query<ReceiptRow, []>(`
    SELECT manifest_id, receipt_json FROM agent_storage_migration_receipt
    WHERE singleton = 1
  `).get();
  if (!row) throw new Error("agent_btcc_storage_unreceipted_target");
  return row;
}

function readMarkerRow(db: Database): MarkerRow {
  const tablePresent = db.query<{ present: number }, []>(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = 'agent_storage_activation_marker'
  `).get();
  if (!tablePresent) throw new Error("agent_btcc_storage_activation_missing");
  const row = db.query<MarkerRow, []>(`
    SELECT manifest_id, marker_json FROM agent_storage_activation_marker
    WHERE singleton = 1
  `).get();
  if (!row) throw new Error("agent_btcc_storage_activation_missing");
  return row;
}

function decodeHistoricalReceipt(row: ReceiptRow): AgentBtccMigrationReceipt {
  let receipt: AgentBtccMigrationReceipt;
  try {
    receipt = JSON.parse(row.receipt_json) as AgentBtccMigrationReceipt;
  } catch {
    throw new Error("agent_btcc_storage_receipt_invalid");
  }
  const names = receipt?.tables?.map((table) => table?.name);
  const fence = receipt?.fence;
  if (
    receipt?.schema !== "butler.agent-btcc-storage-migration.v1" ||
    receipt.manifestId !== row.manifest_id ||
    (receipt.sourceKind !== "legacy_app_db" && receipt.sourceKind !== "fresh_install") ||
    !nonNegativeInteger(receipt.sourceSchemaVersion) ||
    !nonNegativeInteger(receipt.sourceSizeBytes) ||
    !fence || typeof fence.fenceId !== "string" || !fence.fenceId.trim() ||
    !nonNegativeInteger(fence.reconciledClaims) ||
    !nonNegativeInteger(fence.parkedClaims) ||
    fence.parkedClaims > fence.reconciledClaims ||
    !sha256Digest(fence.claimDispositionSha256) ||
    !Array.isArray(names) || names.length === 0 ||
    new Set(names).size !== names.length ||
    JSON.stringify([...names].sort()) !== JSON.stringify(names) ||
    agentBtccManifestId(names) !== row.manifest_id ||
    receipt.tables.some((table) =>
      !table || !nonNegativeInteger(table.rowCount) ||
      !sha256Digest(table.contentSha256),
    ) ||
    typeof receipt.completedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.completedAt))
  ) {
    throw new Error("agent_btcc_storage_receipt_invalid");
  }
  return receipt;
}

function decodeHistoricalMarker(
  row: MarkerRow,
  manifestId: string,
): AgentBtccActivationMarker {
  let marker: AgentBtccActivationMarker;
  try {
    marker = JSON.parse(row.marker_json) as AgentBtccActivationMarker;
  } catch {
    throw new Error("agent_btcc_storage_activation_invalid");
  }
  if (
    row.manifest_id !== manifestId ||
    marker?.schema !== "butler.agent-btcc-storage-activation.v1" ||
    marker.manifestId !== manifestId || marker.storageContract !== "split-v1" ||
    typeof marker.runtimeVersion !== "string" || !marker.runtimeVersion ||
    typeof marker.firstActivatedAt !== "string" || !marker.firstActivatedAt ||
    typeof marker.activatedAt !== "string" || !marker.activatedAt
  ) {
    throw new Error("agent_btcc_storage_activation_invalid");
  }
  return marker;
}

function validatePreUpgradeTables(db: Database, receiptedTables: string[]): void {
  const actual = db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'btcc_%' ORDER BY name
  `).all().map((row) => row.name);
  const accepted = new Set<string>(AGENT_BTCC_STATEFUL_TABLES);
  if (
    receiptedTables.some((table) => !actual.includes(table)) ||
    actual.some((table) => !accepted.has(table))
  ) {
    throw new Error("agent_btcc_canonical_manifest_mismatch");
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
