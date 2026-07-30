import type { Database } from "bun:sqlite";
import type {
  BtccRuntimeDependencies,
  WorkLedger,
} from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import { SqliteManagedTransitionWriter } from "./managed-transition-writer.ts";
import type { ProjectLedgerBoundaryContext } from "./project-ledger-promotion-writer.ts";

type TurnStateRepository = BtccRuntimeDependencies["turns"];
type CommitInput = Parameters<TurnStateRepository["commitTransition"]>[0];
type AcceptedTurnTransition = CommitInput["transition"];
type StateExecutionClaim = CommitInput["claim"];
type TurnRecord = CommitInput["turn"];
type TurnCheckpoint = NonNullable<TurnRecord["checkpoint"]>;
type TurnSemanticState = TurnRecord["semanticState"];

export class SqliteTransitionWriter {
  private readonly records: SqliteImmutableRecordStore;
  private readonly managed: SqliteManagedTransitionWriter;

  constructor(
    private readonly db: Database,
    workLedger: WorkLedger,
  ) {
    this.records = new SqliteImmutableRecordStore(db);
    this.managed = new SqliteManagedTransitionWriter(db, workLedger);
  }

  commit(input: CommitInput, projectLedger: ProjectLedgerBoundaryContext = {}): void {
    const transaction = this.db.transaction(() => {
      this.assertCurrentClaim(input.turn, input.claim);
      this.consumeClaim(input.claim);
      const nextRevision = input.turn.revision + 1;

      switch (input.transition.kind) {
        case "accept_guided_final":
          this.acceptGuidedFinal(input.turn, nextRevision, input.transition);
          return;
        case "activate_opening":
          this.advanceWithCheckpoint(input.turn, nextRevision, input.transition);
          return;
        case "accept_opening_answer":
          this.acceptOpeningAnswer(input.turn, nextRevision, input.transition);
          return;
        case "accept_opening_continuation":
          this.acceptOpeningContinuation(input.turn, nextRevision, input.transition);
          return;
        case "observe_delivery":
          this.observeDelivery(input.turn, nextRevision, input.transition);
          return;
        default:
          this.managed.commit(input.turn, nextRevision, input.transition, projectLedger);
          return;
      }
    });
    transaction();
  }

  private acceptGuidedFinal(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<AcceptedTurnTransition, { kind: "accept_guided_final" }>,
  ): void {
    this.records.insert(
      transition.finalPayload.ref.id,
      "final_payload",
      transition.finalPayload.ref.sha256,
      stableJson(transition.finalPayload),
    );
    const outbox = transition.deliveryOutbox;
    this.db.query(`
      INSERT INTO btcc_delivery_outbox (
        outbox_id, turn_id, committed_turn_revision, payload_id, payload_sha256,
        expected_message_id, content, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      outbox.outboxId,
      turn.turnId,
      nextRevision,
      outbox.finalPayloadRef.id,
      outbox.finalPayloadRef.sha256,
      outbox.expectedMessageId,
      outbox.content,
    );
    const checkpoint = checkpointFor(
      turn.turnId,
      nextRevision,
      transition.successor,
      transition.successorCheckpointKind,
    );
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?,
        route = ?, final_payload_json = ?, delivery_outbox_id = ?,
        revision = ?, final_disposition = 'completed'
      WHERE turn_id = ? AND revision = ?
    `).run(
      transition.successor,
      checkpoint.checkpointId,
      transition.route,
      stableJson(transition.finalPayload),
      outbox.outboxId,
      nextRevision,
      turn.turnId,
      turn.revision,
    );
    if (updated.changes !== 1) throw new Error("BTCC Guided final commit lost Turn CAS");
    this.insertCheckpoint(turn.turnId, nextRevision, checkpoint);
  }

  private acceptOpeningAnswer(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<AcceptedTurnTransition, { kind: "accept_opening_answer" }>,
  ): void {
    this.insertProductRecords(transition.product);
    const outbox = transition.deliveryOutbox;
    this.db.query(`
      INSERT INTO btcc_delivery_outbox (
        outbox_id, turn_id, committed_turn_revision, payload_id, payload_sha256,
        expected_message_id, content, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      outbox.outboxId,
      turn.turnId,
      nextRevision,
      outbox.finalPayloadRef.id,
      outbox.finalPayloadRef.sha256,
      outbox.expectedMessageId,
      outbox.content,
    );
    const checkpoint = checkpointFor(
      turn.turnId,
      nextRevision,
      transition.successor,
      transition.successorCheckpointKind,
    );
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?,
        route = ?, opening_answer_json = ?, final_payload_json = ?,
        delivery_outbox_id = ?, revision = ?, final_disposition = 'completed'
      WHERE turn_id = ? AND revision = ?
    `).run(
      transition.successor,
      checkpoint.checkpointId,
      transition.product.route,
      stableJson(transition.product),
      stableJson(transition.product.finalPayload),
      outbox.outboxId,
      nextRevision,
      turn.turnId,
      turn.revision,
    );
    if (updated.changes !== 1) throw new Error("BTCC Opening commit lost Turn CAS");
    this.insertCheckpoint(turn.turnId, nextRevision, checkpoint);
  }

