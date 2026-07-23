import type { Database } from "bun:sqlite";
import type {
  BtccRuntimeDependencies,
  FreshBtccTurnCommand,
} from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import type { ProjectWorkLedgerPublicationAdapter } from "../project-ledger/index.ts";
import { discoverDeferredContinuationCandidates } from
  "./continuation-candidate-discovery.ts";
import { SqliteAdmissionConstructionClaims } from "./admission-construction-claims.ts";
import type { RuntimeOwnerAuthority } from "./runtime-owner/index.ts";

type TurnAdmissionRepository = BtccRuntimeDependencies["admission"];
type TurnStateRepository = BtccRuntimeDependencies["turns"];
type AdmissionInbox = Awaited<ReturnType<TurnAdmissionRepository["recordInbound"]>>;
type AdmissionConstructionClaim = Awaited<
  ReturnType<TurnAdmissionRepository["acquireAdmissionConstructionClaim"]>
>;
type TurnRecord = NonNullable<Awaited<ReturnType<TurnStateRepository["findTurn"]>>>;
type InboxRow = {
  inbox_id: string;
  turn_id: string;
  admission_input_hash: string;
  status: "recorded" | "constructed";
  command_json: string;
};

export class SqliteTurnAdmissionRepository implements TurnAdmissionRepository {
  private readonly records: SqliteImmutableRecordStore;
  private readonly constructionClaims: SqliteAdmissionConstructionClaims;

  constructor(
    private readonly db: Database,
    private readonly turns: TurnStateRepository,
    owner: RuntimeOwnerAuthority,
    private readonly projectLedger?: {
      publications: ProjectWorkLedgerPublicationAdapter;
      resolveProjectRoot(projectRef: string): string;
    },
  ) {
    this.records = new SqliteImmutableRecordStore(db);
    this.constructionClaims = new SqliteAdmissionConstructionClaims(db, owner);
  }

  async recordInbound(input: {
    command: FreshBtccTurnCommand;
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
    const command = this.loadCommand(inbox.inboxId);
    const continuationCandidates = await discoverDeferredContinuationCandidates(
      this.db,
      command,
      this.projectLedger,
    );
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
        this.insertInitialTurn(inbox.inboxId, stored.command_json, continuationCandidates);
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
    continuationCandidates: TurnRecord["continuationCandidates"],
  ): void {
    const command = JSON.parse(commandJson) as FreshBtccTurnCommand;
    const source = command.kind === "run"
      ? command.message
      : { messageId: command.trigger.triggerId, content: command.trigger.content };
    const contextJson = stableJson(command.context);
    const snapshotJson = stableJson({
      context: command.context,
      continuationCandidates,
    });
    const snapshotSha = digest(snapshotJson);
    const snapshotRef = digest(`btcc-admission-snapshot.v1\0${snapshotSha}`);
    const checkpointId = digest(`btcc-checkpoint.v1\0${command.turnId}\0${0}\0admitted`);
    const stoppedBeforeAdmission = this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_stop_requests WHERE turn_id = ?
    `).get(command.turnId)?.status === "cancelled_before_admission";
    this.records.insert(snapshotRef, "admission_snapshot", snapshotSha, snapshotJson);
    this.db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, continuation_snapshot_json, semantic_state,
        active_checkpoint_id, revision, execution_fence, final_disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      command.turnId,
      command.sessionId,
      inboxId,
      command.triggerKey,
      source.messageId,
      source.content,
      snapshotRef,
      stableJson(command.modelSelection),
      contextJson,
      stableJson(continuationCandidates),
      stoppedBeforeAdmission ? "cancelled" : "admitted",
      stoppedBeforeAdmission ? null : checkpointId,
      stoppedBeforeAdmission ? 1 : 0,
      stoppedBeforeAdmission ? "cancelled" : null,
    );
    if (stoppedBeforeAdmission) return;
    this.db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, 0, 'admitted', 'runtime', 1, 1)
    `).run(checkpointId, command.turnId);
  }

  private loadCommand(inboxId: string): FreshBtccTurnCommand {
    const row = this.db.query<{ command_json: string }, [string]>(`
      SELECT command_json FROM btcc_inbound_inbox WHERE inbox_id = ?
    `).get(inboxId);
    if (!row) throw new Error("BTCC Admission Inbox disappeared before construction");
    return JSON.parse(row.command_json) as FreshBtccTurnCommand;
  }

  private insertCanonicalTrigger(command: FreshBtccTurnCommand): void {
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
}

function hydrateInbox(row: InboxRow): AdmissionInbox {
  return {
    inboxId: row.inbox_id,
    turnId: row.turn_id,
    admissionInputHash: row.admission_input_hash,
    status: row.status,
  };
}
