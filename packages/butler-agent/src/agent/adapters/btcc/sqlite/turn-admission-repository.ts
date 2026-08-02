import type { Database } from "bun:sqlite";
import type {
  AdmissionConstructionClaim,
  AdmissionInbox,
  TurnAdmissionRepository,
  TurnRecord,
  TurnStateRepository,
} from "../../../btcc/turn/index.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import { SqliteAdmissionConstructionClaims } from "./admission-construction-claims.ts";
import type { RuntimeOwnerAuthority } from "./runtime-owner/index.ts";

type InboxRow = {
  inbox_id: string;
  turn_id: string;
  admission_input_hash: string;
  status: "recorded" | "constructed";
  command_json: string;
};

type RecordInboundInput = Parameters<TurnAdmissionRepository["recordInbound"]>[0];
type FreshTurnCommand = RecordInboundInput["command"];

export class SqliteTurnAdmissionRepository implements TurnAdmissionRepository {
  private readonly records: SqliteImmutableRecordStore;
  private readonly constructionClaims: SqliteAdmissionConstructionClaims;

  constructor(
    private readonly db: Database,
    private readonly turns: TurnStateRepository,
    owner: RuntimeOwnerAuthority,
  ) {
    this.records = new SqliteImmutableRecordStore(db);
    this.constructionClaims = new SqliteAdmissionConstructionClaims(db, owner);
  }

  async recordInbound(input: RecordInboundInput): Promise<AdmissionInbox> {
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
      this.insertCanonicalTrigger(input.command);
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
    return this.constructionClaims.acquire(inbox.inboxId);
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
      if (!existing) {
        this.insertInitialTurn(inbox.inboxId, stored.command_json);
      }
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

  private insertInitialTurn(
    inboxId: string,
    commandJson: string,
  ): void {
    const command = JSON.parse(commandJson) as FreshTurnCommand;
    const source = command.kind === "run"
      ? command.message
      : { messageId: command.trigger.triggerId, content: command.trigger.content };
    const contextJson = stableJson(command.context);
    const snapshotJson = stableJson({
      context: command.context,
    });
    const snapshotSha = digest(snapshotJson);
    const snapshotRef = digest(`btcc-admission-snapshot.v1\0${snapshotSha}`);
    const checkpointId = digest(`btcc-checkpoint.v1\0${command.turnId}\0${0}\0admitted`);
    const stoppedBeforeAdmission = this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_stop_requests WHERE turn_id = ?
    `).get(command.turnId)?.status === "cancelled_before_admission";
    this.records.insert(snapshotRef, "admission_snapshot", snapshotSha, snapshotJson);
    const commonValues = [
      command.turnId,
      command.sessionId,
      inboxId,
      command.triggerKey,
      source.messageId,
      source.content,
      snapshotRef,
      stableJson(command.modelSelection),
      contextJson,
      command.progressDestination ? stableJson(command.progressDestination) : null,
      stoppedBeforeAdmission ? "cancelled" : "admitted",
      stoppedBeforeAdmission ? null : checkpointId,
      stoppedBeforeAdmission ? 1 : 0,
      stoppedBeforeAdmission ? "cancelled" : null,
    ] as const;
    if (this.hasTurnColumn("continuation_snapshot_json")) {
      this.db.query(`
        INSERT INTO btcc_turns (
          turn_id, session_id, inbox_id, trigger_key, original_message_id,
          original_message, admission_snapshot_ref, model_selection_json,
          context_json, progress_destination_json, semantic_state,
          active_checkpoint_id, execution_fence,
          final_disposition, continuation_snapshot_json, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)
      `).run(...commonValues);
    } else {
      this.db.query(`
        INSERT INTO btcc_turns (
          turn_id, session_id, inbox_id, trigger_key, original_message_id,
          original_message, admission_snapshot_ref, model_selection_json,
          context_json, progress_destination_json, semantic_state,
          active_checkpoint_id, execution_fence,
          final_disposition, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(...commonValues);
    }
    if (stoppedBeforeAdmission) return;
    this.db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, 0, 'admitted', 'runtime', 1, 1)
    `).run(checkpointId, command.turnId);
  }

  private insertCanonicalTrigger(command: FreshTurnCommand): void {
    if (command.kind === "wake") {
      const existing = this.db.query<{ content: string }, [string]>(`
        SELECT content FROM btcc_continuation_triggers WHERE trigger_id = ?
      `).get(command.trigger.triggerId);
      if (existing && existing.content !== command.trigger.content) {
        throw new Error("BTCC continuation trigger identity conflict");
      }
      if (!existing) {
        this.db.query(`
          INSERT INTO btcc_continuation_triggers (
            trigger_id, session_id, turn_id, source_turn_id, authorization_ref,
            content, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          command.trigger.triggerId,
          command.sessionId,
          command.turnId,
          command.trigger.sourceTurnId,
          command.trigger.authorizationRef,
          command.trigger.content,
          `wake:${command.sessionId}:${command.triggerKey}`,
          new Date().toISOString(),
        );
      }
      this.insertWakeRequestFact(command);
      return;
    }
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

  private insertWakeRequestFact(
    command: Extract<FreshTurnCommand, { kind: "wake" }>,
  ): void {
    const resultScopeRef = command.trigger.resultScopeRef ?? "";
    const existing = this.db.query<{
      turn_id: string;
      trigger_id: string;
      source_turn_id: string;
      authorization_ref: string;
      result_scope_ref: string;
      content: string;
    }, [string]>(`
      SELECT turn_id, trigger_id, source_turn_id, authorization_ref,
        result_scope_ref, content
      FROM btcc_wake_request_facts WHERE turn_id = ?
    `).get(command.turnId);
    if (existing) {
      if (
        existing.trigger_id !== command.trigger.triggerId ||
        existing.source_turn_id !== command.trigger.sourceTurnId ||
        existing.authorization_ref !== command.trigger.authorizationRef ||
        existing.result_scope_ref !== resultScopeRef ||
        existing.content !== command.trigger.content
      ) {
        throw new Error("BTCC wake request identity conflict");
      }
      return;
    }
    const triggerOwner = this.db.query<{ turn_id: string }, [string]>(`
      SELECT turn_id FROM btcc_wake_request_facts WHERE trigger_id = ?
    `).get(command.trigger.triggerId);
    if (triggerOwner && triggerOwner.turn_id !== command.turnId) {
      throw new Error("BTCC wake trigger identity conflict");
    }
    this.db.query(`
      INSERT INTO btcc_wake_request_facts (
        turn_id, session_id, trigger_key, trigger_id, source_turn_id,
        authorization_ref, result_scope_ref, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.turnId,
      command.sessionId,
      command.triggerKey,
      command.trigger.triggerId,
      command.trigger.sourceTurnId,
      command.trigger.authorizationRef,
      resultScopeRef,
      command.trigger.content,
      new Date().toISOString(),
    );
  }

  private hasTurnColumn(name: string): boolean {
    return this.db.query<{ name: string }, []>(
      "PRAGMA table_info(btcc_turns)",
    ).all().some((column) => column.name === name);
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
