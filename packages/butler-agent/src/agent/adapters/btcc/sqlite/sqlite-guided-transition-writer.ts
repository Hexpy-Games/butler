import type { Database } from "bun:sqlite";
import type {
  StateExecutionClaim,
  TurnCheckpoint,
  TurnRecord,
  TurnStateRepository,
} from "../../../btcc/index.ts";
import {
  assertGuidedTurnSemanticState,
  assertGuidedTurnTransition,
  type GuidedTurnSemanticState,
  type GuidedTurnTransition,
} from "./guided-turn-state.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";

type CommitInput = Parameters<TurnStateRepository["commitTransition"]>[0];

export class SqliteGuidedTransitionWriter {
  private readonly records: SqliteImmutableRecordStore;

  constructor(private readonly db: Database) {
    this.records = new SqliteImmutableRecordStore(db);
  }

  commit(input: CommitInput): void {
    const { claim, transition, turn } = input;
    assertGuidedTurnSemanticState(turn.semanticState);
    assertGuidedTurnTransition(transition);
    this.db.transaction(() => {
      this.assertCurrentClaim(turn, claim);
      this.consumeClaim(claim);
      const nextRevision = turn.revision + 1;
      if (transition.kind === "accept_guided_final") {
        this.acceptGuidedFinal(turn, nextRevision, transition);
        return;
      }
      this.observeDelivery(turn, nextRevision, transition);
    })();
  }