  private acceptOpeningContinuation(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<AcceptedTurnTransition, { kind: "accept_opening_continuation" }>,
  ): void {
    const projection = transition.product.projection;
    this.records.insert(
      projection.ref.id,
      "opening_projection",
      projection.ref.sha256,
      stableJson(projection),
    );
    this.db.query(`
      INSERT INTO btcc_opening_projections (
        turn_id, projection_ref, content, content_sha256
      ) VALUES (?, ?, ?, ?)
    `).run(
      turn.turnId,
      projection.ref.id,
      projection.summary,
      projection.contentSha256,
    );
    const checkpoint = checkpointFor(
      turn.turnId,
      nextRevision,
      transition.successor,
      "phase",
    );
    const managed = transition.product.route === "managed"
      ? stableJson({ opening: transition.product })
      : null;
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?,
        route = ?, managed_state_json = ?, revision = ?
      WHERE turn_id = ? AND revision = ?
    `).run(
      transition.successor,
      checkpoint.checkpointId,
      transition.product.route,
      managed,
      nextRevision,
      turn.turnId,
      turn.revision,
    );
    if (updated.changes !== 1) throw new Error("BTCC Opening continuation lost Turn CAS");
    this.insertCheckpoint(turn.turnId, nextRevision, checkpoint);
  }

  private observeDelivery(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<AcceptedTurnTransition, { kind: "observe_delivery" }>,
  ): void {
    if (!turn.deliveryOutbox) {
      throw new Error("BTCC delivery observation has no Outbox");
    }
    const observed = this.db.query<{ status: string }, [string, string]>(`
      SELECT status FROM btcc_delivery_outbox
      WHERE outbox_id = ? AND expected_message_id = ?
    `).get(turn.deliveryOutbox.outboxId, transition.assistantMessageId);
    if (observed?.status !== "inserted") {
      throw new Error("BTCC DeliveryObserved has no inserted canonical message");
    }
    this.db.query(`
      UPDATE btcc_delivery_outbox SET status = 'observed' WHERE outbox_id = ?
    `).run(turn.deliveryOutbox.outboxId);
    const updated = this.db.query<{ turn_id: string }, [
      string,
      number,
      string,
      number,
    ]>(`
      UPDATE btcc_turns SET semantic_state = 'delivered', active_checkpoint_id = NULL,
        canonical_assistant_message_id = ?, revision = ?
      WHERE turn_id = ? AND revision = ?
      RETURNING turn_id
    `).get(transition.assistantMessageId, nextRevision, turn.turnId, turn.revision);
    if (updated?.turn_id !== turn.turnId) {
      throw new Error("BTCC Delivery commit lost Turn CAS");
    }
  }

  private advanceWithCheckpoint(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<AcceptedTurnTransition, { kind: "activate_opening" }>,
  ): void {
    const checkpoint = checkpointFor(
      turn.turnId,
      nextRevision,
      transition.successor,
      transition.successorCheckpointKind,
    );
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?, revision = ?
      WHERE turn_id = ? AND revision = ?
    `).run(transition.successor, checkpoint.checkpointId, nextRevision, turn.turnId, turn.revision);
    if (updated.changes !== 1) throw new Error("BTCC activation commit lost Turn CAS");
    this.insertCheckpoint(turn.turnId, nextRevision, checkpoint);
  }

  private consumeClaim(claim: StateExecutionClaim): void {
    const consumed = this.db.query(`
      UPDATE btcc_state_claims SET status = 'consumed'
      WHERE claim_id = ? AND status = 'active'
    `).run(claim.claimId);
    if (consumed.changes !== 1) throw new Error("BTCC transition claim was not active");
    this.db.query(`
      UPDATE btcc_checkpoints SET is_active = 0 WHERE checkpoint_id = ? AND is_active = 1
    `).run(claim.checkpointId);
  }

  private assertCurrentClaim(turn: TurnRecord, claim: StateExecutionClaim): void {
    const current = this.db.query<{
      semantic_state: string;
      revision: number;
      active_checkpoint_id: string;
    }, [string]>(`
      SELECT semantic_state, revision, active_checkpoint_id FROM btcc_turns WHERE turn_id = ?
    `).get(turn.turnId);
    const owned = this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_state_claims WHERE claim_id = ?
    `).get(claim.claimId);
    if (
      !current ||
      current.semantic_state !== turn.semanticState ||
      current.revision !== turn.revision ||
      current.active_checkpoint_id !== claim.checkpointId ||
      owned?.status !== "active"
    ) {
      throw new Error("BTCC transition lost its exact Turn claim");
    }
  }

  private insertCheckpoint(
    turnId: string,
    turnRevision: number,
    checkpoint: TurnCheckpoint,
  ): void {
    this.db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      checkpoint.checkpointId,
      turnId,
      turnRevision,
      checkpoint.semanticState,
      checkpoint.kind,
      checkpoint.checkpointRevision,
    );
  }

  private insertProductRecords(
    product: Extract<
      AcceptedTurnTransition,
      { kind: "accept_opening_answer" }
    >["product"],
  ): void {
    const records = [
      [product.goalContract.ref, "goal_contract", product.goalContract],
      [product.authority.ref, "authority_revision", product.authority],
      [product.outputDraft.ref, "output_draft", product.outputDraft],
      [product.finalPayload.ref, "final_payload", product.finalPayload],
    ] as const;
    for (const [ref, kind, value] of records) {
      this.records.insert(ref.id, kind, ref.sha256, stableJson(value));
    }
  }
}

function checkpointFor(
  turnId: string,
  turnRevision: number,
  semanticState: TurnSemanticState,
  kind: "runtime" | "phase",
): TurnCheckpoint {
  return {
    checkpointId: digest(`btcc-checkpoint.v1\0${turnId}\0${turnRevision}\0${semanticState}`),
    checkpointRevision: 1,
    kind,
    semanticState,
  };
}
