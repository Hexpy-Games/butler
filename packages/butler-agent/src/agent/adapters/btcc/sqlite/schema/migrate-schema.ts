import type { Database } from "bun:sqlite";

type ColumnRow = { name: string };

export function migrateBtccSchema(db: Database): void {
  ensureLedgerContentionClaimPath(db);
  ensureOperationalDiagnostic(db);
}

function ensureLedgerContentionClaimPath(db: Database): void {
  const columns = db.query<ColumnRow, []>(
    "PRAGMA table_info(btcc_ledger_contentions)",
  ).all();
  if (columns.some((column) => column.name === "claim_path")) return;
  db.exec(
    "ALTER TABLE btcc_ledger_contentions " +
    "ADD COLUMN claim_path TEXT NOT NULL DEFAULT ''",
  );
}

function ensureOperationalDiagnostic(db: Database): void {
  const columns = db.query<ColumnRow, []>(
    "PRAGMA table_info(btcc_operational_interruptions)",
  ).all();
  if (columns.some((column) => column.name === "diagnostic_message")) return;
  db.exec(
    "ALTER TABLE btcc_operational_interruptions " +
    "ADD COLUMN diagnostic_message TEXT",
  );
}
