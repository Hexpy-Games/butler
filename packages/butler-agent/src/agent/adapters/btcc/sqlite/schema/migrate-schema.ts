import type { Database } from "bun:sqlite";

type ColumnRow = { name: string };

export function migrateBtccSchema(db: Database): void {
  ensureLedgerContentionClaimPath(db);
  ensureOperationalDiagnostic(db);
  ensureColumn(db, "btcc_operational_interruptions", "diagnostic_json", "TEXT");
  ensureColumn(db, "btcc_operational_interruptions", "retry_at", "TEXT");
  ensureProgramAuthorityProjection(db);
  ensureColumn(db, "btcc_tasks", "revalidation_source_json", "TEXT");
  ensureColumn(db, "btcc_stopped_finalization_continuations", "bound_turn_id", "TEXT");
}

function ensureProgramAuthorityProjection(db: Database): void {
  ensureColumn(db, "btcc_programs", "available_specs_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "btcc_programs", "governing_spec_refs_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "btcc_programs", "promotion_permit_ref", "TEXT");
  ensureColumn(db, "btcc_programs", "accepted_plan_candidate_ref", "TEXT");
  ensureColumn(db, "btcc_programs", "cancellation_ref", "TEXT");
  const columns = db.query<ColumnRow, []>("PRAGMA table_info(btcc_programs)").all();
  if (columns.some((candidate) => candidate.name === "promotion_authorization_ref")) {
    db.exec(`
      UPDATE btcc_programs SET promotion_permit_ref = promotion_authorization_ref
      WHERE promotion_permit_ref IS NULL AND promotion_authorization_ref IS NOT NULL
    `);
  }
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db.query<ColumnRow, []>(`PRAGMA table_info(${table})`).all();
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
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
