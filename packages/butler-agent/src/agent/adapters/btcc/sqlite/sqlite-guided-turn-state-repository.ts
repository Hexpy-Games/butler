import type { Database } from "bun:sqlite";
import type {
  DeliveryOutbox,
  StateExecutionClaim,
  StopPersistenceOutcome,
  TurnCheckpoint,
  TurnRecord,
  TurnStateRepository,
} from "../../../btcc/turn/index.ts";
import {
  assertGuidedTurnSemanticState,
  type GuidedTurnSemanticState,
} from "./guided-turn-state.ts";
import type { RuntimeOwnerAuthority } from "./runtime-owner/index.ts";
import { SqliteGuidedStopController } from
  "./sqlite-guided-stop-controller.ts";
import { SqliteGuidedTransitionWriter } from
  "./sqlite-guided-transition-writer.ts";
import { SqliteStateExecutionClaims } from "./state-execution-claims.ts";

type TurnRow = {
  turn_id: string;
  session_id: string;
  inbox_id: string;
  trigger_key: string;
  original_message_id: string;
  original_message: string;
  model_selection_json: string;
  context_json: string;
  semantic_state: string;
  active_checkpoint_id: string | null;
  route: string | null;
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
  kind: string;
  semantic_state: string;
};

type OutboxRow = {
  outbox_id: string;
  payload_id: string;
  payload_sha256: string;
  expected_message_id: string;
  content: string;
  status: string;
};

export class SqliteGuidedTurnStateRepository implements TurnStateRepository {
  private readonly transitions: SqliteGuidedTransitionWriter;
  private readonly stops: SqliteGuidedStopController;
  private readonly stateClaims: SqliteStateExecutionClaims;

  constructor(
    private readonly db: Database,
    owner: RuntimeOwnerAuthority,
  ) {
    this.transitions = new SqliteGuidedTransitionWriter(db);
    this.stops = new SqliteGuidedStopController(db);
    this.stateClaims = new SqliteStateExecutionClaims(db, owner);
  }

