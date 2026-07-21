import type { Database } from "bun:sqlite";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
} from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import type { BtccPersistenceTypes } from "../../../btcc/gateway-api.ts";

type TurnAdmissionRepository = BtccRuntimeDependencies["admission"];
type TurnStateRepository = BtccRuntimeDependencies["turns"];
type AdmissionInbox = Awaited<ReturnType<TurnAdmissionRepository["recordInbound"]>>;
type AdmissionConstructionClaim = Awaited<
  ReturnType<TurnAdmissionRepository["acquireAdmissionConstructionClaim"]>
>;
type TurnRecord = NonNullable<Awaited<ReturnType<TurnStateRepository["findTurn"]>>>;
type DeferredContinuationCandidate = BtccPersistenceTypes["deferredContinuationCandidate"];

type InboxRow = {
  inbox_id: string;
  turn_id: string;
  admission_input_hash: string;
  status: "recorded" | "constructed";
  command_json: string;
};

export class SqliteTurnAdmissionRepository implements TurnAdmissionRepository {
  private readonly records: SqliteImmutableRecordStore;

  constructor(
    private readonly db: Database,
    private readonly turns: TurnStateRepository,
    private readonly ownerId: string,
  ) {
    this.records = new SqliteImmutableRecordStore(db);
  }

  async recordInbound(input: {
    command: Extract<BtccTurnCommand, { kind: "run" }>;
    admissionInputHash: string;
  }): Promise<AdmissionInbox> {
    const transaction = this.db.transaction(() => {
      const existing = this.findInbox(input.command.sessionId, input.command.triggerKey);
      if (existing) {
        if (existing.admission_input_hash !== input.admissionInputHash) {
          throw new Error("BTCC admission key conflict");
        }
        return hydrateInbox(existing);
      }
      const inboxId = digest(
        `btcc-inbox.v1\0${input.command.sessionId}\0${input.command.triggerKey}`,
      );
      this.insertCanonicalUserMessage(input.command);
      this.db.query(`
        INSERT INTO btcc_inbound_inbox (
          inbox_id, session_id, trigger_key, turn_id,
          admission_input_hash, command_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'recorded')
      `).run(
        inboxId,
        input.command.sessionId,
        input.command.triggerKey,
        input.command.turnId,
        input.admissionInputHash,
        stableJson(input.command),
      );
      return {
        inboxId,
        turnId: input.command.turnId,
        admissionInputHash: input.admissionInputHash,
        status: "recorded" as const,
      };
    });
    return transaction() as AdmissionInbox;
  }

  async acquireAdmissionConstructionClaim(
    inbox: AdmissionInbox,
  ): Promise<AdmissionConstructionClaim> {
    const claimId = digest(`btcc-admission-claim.v1\0${inbox.inboxId}`);
    this.db.query(`
      INSERT OR IGNORE INTO btcc_admission_claims (
        claim_id, inbox_id, owner_id, owner_generation, lease_generation, status
      ) VALUES (?, ?, ?, 1, 1, 'active')
    `).run(claimId, inbox.inboxId, this.ownerId);
    const row = this.db.query<{ status: string; owner_id: string }, [string]>(`
      SELECT status, owner_id FROM btcc_admission_claims WHERE claim_id = ?
    `).get(claimId);
    if (row?.status !== "active" || row.owner_id !== this.ownerId) {
      throw new Error("BTCC Admission is not actively owned by this runtime");
    }
    return { claimId, inboxId: inbox.inboxId };
  }

  async constructTurn(
    inbox: AdmissionInbox,
    claim: AdmissionConstructionClaim,
  ): Promise<TurnRecord> {
    const transaction = this.db.transaction(() => {
      const stored = this.db.query<InboxRow, [string]>(`
        SELECT inbox_id, turn_id, admission_input_hash, status, command_json
        FROM btcc_inbound_inbox WHERE inbox_id = ?
      `).get(inbox.inboxId);
      const claimRow = this.db.query<{ status: string }, [string, string]>(`
        SELECT status FROM btcc_admission_claims WHERE claim_id = ? AND inbox_id = ?
      `).get(claim.claimId, inbox.inboxId);
      if (!stored || claimRow?.status !== "active") {
        throw new Error("BTCC Turn construction lacks its exact Admission claim");
      }
      const existing = this.db.query<{ turn_id: string; inbox_id: string }, [string]>(`
        SELECT turn_id, inbox_id FROM btcc_turns WHERE turn_id = ?
      `).get(stored.turn_id);
      if (existing && existing.inbox_id !== inbox.inboxId) {
        throw new Error("BTCC Turn id is already owned by another Admission Inbox");
      }
      if (!existing) this.insertInitialTurn(inbox.inboxId, stored.command_json);
      this.db.query("UPDATE btcc_admission_claims SET status = 'consumed' WHERE claim_id = ?")
        .run(claim.claimId);
      this.db.query("UPDATE btcc_inbound_inbox SET status = 'constructed' WHERE inbox_id = ?")
        .run(inbox.inboxId);
      return stored.turn_id;
    });
    const turnId = transaction() as string;
    const turn = await this.turns.findTurn(turnId);
    if (!turn) throw new Error("BTCC Turn construction did not persist a Turn");
    return turn;
  }

