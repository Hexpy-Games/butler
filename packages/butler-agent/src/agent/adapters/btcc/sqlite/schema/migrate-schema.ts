import type { Database } from "bun:sqlite";

type ColumnRow = { name: string };

export function migrateBtccSchema(db: Database): void {
  ensureLedgerContentionClaimPath(db);
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