  async findTurn(turnId: string): Promise<TurnRecord | null> {
    const row = this.db.query<TurnRow, [string]>(`
      SELECT turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, model_selection_json, context_json, semantic_state,
        active_checkpoint_id, route, final_payload_json, delivery_outbox_id,
        canonical_assistant_message_id, revision, execution_fence,
        final_disposition
      FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    if (!row) return null;
    assertGuidedTurnSemanticState(row.semantic_state);
    const state = row.semantic_state;
    const checkpoint = this.loadCheckpoint(row, state);
    const outbox = this.loadOutbox(row.delivery_outbox_id);
    const finalPayload = hydrateFinalPayload(row.final_payload_json);
    const route = hydrateRoute(row.route);
    const finalDisposition = hydrateFinalDisposition(row.final_disposition);
    const turn: TurnRecord = {
      turnId: row.turn_id,
      sessionId: row.session_id,
      inboxId: row.inbox_id,
      triggerKey: row.trigger_key,
      originalMessageId: row.original_message_id,
      originalMessage: row.original_message,
      modelSelection: JSON.parse(row.model_selection_json),
      context: JSON.parse(row.context_json),
      semanticState: state,
      ...(checkpoint ? { checkpoint } : {}),
      ...(route ? { route } : {}),
      ...(finalPayload ? { finalPayload } : {}),
      ...(outbox ? { deliveryOutbox: outbox } : {}),
      ...(row.canonical_assistant_message_id
        ? { canonicalAssistantMessageId: row.canonical_assistant_message_id }
        : {}),
      revision: row.revision,
      executionFence: row.execution_fence,
      ...(finalDisposition ? { finalDisposition } : {}),
    };
    assertGuidedTurnRecord(turn);
    return turn;
  }

  async activateCommittedSuccessor(turnId: string): Promise<TurnRecord> {
    const turn = await this.findTurn(turnId);
    if (!turn) throw new Error(`BTCC R3 Turn disappeared after commit: ${turnId}`);
    return turn;
  }

  async acquireStateExecutionClaim(
    turn: TurnRecord,
  ): Promise<StateExecutionClaim> {
    assertGuidedTurnSemanticState(turn.semanticState);
    if (
      turn.semanticState === "delivered" ||
      turn.semanticState === "cancelled"
    ) {
      throw new Error("Terminal BTCC R3 Turn cannot acquire an execution claim");
    }
    return this.stateClaims.acquire(turn);
  }

  async commitTransition(
    input: Parameters<TurnStateRepository["commitTransition"]>[0],
  ): Promise<void> {
    this.transitions.commit(input);
  }

  async stopTurn(turnId: string): Promise<StopPersistenceOutcome> {
    return this.stops.stop(turnId);
  }

  private loadCheckpoint(
    turn: TurnRow,
    state: GuidedTurnSemanticState,
  ): TurnCheckpoint | undefined {
    if (!turn.active_checkpoint_id) return undefined;
    const row = this.db.query<CheckpointRow, [string, string]>(`
      SELECT checkpoint_id, checkpoint_revision, kind, semantic_state
      FROM btcc_checkpoints
      WHERE checkpoint_id = ? AND turn_id = ? AND is_active = 1
    `).get(turn.active_checkpoint_id, turn.turn_id);
    if (!row) throw new Error("BTCC R3 active checkpoint is missing");
    assertGuidedTurnSemanticState(row.semantic_state);
    if (
      row.semantic_state !== state ||
      row.kind !== "runtime"
    ) {
      throw new Error("BTCC R3 checkpoint does not match its Turn");
    }
    return {
      checkpointId: row.checkpoint_id,
      checkpointRevision: row.checkpoint_revision,
      kind: "runtime",
      semanticState: row.semantic_state,
    };
  }

  private loadOutbox(outboxId: string | null): DeliveryOutbox | undefined {
    if (!outboxId) return undefined;
    const row = this.db.query<OutboxRow, [string]>(`
      SELECT outbox_id, payload_id, payload_sha256, expected_message_id,
        content, status
      FROM btcc_delivery_outbox WHERE outbox_id = ?
    `).get(outboxId);
    if (
      !row ||
      (
        row.status !== "pending" &&
        row.status !== "inserted" &&
        row.status !== "observed"
      )
    ) {
      throw new Error("BTCC R3 delivery Outbox is missing or invalid");
    }
    return {
      outboxId: row.outbox_id,
      finalPayloadRef: {
        id: row.payload_id,
        sha256: row.payload_sha256,
      },
      expectedMessageId: row.expected_message_id,
      content: row.content,
      status: row.status,
    };
  }
}

function hydrateFinalPayload(
  value: string | null,
): TurnRecord["finalPayload"] | undefined {
  if (!value) return undefined;
  const payload = JSON.parse(value) as {
    ref?: { id?: unknown; sha256?: unknown };
    content?: unknown;
    contentSha256?: unknown;
  };
  if (
    typeof payload.ref?.id !== "string" ||
    typeof payload.ref.sha256 !== "string" ||
    typeof payload.content !== "string" ||
    typeof payload.contentSha256 !== "string"
  ) {
    throw new Error("BTCC R3 final payload is invalid");
  }
  return payload as TurnRecord["finalPayload"];
}

function hydrateRoute(value: string | null): TurnRecord["route"] | undefined {
  if (!value) return undefined;
  if (value !== "direct" && value !== "assisted" && value !== "managed") {
    throw new Error(`BTCC R3 route is invalid: ${value}`);
  }
  return value;
}

function hydrateFinalDisposition(
  value: string | null,
): TurnRecord["finalDisposition"] | undefined {
  if (!value) return undefined;
  if (value !== "completed" && value !== "cancelled") {
    throw new Error(`BTCC R3 final disposition is invalid: ${value}`);
  }
  return value;
}

function assertGuidedTurnRecord(turn: TurnRecord): void {
  const nonterminal =
    turn.semanticState === "admitted" ||
    turn.semanticState === "delivery_committed";
  if (nonterminal !== Boolean(turn.checkpoint)) {
    throw new Error("BTCC R3 Turn checkpoint does not match lifecycle state");
  }
  if (turn.semanticState === "admitted") {
    if (turn.finalPayload || turn.deliveryOutbox) {
      throw new Error("Admitted BTCC R3 Turn already has final delivery data");
    }
    return;
  }
  if (turn.semanticState === "cancelled") return;
  if (
    !turn.finalPayload ||
    !turn.deliveryOutbox ||
    turn.finalPayload.ref.id !== turn.deliveryOutbox.finalPayloadRef.id ||
    turn.finalPayload.ref.sha256 !== turn.deliveryOutbox.finalPayloadRef.sha256 ||
    turn.finalPayload.content !== turn.deliveryOutbox.content
  ) {
    throw new Error("BTCC R3 final payload does not match its Outbox");
  }
  if (
    turn.semanticState === "delivery_committed" &&
    turn.deliveryOutbox.status === "observed"
  ) {
    throw new Error("BTCC R3 committed delivery is already observed");
  }
  if (
    turn.semanticState === "delivered" &&
    (
      turn.deliveryOutbox.status !== "observed" ||
      !turn.canonicalAssistantMessageId
    )
  ) {
    throw new Error("Delivered BTCC R3 Turn lacks canonical observation");
  }
}