  private insertInitialTurn(inboxId: string, commandJson: string): void {
    const command = JSON.parse(commandJson) as Extract<
      BtccTurnCommand,
      { kind: "run" }
    >;
    const continuationCandidates = this.discoverContinuationCandidates(command);
    const contextJson = stableJson(command.context);
    const snapshotJson = stableJson({
      context: command.context,
      continuationCandidates,
    });
    const snapshotSha = digest(snapshotJson);
    const snapshotRef = digest(`btcc-admission-snapshot.v1\0${snapshotSha}`);
    const checkpointId = digest(`btcc-checkpoint.v1\0${command.turnId}\0${0}\0admitted`);
    this.records.insert(snapshotRef, "admission_snapshot", snapshotSha, snapshotJson);
    this.db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, continuation_snapshot_json, semantic_state,
        active_checkpoint_id, revision, execution_fence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, 0, 0)
    `).run(
      command.turnId,
      command.sessionId,
      inboxId,
      command.triggerKey,
      command.message.messageId,
      command.message.content,
      snapshotRef,
      stableJson(command.modelSelection),
      contextJson,
      stableJson(continuationCandidates),
      checkpointId,
    );
    this.db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, 0, 'admitted', 'runtime', 1, 1)
    `).run(checkpointId, command.turnId);
  }

  private discoverContinuationCandidates(
    command: Extract<BtccTurnCommand, { kind: "run" }>,
  ): DeferredContinuationCandidate[] {
    type CandidateRow = {
      ledger_id: string;
      program_id: string;
      manifest_revision: number;
      goal_contract_ref: string;
      active_deferral_ref: string;
      active_deferral_turn_id: string;
    };
    const scopeKind = command.context.projectRef ? "project" : "session";
    const scopeId = command.context.projectRef ?? command.sessionId;
    const rows = this.db.query<CandidateRow, [string, string]>(`
      SELECT p.ledger_id, p.program_id, p.manifest_revision,
        p.goal_contract_ref, p.active_deferral_ref, p.active_deferral_turn_id
      FROM btcc_programs p
      JOIN btcc_turns t ON t.turn_id = p.active_deferral_turn_id
      WHERE p.scope_kind = ? AND p.scope_id = ?
        AND p.active_deferral_ref IS NOT NULL
        AND t.semantic_state = 'delivered' AND t.final_disposition = 'deferred'
      ORDER BY p.program_id
    `).all(scopeKind, scopeId);
    return rows.map((row) => {
      const anchor = this.loadRecord<{ blockerRef: { id: string; sha256: string } }>(
        row.active_deferral_ref,
      );
      const originalGoalContractRef = this.loadRef(row.goal_contract_ref);
      const anchorRef = this.loadRef(row.active_deferral_ref);
      const candidateBody = {
        ledgerId: row.ledger_id,
        programId: row.program_id,
        expectedManifestRevision: row.manifest_revision,
        sourceTurnId: row.active_deferral_turn_id,
        originalGoalContractRef,
        anchorRef,
        blockerRef: anchor.blockerRef,
      };
      return {
        candidateId: digest(`btcc-continuation-candidate.v1\0${stableJson(candidateBody)}`),
        ...candidateBody,
      };
    });
  }

  private loadRef(id: string): { id: string; sha256: string } {
    const row = this.db.query<{ sha256: string }, [string]>(
      "SELECT sha256 FROM btcc_records WHERE record_id = ?",
    ).get(id);
    if (!row) throw new Error(`BTCC continuation record is missing: ${id}`);
    return { id, sha256: row.sha256 };
  }

  private loadRecord<T>(id: string): T {
    const row = this.db.query<{ content_json: string }, [string]>(
      "SELECT content_json FROM btcc_records WHERE record_id = ?",
    ).get(id);
    if (!row) throw new Error(`BTCC continuation record is missing: ${id}`);
    return JSON.parse(row.content_json) as T;
  }

  private insertCanonicalUserMessage(
    command: Extract<BtccTurnCommand, { kind: "run" }>,
  ): void {
    const existing = this.db.query<{ content: string }, [string]>(`
      SELECT content FROM btcc_messages WHERE message_id = ?
    `).get(command.message.messageId);
    if (existing && existing.content !== command.message.content) {
      throw new Error("BTCC canonical user message identity conflict");
    }
    if (!existing) {
      this.db.query(`
        INSERT INTO btcc_messages (
          message_id, session_id, turn_id, role, content, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'user', ?, ?, ?)
      `).run(
        command.message.messageId,
        command.sessionId,
        command.turnId,
        command.message.content,
        `inbound:${command.sessionId}:${command.triggerKey}`,
        new Date().toISOString(),
      );
    }
  }

  private findInbox(sessionId: string, triggerKey: string): InboxRow | null {
    return this.db.query<InboxRow, [string, string]>(`
      SELECT inbox_id, turn_id, admission_input_hash, status, command_json
      FROM btcc_inbound_inbox WHERE session_id = ? AND trigger_key = ?
    `).get(sessionId, triggerKey) ?? null;
  }
}

function hydrateInbox(row: InboxRow): AdmissionInbox {
  return {
    inboxId: row.inbox_id,
    turnId: row.turn_id,
    admissionInputHash: row.admission_input_hash,
    status: row.status,
  };
}
