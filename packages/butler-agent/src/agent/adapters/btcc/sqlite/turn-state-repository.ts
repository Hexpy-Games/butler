import type { Database } from "bun:sqlite";
import type {
  BtccRuntimeDependencies,
} from "../../../btcc/gateway-api.ts";
import { createWorkLedger, type WorkLedger } from "../../../btcc/gateway-api.ts";
import { digest } from "./identity.ts";
import { SqliteTransitionWriter } from "./transition-writer.ts";
import { SqliteWorkLedgerStorage } from "./work-ledger/index.ts";
import { SqliteStopController } from "./sqlite-stop-controller.ts";

type TurnStateRepository = BtccRuntimeDependencies["turns"];
type TurnRecord = NonNullable<Awaited<ReturnType<TurnStateRepository["findTurn"]>>>;
type StateExecutionClaim = Awaited<
  ReturnType<TurnStateRepository["acquireStateExecutionClaim"]>
>;
type CommitInput = Parameters<TurnStateRepository["commitTransition"]>[0];
type TurnCheckpoint = NonNullable<TurnRecord["checkpoint"]>;
type TurnSemanticState = TurnRecord["semanticState"];

type TurnRow = {
  turn_id: string;
  session_id: string;
  inbox_id: string;
  trigger_key: string;
  original_message_id: string;
  original_message: string;
  model_selection_json: string;
  context_json: string;
  continuation_snapshot_json: string;
  semantic_state: string;
  active_checkpoint_id: string | null;
  route: string | null;
  opening_answer_json: string | null;
  managed_state_json: string | null;
  final_payload_json: string | null;
  delivery_outbox_id: string | null;
  canonical_assistant_message_id: string | null;
  revision: number;
  execution_fence: number;
  final_disposition: string | null;
};

type CheckpointRow = {
  checkpoint_id: string;
  checkpoint_revision: number;
  kind: "runtime" | "phase";
  semantic_state: string;
};

export class SqliteTurnStateRepository implements TurnStateRepository {
  private readonly transitions: SqliteTransitionWriter;
  private readonly workLedger: WorkLedger;
  private readonly stops: SqliteStopController;

  constructor(
    private readonly db: Database,
    private readonly ownerId: string,
  ) {
    this.workLedger = createWorkLedger(new SqliteWorkLedgerStorage(db));
    this.transitions = new SqliteTransitionWriter(db, this.workLedger);
    this.stops = new SqliteStopController(db);
  }

