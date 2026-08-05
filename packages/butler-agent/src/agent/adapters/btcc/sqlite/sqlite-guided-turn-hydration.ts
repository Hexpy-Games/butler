import type { Database } from "bun:sqlite";
import type {
  DeliveryOutbox,
  TurnCheckpoint,
  TurnRecord,
} from "../../../btcc/turn/index.ts";
import {
  assertGuidedTurnSemanticState,
  type GuidedTurnSemanticState,
} from "./guided-turn-state.ts";

export type TurnRow = {
  turn_id: string;
  session_id: string;
  inbox_id: string;
  trigger_key: string;
  original_message_id: string;
  original_message: string;
  model_selection_json: string;
  route_state_json: string | null;
  context_json: string;
  progress_destination_json: string | null;
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

type WakeRequestFactRow = {
  trigger_id: string;
  source_turn_id: string;
  authorization_ref: string;
  result_scope_ref: string;
};

export class SqliteGuidedTurnHydration {
  constructor(private readonly db: Database) {}

  loadCheckpoint(turn: TurnRow, state: GuidedTurnSemanticState): TurnCheckpoint | undefined {
    if (!turn.active_checkpoint_id) return undefined;
    const row = this.db.query<CheckpointRow, [string, string]>(`
      SELECT checkpoint_id, checkpoint_revision, kind, semantic_state
      FROM btcc_checkpoints
      WHERE checkpoint_id = ? AND turn_id = ? AND is_active = 1
    `).get(turn.active_checkpoint_id, turn.turn_id);
    if (!row) throw new Error("BTCC R3 active checkpoint is missing");
    assertGuidedTurnSemanticState(row.semantic_state);
    if (row.semantic_state !== state || row.kind !== "runtime") {
      throw new Error("BTCC R3 checkpoint does not match its Turn");
    }
    return {
      checkpointId: row.checkpoint_id,
      checkpointRevision: row.checkpoint_revision,
      kind: "runtime",
      semanticState: row.semantic_state,
    };
  }

  loadOutbox(outboxId: string | null): DeliveryOutbox | undefined {
    if (!outboxId) return undefined;
    const row = this.db.query<OutboxRow, [string]>(`
      SELECT outbox_id, payload_id, payload_sha256, expected_message_id,
        content, status
      FROM btcc_delivery_outbox WHERE outbox_id = ?
    `).get(outboxId);
    if (!row || !["pending", "inserted", "observed"].includes(row.status)) {
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
      status: row.status as DeliveryOutbox["status"],
    };
  }

  loadWakeIdentity(
    turnId: string,
  ): NonNullable<TurnRecord["wakeIdentity"]> | undefined {
    const row = this.db.query<WakeRequestFactRow, [string]>(`
      SELECT trigger_id, source_turn_id, authorization_ref, result_scope_ref
      FROM btcc_wake_request_facts WHERE turn_id = ?
    `).get(turnId);
    if (!row) return undefined;
    return {
      triggerId: row.trigger_id,
      sourceTurnId: row.source_turn_id,
      authorizationRef: row.authorization_ref,
      ...(row.result_scope_ref ? { resultScopeRef: row.result_scope_ref } : {}),
    };
  }
}

export function hydrateProgressDestination(
  value: string,
): NonNullable<TurnRecord["progressDestination"]> {
  const destination = JSON.parse(value) as {
    transport?: unknown;
    accountId?: unknown;
    peer?: { kind?: unknown; id?: unknown; parentId?: unknown };
    replyToMessageId?: unknown;
  };
  if (
    typeof destination.transport !== "string" ||
    typeof destination.accountId !== "string" ||
    !destination.peer ||
    !["dm", "group", "thread", "channel"].includes(String(destination.peer.kind)) ||
    typeof destination.peer.id !== "string" ||
    typeof destination.replyToMessageId !== "string"
  ) {
    throw new Error("BTCC progress destination is invalid");
  }
  return {
    transport: destination.transport,
    accountId: destination.accountId,
    peer: {
      kind: destination.peer.kind as "dm" | "group" | "thread" | "channel",
      id: destination.peer.id,
      ...(typeof destination.peer.parentId === "string"
        ? { parentId: destination.peer.parentId }
        : {}),
    },
    replyToMessageId: destination.replyToMessageId,
  };
}

export function hydrateFinalPayload(
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

export function hydrateRoute(value: string | null): TurnRecord["route"] | undefined {
  if (!value) return undefined;
  if (value !== "direct" && value !== "assisted" && value !== "managed") {
    throw new Error(`BTCC R3 route is invalid: ${value}`);
  }
  return value;
}

export function hydrateFinalDisposition(
  value: string | null,
): TurnRecord["finalDisposition"] | undefined {
  if (!value) return undefined;
  if (value !== "completed" && value !== "cancelled") {
    throw new Error(`BTCC R3 final disposition is invalid: ${value}`);
  }
  return value;
}

export function assertGuidedTurnRecord(turn: TurnRecord): void {
  const nonterminal = turn.semanticState === "admitted" ||
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
  if (turn.semanticState === "delivery_committed" && turn.deliveryOutbox.status === "observed") {
    throw new Error("BTCC R3 committed delivery is already observed");
  }
  if (turn.semanticState === "delivered" &&
      (turn.deliveryOutbox.status !== "observed" || !turn.canonicalAssistantMessageId)) {
    throw new Error("Delivered BTCC R3 Turn lacks canonical observation");
  }
}
