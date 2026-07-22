import type { Database } from "bun:sqlite";
import type {
  PreparedProjectLedgerPublication,
  ProjectLedgerHead,
} from "../project-ledger/index.ts";
import type { WorkLedgerCommit } from "../../../btcc/gateway-api.ts";
import type { BtccPersistenceTypes } from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";

export type ProjectPlanningBase = {
  candidateRef: string;
  programId: string;
  projectRef: string;
  head: ProjectLedgerHead;
};

export type ProjectLedgerBoundaryContext = {
  planningBase?: ProjectPlanningBase;
  preparedPublication?: PreparedProjectLedgerPublication;
  projectedProgram?: BtccPersistenceTypes["managedProgramState"];
  projectRef?: string;
};

export type PendingProjectLedgerPromotion = {
  outboxId: string;
  publication: PreparedProjectLedgerPublication;
  status: "pending" | "observed";
};

export class ProjectLedgerPromotionWriter {
  constructor(private readonly db: Database) {}

  recordPlanningBase(base: ProjectPlanningBase): void {
    this.db.query(`
      INSERT INTO btcc_project_planning_bases (
        candidate_ref, program_id, project_ref, head_json
      ) VALUES (?, ?, ?, ?)
    `).run(base.candidateRef, base.programId, base.projectRef, stableJson(base.head));
  }

  loadPlanningBase(candidateRef: string): ProjectPlanningBase | null {
    const row = this.db.query<{
      program_id: string;
      project_ref: string;
      head_json: string;
    }, [string]>(`
      SELECT program_id, project_ref, head_json
      FROM btcc_project_planning_bases WHERE candidate_ref = ?
    `).get(candidateRef);
    return row ? {
      candidateRef,
      programId: row.program_id,
      projectRef: row.project_ref,
      head: JSON.parse(row.head_json),
    } : null;
  }

  preparePromotionOutbox(input: {
    turnId: string;
    nextRevision: number;
    commit: WorkLedgerCommit;
    publication: PreparedProjectLedgerPublication;
  }): void {
    const outboxId = digest(
      `btcc-ledger-promotion-outbox.v1\0${input.turnId}\0${input.nextRevision}` +
      `\0${input.commit.mutationId}\0${input.publication.manifestSha256}`,
    );
    this.db.query(`
      INSERT INTO btcc_ledger_promotion_outbox (
        outbox_id, turn_id, committed_turn_revision, mutation_id,
        ledger_id, program_id, publication_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      outboxId,
      input.turnId,
      input.nextRevision,
      input.commit.mutationId,
      input.publication.ledgerId,
      input.publication.programId,
      stableJson(input.publication),
    );
  }

  projectProgramProjection(input: {
    projectRef: string;
    program: BtccPersistenceTypes["managedProgramState"];
  }): void {
    this.db.query(`
      INSERT INTO btcc_project_program_projections (
        program_id, project_ref, ledger_id, manifest_revision
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(program_id) DO UPDATE SET
        project_ref = excluded.project_ref,
        ledger_id = excluded.ledger_id,
        manifest_revision = excluded.manifest_revision
    `).run(
      input.program.programId,
      input.projectRef,
      input.program.ledgerId,
      input.program.manifestRevision,
    );
  }

  loadPending(turnId: string): PendingProjectLedgerPromotion | null {
    const row = this.db.query<{
      outbox_id: string;
      publication_json: string;
      status: "pending" | "observed";
    }, [string]>(`
      SELECT outbox_id, publication_json, status
      FROM btcc_ledger_promotion_outbox WHERE turn_id = ?
      ORDER BY committed_turn_revision DESC LIMIT 1
    `).get(turnId);
    return row ? {
      outboxId: row.outbox_id,
      publication: JSON.parse(row.publication_json),
      status: row.status,
    } : null;
  }

  listPending(): Array<PendingProjectLedgerPromotion & { turnId: string }> {
    const rows = this.db.query<{
      turn_id: string;
      outbox_id: string;
      publication_json: string;
      status: "pending";
    }, []>(`
      SELECT turn_id, outbox_id, publication_json, status
      FROM btcc_ledger_promotion_outbox WHERE status = 'pending'
      ORDER BY committed_turn_revision, outbox_id
    `).all();
    return rows.map((row) => ({
      turnId: row.turn_id,
      outboxId: row.outbox_id,
      publication: JSON.parse(row.publication_json),
      status: row.status,
    }));
  }

  referencedPublicationIds(): string[] {
    const rows = this.db.query<{ publication_json: string }, []>(`
      SELECT publication_json FROM btcc_ledger_promotion_outbox ORDER BY outbox_id
    `).all();
    return rows.map((row) => {
      const publication = JSON.parse(row.publication_json) as PreparedProjectLedgerPublication;
      return publication.corePublication.publicationId;
    });
  }

  observe(outboxId: string): void {
    const updated = this.db.query(`
      UPDATE btcc_ledger_promotion_outbox SET status = 'observed'
      WHERE outbox_id = ? AND status = 'pending'
    `).run(outboxId);
    if (updated.changes !== 1) {
      const current = this.db.query<{ status: string }, [string]>(`
        SELECT status FROM btcc_ledger_promotion_outbox WHERE outbox_id = ?
      `).get(outboxId);
      if (current?.status !== "observed") {
        throw new Error("Project Ledger promotion Outbox disappeared");
      }
    }
  }
}
