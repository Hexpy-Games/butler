import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  AgentBtccMigrationReceipt,
  AgentBtccMigrationTableReceipt,
} from "./contracts.ts";
import { AGENT_BTCC_STATEFUL_TABLES } from "./manifest.ts";

type CopyableValue = string | number | bigint | Uint8Array | null;
type TableInfo = { name: string; pk: number; hidden?: number };

export function copyAndValidateStatefulTables(
  source: Database | undefined,
  target: Database,
): AgentBtccMigrationTableReceipt[] {
  return AGENT_BTCC_STATEFUL_TABLES.map((table) =>
    copyAndValidateTable(source, target, table),
  );
}

export function validateReceiptSnapshot(
  db: Database,
  receipt: AgentBtccMigrationReceipt,
): void {
  for (const expected of receipt.tables) {
    const actual = tableReceipt(db, expected.name, tableColumns(db, expected.name));
    if (actual.rowCount !== expected.rowCount || actual.contentSha256 !== expected.contentSha256) {
      throw new Error(`agent_btcc_storage_receipt_table_mismatch:${expected.name}`);
    }
  }
}

export function validateCanonicalManifest(db: Database): void {
  const actual = btccTableNames(db);
  const expected = [...AGENT_BTCC_STATEFUL_TABLES];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("agent_btcc_canonical_manifest_mismatch");
  }
}

export function rejectUnknownSourceTables(db: Database): void {
  const known = new Set<string>(AGENT_BTCC_STATEFUL_TABLES);
  const unknown = btccTableNames(db).find((table) => !known.has(table));
  if (unknown) throw new Error(`agent_btcc_migration_unknown_source_table:${unknown}`);
}

export function validateAgentBtccDatabase(db: Database): void {
  const quick = db.query<Record<string, string>, []>("PRAGMA quick_check").get();
  if (!quick || Object.values(quick)[0] !== "ok") {
    throw new Error("agent_btcc_migration_quick_check_failed");
  }
  if (db.query("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("agent_btcc_migration_reference_check_failed");
  }
}

function copyAndValidateTable(
  source: Database | undefined,
  target: Database,
  table: string,
): AgentBtccMigrationTableReceipt {
  if (!source || !tableExists(source, table)) {
    return tableReceipt(target, table, tableColumns(target, table));
  }
  const sourceColumns = tableColumns(source, table);
  const targetColumnSet = new Set(tableColumns(target, table));
  const columns = sourceColumns.filter((column) => targetColumnSet.has(column));
  if (columns.length !== sourceColumns.length) {
    throw new Error(`agent_btcc_migration_target_column_missing:${table}`);
  }
  const selected = selectRows(source, table, columns);
  if (selected.length > 0) {
    const names = columns.map(quoteIdentifier).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const insert = target.query(
      `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders})`,
    );
    for (const row of selected) insert.run(...columns.map((column) => row[column]));
  }
  const sourceReceipt = tableReceipt(source, table, columns);
  const targetReceipt = tableReceipt(target, table, columns);
  if (sourceReceipt.rowCount !== targetReceipt.rowCount ||
    sourceReceipt.contentSha256 !== targetReceipt.contentSha256) {
    throw new Error(`agent_btcc_migration_table_mismatch:${table}`);
  }
  return targetReceipt;
}

function tableReceipt(
  db: Database,
  table: string,
  columns: string[],
): AgentBtccMigrationTableReceipt {
  const rows = selectRows(db, table, columns);
  const digest = createHash("sha256");
  for (const row of rows) {
    digest.update(JSON.stringify(columns.map((column) => encodeValue(row[column]))));
    digest.update("\n");
  }
  return { name: table, rowCount: rows.length, contentSha256: digest.digest("hex") };
}

function selectRows(
  db: Database,
  table: string,
  columns: string[],
): Record<string, CopyableValue>[] {
  const order = primaryKeyColumns(db, table);
  const orderSql = order.length > 0 ? order.map(quoteIdentifier).join(", ") : "rowid";
  return db.query<Record<string, CopyableValue>, []>(`
    SELECT ${columns.map(quoteIdentifier).join(", ")}
    FROM ${quoteIdentifier(table)} ORDER BY ${orderSql}
  `).all();
}

function encodeValue(value: CopyableValue): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return { bigint: value.toString() };
  return value;
}

function tableColumns(db: Database, table: string): string[] {
  return db.query<TableInfo, []>(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all()
    .filter((column) => !column.hidden)
    .map((column) => column.name);
}

function primaryKeyColumns(db: Database, table: string): string[] {
  return db.query<TableInfo, []>(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function btccTableNames(db: Database): string[] {
  return db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'btcc_%' ORDER BY name
  `).all().map((row) => row.name);
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