  async findTurn(turnId: string): Promise<TurnRecord | null> {
    const row = this.db.query<TurnRow, [string]>(`
      SELECT * FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    if (!row) return null;
    const checkpoint = row.active_checkpoint_id
      ? this.db.query<CheckpointRow, [string]>(`
          SELECT checkpoint_id, checkpoint_revision, kind, semantic_state
          FROM btcc_checkpoints WHERE checkpoint_id = ? AND is_active = 1
        `).get(row.active_checkpoint_id)
      : null;
    const outbox = row.delivery_outbox_id
      ? this.db.query<{
          outbox_id: string;
          payload_id: string;
          payload_sha256: string;
          expected_message_id: string;
          content: string;
          status: "pending" | "inserted" | "observed";
        }, [string]>("SELECT * FROM btcc_delivery_outbox WHERE outbox_id = ?")
          .get(row.delivery_outbox_id)
      : null;
    const managed = row.managed_state_json
      ? this.reloadManagedProgram(JSON.parse(row.managed_state_json))
      : undefined;
    return {
      turnId: row.turn_id,
      sessionId: row.session_id,
      inboxId: row.inbox_id,
      triggerKey: row.trigger_key,
      originalMessageId: row.original_message_id,
      originalMessage: row.original_message,
      modelSelection: JSON.parse(row.model_selection_json),
      context: JSON.parse(row.context_json),
      continuationCandidates: JSON.parse(row.continuation_snapshot_json),
      semanticState: row.semantic_state as TurnSemanticState,
      ...(checkpoint ? { checkpoint: hydrateCheckpoint(checkpoint) } : {}),
      ...(row.route === "direct" || row.route === "assisted"
        ? { route: row.route }
        : row.route === "managed"
          ? { route: "managed" as const }
          : {}),
      ...(row.opening_answer_json
        ? { openingAnswer: JSON.parse(row.opening_answer_json) }
        : {}),
      ...(managed ? { managed } : {}),
      ...(row.final_payload_json
        ? { finalPayload: JSON.parse(row.final_payload_json) }
        : row.opening_answer_json
          ? { finalPayload: JSON.parse(row.opening_answer_json).finalPayload }
          : {}),
      ...(outbox
        ? {
            deliveryOutbox: {
              outboxId: outbox.outbox_id,
              finalPayloadRef: { id: outbox.payload_id, sha256: outbox.payload_sha256 },
              expectedMessageId: outbox.expected_message_id,
              content: outbox.content,
              status: outbox.status,
            },
          }
        : {}),
      ...(row.canonical_assistant_message_id
        ? { canonicalAssistantMessageId: row.canonical_assistant_message_id }
        : {}),
      revision: row.revision,
      executionFence: row.execution_fence,
      ...(row.final_disposition === "completed" || row.final_disposition === "deferred"
        ? { finalDisposition: row.final_disposition }
        : row.final_disposition === "cancelled"
          ? { finalDisposition: "cancelled" as const }
          : {}),
    };
  }

  async acquireStateExecutionClaim(turn: TurnRecord): Promise<StateExecutionClaim> {
    if (!turn.checkpoint) throw new Error("Nonterminal BTCC Turn has no active checkpoint");
    const claimId = digest(
      `btcc-state-claim.v1\0${turn.turnId}\0${turn.revision}\0${turn.semanticState}\0${turn.checkpoint.checkpointId}`,
    );
    const transaction = this.db.transaction(() => {
      const current = this.db.query<{
        semantic_state: string;
        revision: number;
        execution_fence: number;
        active_checkpoint_id: string;
      }, [string]>(`
        SELECT semantic_state, revision, execution_fence, active_checkpoint_id
        FROM btcc_turns WHERE turn_id = ?
      `).get(turn.turnId);
      if (
        !current ||
        current.semantic_state !== turn.semanticState ||
        current.revision !== turn.revision ||
        current.execution_fence !== turn.executionFence ||
        current.active_checkpoint_id !== turn.checkpoint!.checkpointId
      ) {
        throw new Error("BTCC StateExecutionClaim lost its exact Turn revision");
      }
      this.db.query(`
        INSERT OR IGNORE INTO btcc_state_claims (
          claim_id, turn_id, turn_revision, semantic_state, checkpoint_id,
          checkpoint_revision, execution_fence, owner_id, owner_generation,
          lease_generation, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'active')
      `).run(
        claimId,
        turn.turnId,
        turn.revision,
        turn.semanticState,
        turn.checkpoint!.checkpointId,
        turn.checkpoint!.checkpointRevision,
        turn.executionFence,
        this.ownerId,
      );
      const claim = this.db.query<{ status: string; owner_id: string }, [string]>(`
        SELECT status, owner_id FROM btcc_state_claims WHERE claim_id = ?
      `).get(claimId);
      if (claim?.status !== "active" || claim.owner_id !== this.ownerId) {
        throw new Error("BTCC state is not actively owned by this runtime");
      }
      const checkpoint = this.db.query(`
        UPDATE btcc_checkpoints SET active_claim_id = ?
        WHERE checkpoint_id = ? AND is_active = 1
          AND (active_claim_id IS NULL OR active_claim_id = ?)
      `).run(claimId, turn.checkpoint!.checkpointId, claimId);
      if (checkpoint.changes !== 1) {
        throw new Error("BTCC checkpoint is already claimed by another runtime");
      }
    });
    transaction();
    return {
      claimId,
      turnId: turn.turnId,
      turnRevision: turn.revision,
      semanticState: turn.semanticState,
      checkpointId: turn.checkpoint.checkpointId,
      checkpointRevision: turn.checkpoint.checkpointRevision,
      executionFence: turn.executionFence,
    };
  }

  async commitTransition(input: CommitInput): Promise<void> {
    this.transitions.commit(input);
  }

  async stopTurn(turnId: string) {
    return this.stops.stop(turnId);
  }

  private reloadManagedProgram(
    managed: NonNullable<TurnRecord["managed"]>,
  ): NonNullable<TurnRecord["managed"]> {
    const programId = managed.programId
      ?? managed.program?.programId
      ?? managed.planningAcceptance?.candidate.programId;
    if (!programId) return managed;
    const program = this.workLedger.loadProgram(programId);
    return program ? { ...managed, programId, program } : managed;
  }
}

function hydrateCheckpoint(row: CheckpointRow): TurnCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    checkpointRevision: row.checkpoint_revision,
    kind: row.kind,
    semanticState: row.semantic_state as TurnSemanticState,
  };
}