  private acceptGuidedFinal(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<GuidedTurnTransition, { kind: "accept_guided_final" }>,
  ): void {
    if (turn.semanticState !== "admitted") {
      throw new Error("BTCC R3 final can only commit from admitted");
    }
    const outbox = transition.deliveryOutbox;
    if (
      transition.successor !== "delivery_committed" ||
      transition.successorCheckpointKind !== "runtime" ||
      outbox.status !== "pending" ||
      outbox.finalPayloadRef.id !== transition.finalPayload.ref.id ||
      outbox.finalPayloadRef.sha256 !== transition.finalPayload.ref.sha256 ||
      outbox.content !== transition.finalPayload.content
    ) {
      throw new Error("BTCC R3 final does not match its immutable Outbox");
    }
    this.records.insert(
      transition.finalPayload.ref.id,
      "final_payload",
      transition.finalPayload.ref.sha256,
      stableJson(transition.finalPayload),
    );
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
      "delivery_committed",
    );
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = 'delivery_committed',
        active_checkpoint_id = ?, route = ?, final_payload_json = ?,
        delivery_outbox_id = ?, revision = ?, final_disposition = 'completed'
      WHERE turn_id = ? AND revision = ? AND semantic_state = 'admitted'
        AND active_checkpoint_id = ? AND execution_fence = ?
    `).run(
      checkpoint.checkpointId,
      transition.route,
      stableJson(transition.finalPayload),
      outbox.outboxId,
      nextRevision,
      turn.turnId,
      turn.revision,
      turn.checkpoint?.checkpointId ?? null,
      turn.executionFence,
    );
    if (updated.changes !== 1) {
      throw new Error("BTCC R3 final commit lost Turn CAS");
    }
    this.insertCheckpoint(turn.turnId, nextRevision, checkpoint);
  }

  private observeDelivery(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<GuidedTurnTransition, { kind: "observe_delivery" }>,
  ): void {
    if (
      turn.semanticState !== "delivery_committed" ||
      transition.successor !== "delivered" ||
      !turn.deliveryOutbox
    ) {
      throw new Error("BTCC R3 delivery observation lacks a committed Outbox");
    }
    const observed = this.db.query<{ status: string }, [string, string, string]>(`
      SELECT status FROM btcc_delivery_outbox
      WHERE outbox_id = ? AND turn_id = ? AND expected_message_id = ?
    `).get(
      turn.deliveryOutbox.outboxId,
      turn.turnId,
      transition.assistantMessageId,
    );
    if (observed?.status !== "inserted") {
      throw new Error("BTCC R3 delivery observation has no inserted canonical message");
    }
    const outboxUpdated = this.db.query(`
      UPDATE btcc_delivery_outbox SET status = 'observed'
      WHERE outbox_id = ? AND status = 'inserted'
    `).run(turn.deliveryOutbox.outboxId);
    if (outboxUpdated.changes !== 1) {
      throw new Error("BTCC R3 delivery Outbox observation raced");
    }
    const updated = this.db.query<{ turn_id: string }, [
      string,
      number,
      string,
      number,
      string,
      number,
    ]>(`
      UPDATE btcc_turns SET semantic_state = 'delivered',
        active_checkpoint_id = NULL, canonical_assistant_message_id = ?,
        revision = ?
      WHERE turn_id = ? AND revision = ?
        AND semantic_state = 'delivery_committed'
        AND active_checkpoint_id = ? AND execution_fence = ?
      RETURNING turn_id
    `).get(
      transition.assistantMessageId,
      nextRevision,
      turn.turnId,
      turn.revision,
      turn.checkpoint?.checkpointId ?? "",
      turn.executionFence,
    );
    if (updated?.turn_id !== turn.turnId) {
      throw new Error("BTCC R3 delivery commit lost Turn CAS");
    }
  }

  private assertCurrentClaim(
    turn: TurnRecord,
    claim: StateExecutionClaim,
  ): void {
    const current = this.db.query<{
      semantic_state: string;
      revision: number;
      execution_fence: number;
      active_checkpoint_id: string | null;
    }, [string]>(`
      SELECT semantic_state, revision, execution_fence, active_checkpoint_id
      FROM btcc_turns WHERE turn_id = ?
    `).get(turn.turnId);
    const owned = this.db.query<{
      turn_id: string;
      turn_revision: number;
      semantic_state: string;
      checkpoint_id: string;
      checkpoint_revision: number;
      execution_fence: number;
      status: string;
    }, [string]>(`
      SELECT turn_id, turn_revision, semantic_state, checkpoint_id,
        checkpoint_revision, execution_fence, status
      FROM btcc_state_claims WHERE claim_id = ?
    `).get(claim.claimId);
    if (
      !turn.checkpoint ||
      !current ||
      current.semantic_state !== turn.semanticState ||
      current.revision !== turn.revision ||
      current.execution_fence !== turn.executionFence ||
      current.active_checkpoint_id !== turn.checkpoint.checkpointId ||
      claim.turnId !== turn.turnId ||
      claim.turnRevision !== turn.revision ||
      claim.semanticState !== turn.semanticState ||
      claim.checkpointId !== turn.checkpoint.checkpointId ||
      claim.checkpointRevision !== turn.checkpoint.checkpointRevision ||
      claim.executionFence !== turn.executionFence ||
      owned?.turn_id !== claim.turnId ||
      owned.turn_revision !== claim.turnRevision ||
      owned.semantic_state !== claim.semanticState ||
      owned.checkpoint_id !== claim.checkpointId ||
      owned.checkpoint_revision !== claim.checkpointRevision ||
      owned.execution_fence !== claim.executionFence ||
      owned.status !== "active"
    ) {
      throw new Error("BTCC R3 transition lost its exact Turn claim");
    }
  }

  private consumeClaim(claim: StateExecutionClaim): void {
    const consumed = this.db.query(`
      UPDATE btcc_state_claims SET status = 'consumed'
      WHERE claim_id = ? AND status = 'active'
    `).run(claim.claimId);
    if (consumed.changes !== 1) {
      throw new Error("BTCC R3 transition claim was not active");
    }
    const checkpoint = this.db.query(`
      UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL
      WHERE checkpoint_id = ? AND active_claim_id = ? AND is_active = 1
    `).run(claim.checkpointId, claim.claimId);
    if (checkpoint.changes !== 1) {
      throw new Error("BTCC R3 transition checkpoint was not actively claimed");
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
      ) VALUES (?, ?, ?, ?, 'runtime', ?, 1)
    `).run(
      checkpoint.checkpointId,
      turnId,
      turnRevision,
      checkpoint.semanticState,
      checkpoint.checkpointRevision,
    );
  }
}

function checkpointFor(
  turnId: string,
  turnRevision: number,
  semanticState: GuidedTurnSemanticState,
): TurnCheckpoint {
  return {
    checkpointId: digest(
      `btcc-checkpoint.v1\0${turnId}\0${turnRevision}\0${semanticState}`,
    ),
    checkpointRevision: 1,
    kind: "runtime",
    semanticState,
  };
}
