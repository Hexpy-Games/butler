import type { Database } from "bun:sqlite";
import type {
  LogicalLedgerBundle,
  LogicalLedgerRecord,
  WorkLedgerCommit,
} from "../../../../btcc/index.ts";
import { assertLogicalLedgerRecordBytes } from "../../../../btcc/index.ts";
import { stableJson } from "../identity.ts";

type CommitBoundary =
  | { kind: "replayed" }
  | { kind: "opened"; baseRevision: number };

export class WorkLedgerCommitJournal {
  constructor(private readonly db: Database) {}

  open(input: WorkLedgerCommit): CommitBoundary {
    if (this.isCommitted(input)) return { kind: "replayed" };
    const baseRevision = this.currentManifestRevision(input);
    this.acquireClaim(input, baseRevision);
    return { kind: "opened", baseRevision };
  }

  close(
    input: WorkLedgerCommit,
    baseRevision: number,
    bundle: LogicalLedgerBundle,
    records: LogicalLedgerRecord[],
  ): void {
    this.db.query(`
      INSERT INTO btcc_ledger_mutations (
        mutation_id, ledger_id, program_id, turn_id, turn_revision,
        mutation_kind, mutation_json, base_manifest_revision, next_manifest_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.mutationId,
      ledgerIdOf(input),
      programIdOf(input),
      input.turnId,
      input.expectedTurnRevision,
      input.mutation.kind,
      stableJson(input.mutation),
      baseRevision,
      baseRevision + 1,
    );
    const { ref: _ref, ...bundleBody } = bundle;
    this.db.query(`
      INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
      VALUES (?, 'ledger_bundle', ?, ?)
    `).run(bundle.ref.id, bundle.ref.sha256, stableJson(bundleBody));
    for (const record of records) this.insertLogicalRecord(record);
    const stored = this.db.query<{ sha256: string; content_json: string }, [string]>(`
      SELECT sha256, content_json FROM btcc_records WHERE record_id = ?
    `).get(bundle.ref.id);
    if (!stored || stored.sha256 !== bundle.ref.sha256 ||
      stored.content_json !== stableJson(bundleBody)) {
      throw new Error("Work Ledger logical bundle identity conflict");
    }
    this.db.query("UPDATE btcc_ledger_claims SET status = 'promoted' WHERE claim_id = ?")
      .run(input.mutationId);
  }

  materializeSourceRecords(records: LogicalLedgerRecord[]): void {
    for (const record of records) this.insertSourceRecord(record);
  }

  private insertLogicalRecord(record: LogicalLedgerRecord): void {
    assertLogicalLedgerRecordBytes(record.ref, record.semanticBytes);
    this.db.query(`
      INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
      VALUES (?, 'ledger_record', ?, ?)
    `).run(record.ref.id, record.ref.sha256, record.semanticBytes);
    const stored = this.db.query<{ sha256: string; content_json: string }, [string]>(`
      SELECT sha256, content_json FROM btcc_records WHERE record_id = ?
    `).get(record.ref.id);
    if (!stored || stored.sha256 !== record.ref.sha256 ||
      stored.content_json !== record.semanticBytes) {
      throw new Error("Work Ledger logical record identity conflict");
    }
  }

  private insertSourceRecord(record: LogicalLedgerRecord): void {
    assertLogicalLedgerRecordBytes(record.ref, record.semanticBytes);
    const logical = JSON.parse(record.semanticBytes) as {
      sourceId: string;
      record: Record<string, unknown>;
    };
    if (logical.sourceId !== record.sourceRef.id) {
      throw new Error("Work Ledger logical record changed its source identity");
    }
    if (!logical.record || typeof logical.record !== "object" || Array.isArray(logical.record)) {
      throw new Error("Work Ledger logical source record is not an object");
    }
    const content = stableJson({ ...logical.record, ref: record.sourceRef });
    this.db.query(`
      INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
      VALUES (?, 'ledger_source_record', ?, ?)
    `).run(record.sourceRef.id, record.sourceRef.sha256, content);
    const stored = this.db.query<{ sha256: string; content_json: string }, [string]>(`
      SELECT sha256, content_json FROM btcc_records WHERE record_id = ?
    `).get(record.sourceRef.id);
    if (!stored || stored.sha256 !== record.sourceRef.sha256 || stored.content_json !== content) {
      throw new Error(`Work Ledger source record identity conflict: ${record.sourceRef.id}`);
    }
  }

  private currentManifestRevision(input: WorkLedgerCommit): number {
    if (input.mutation.kind === "bind_program") {
      return input.mutation.product.authority.managedBinding.expectedManifestRevision;
    }
    const programId = programIdOf(input);
    const row = this.db.query<{ manifest_revision: number }, [string]>(`
      SELECT manifest_revision FROM btcc_programs WHERE program_id = ?
    `).get(programId);
    if (!row) throw new Error(`Work Ledger Program is missing: ${programId}`);
    const projected = projectedManifestRevision(input);
    if (projected !== row.manifest_revision) {
      throw new Error("Work Ledger boundary used a stale Program manifest");
    }
    return row.manifest_revision;
  }

  private acquireClaim(input: WorkLedgerCommit, baseRevision: number): void {
    this.db.query(`
      INSERT INTO btcc_ledger_claims (
        claim_id, ledger_id, program_id, base_manifest_revision, turn_id,
        turn_revision, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'held')
    `).run(
      input.mutationId,
      ledgerIdOf(input),
      programIdOf(input),
      baseRevision,
      input.turnId,
      input.expectedTurnRevision,
    );
  }

  private isCommitted(input: WorkLedgerCommit): boolean {
    const row = this.db.query<{
      mutation_kind: string;
      mutation_json: string;
      turn_id: string;
      turn_revision: number;
    }, [string]>(`
      SELECT mutation_kind, mutation_json, turn_id, turn_revision FROM btcc_ledger_mutations
      WHERE mutation_id = ?
    `).get(input.mutationId);
    if (!row) return false;
    if (
      row.mutation_kind !== input.mutation.kind ||
      row.mutation_json !== stableJson(input.mutation) ||
      row.turn_id !== input.turnId ||
      row.turn_revision !== input.expectedTurnRevision
    ) {
      throw new Error("Work Ledger mutation identity conflict");
    }
    return true;
  }
}

function programIdOf(input: WorkLedgerCommit): string {
  const mutation = input.mutation;
  if (mutation.kind === "bind_program") {
    return mutation.product.authority.managedBinding.programId;
  }
  if (mutation.kind === "install_reviewed_plan") return mutation.product.candidate.programId;
  return mutation.cursor.programId;
}

function ledgerIdOf(input: WorkLedgerCommit): string {
  const mutation = input.mutation;
  if (mutation.kind === "bind_program") {
    return mutation.product.authority.managedBinding.ledgerId;
  }
  if (mutation.kind === "install_reviewed_plan") return mutation.product.candidate.ledgerId;
  return mutation.cursor.ledgerId;
}

function projectedManifestRevision(input: WorkLedgerCommit): number {
  const mutation = input.mutation;
  if (mutation.kind === "install_reviewed_plan") {
    return mutation.product.candidate.observedManifestRevision;
  }
  if (mutation.kind === "bind_program") {
    return mutation.product.authority.managedBinding.expectedManifestRevision;
  }
  return mutation.cursor.expectedManifestRevision;
}
