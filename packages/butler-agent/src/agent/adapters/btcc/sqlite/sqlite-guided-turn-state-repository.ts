import type { Database } from "bun:sqlite";
import type {
  DeliveryOutbox,
  StateExecutionClaim,
  StopPersistenceOutcome,
  TurnCheckpoint,
  TurnRecord,
  TurnStateRepository,
} from "../../../btcc/turn/index.ts";
import type {
  ModelRouteAttemptHistory,
  ModelRouteEventResult,
  ModelRouteState,
} from "../../../btcc/model-route.ts";
import type {
  ModelRoundMessage,
  ModelRoundResult,
  ModelRoundToolCall,
} from "../../../btcc/ports/model-round.ts";
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
        original_message, model_selection_json, context_json,
        route_state_json,
        progress_destination_json, semantic_state,
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
    const wakeIdentity = this.loadWakeIdentity(row.turn_id);
    const turn: TurnRecord = {
      turnId: row.turn_id,
      sessionId: row.session_id,
      inboxId: row.inbox_id,
      triggerKey: row.trigger_key,
      originalMessageId: row.original_message_id,
      originalMessage: row.original_message,
      ...(wakeIdentity ? { wakeIdentity } : {}),
      modelSelection: JSON.parse(row.model_selection_json),
      ...(row.route_state_json ? { modelRoute: JSON.parse(row.route_state_json) } : {}),
      context: JSON.parse(row.context_json),
      ...(row.progress_destination_json
        ? { progressDestination: hydrateProgressDestination(row.progress_destination_json) }
        : {}),
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

  async persistModelRoute(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    route: ModelRouteState;
  }): Promise<void> {
    await this.recordModelRouteEvent({
      turnId: input.turnId,
      expectedRevision: input.expectedRevision,
      executionFence: input.executionFence,
      claimId: input.claimId,
      route: input.route,
      event: {
        type: "model.route.updated",
        roundId: "route-state",
        candidateIndex: input.route.activeCursor,
        modelRef: input.route.candidates[input.route.activeCursor]?.modelRef ?? "unknown",
      },
    });
  }

  async recordModelRouteEvent(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    event: {
      type: string;
      roundId: string;
      candidateIndex: number;
      transportAttempt?: number;
      modelRef: string;
      errorCode?: string;
    };
    route?: ModelRouteState;
  }): Promise<ModelRouteEventResult> {
    return this.db.transaction((): ModelRouteEventResult => {
      const claim = this.db.query<{
        turn_id: string;
        turn_revision: number;
        execution_fence: number;
        status: string;
      }, [string]>(`
        SELECT turn_id, turn_revision, execution_fence, status
        FROM btcc_state_claims WHERE claim_id = ?
      `).get(input.claimId);
      const current = this.db.query<{
        revision: number;
        execution_fence: number;
        semantic_state: string;
      }, [string]>(`
        SELECT revision, execution_fence, semantic_state
        FROM btcc_turns WHERE turn_id = ?
      `).get(input.turnId);
      if (!claim || !current || claim.turn_id !== input.turnId ||
          claim.turn_revision !== input.expectedRevision ||
          claim.execution_fence !== input.executionFence || claim.status !== "active" ||
          current.revision !== input.expectedRevision ||
          current.execution_fence !== input.executionFence ||
          current.semantic_state === "delivered" || current.semantic_state === "cancelled") {
        throw new Error("BTCC model route event lost exact Turn claim");
      }
      const routeJson = this.db.query<{ route_state_json: string | null }, [string]>(
        "SELECT route_state_json FROM btcc_turns WHERE turn_id = ?",
      ).get(input.turnId)?.route_state_json;
      const routeDigest = input.route?.routeDigest ??
        (routeJson ? JSON.parse(routeJson).routeDigest : "unknown");
      const eventId = `${input.turnId}:${input.event.type}:${input.event.roundId}:${input.event.candidateIndex}:${input.event.transportAttempt ?? 0}:${input.event.modelRef}`;
      if (input.event.type === "model.attempt.started") {
        const existing = this.db.query<{ event_type: string }, [string]>(`
          SELECT event_type FROM btcc_model_route_events WHERE event_id = ?
        `).get(eventId);
        if (existing) {
          const terminal = this.db.query<{ event_type: string }, [string, string, number, number, string]>(`
            SELECT event_type FROM btcc_model_route_events
            WHERE turn_id = ? AND round_id = ? AND candidate_index = ?
              AND transport_attempt = ? AND model_ref = ?
              AND event_type IN (
                'model.attempt.failed',
                'model.attempt.succeeded',
                'model.attempt.abandoned_after_restart'
              )
            ORDER BY created_at DESC LIMIT 1
          `).get(
            input.turnId,
            input.event.roundId,
            input.event.candidateIndex,
            input.event.transportAttempt ?? 0,
            input.event.modelRef,
          );
          if (terminal?.event_type === "model.attempt.abandoned_after_restart") {
            return { status: "abandoned_after_restart" };
          }
          if (terminal) return { status: "already_terminal" };
          this.db.query(`
            INSERT OR IGNORE INTO btcc_model_route_events (
              event_id, turn_id, route_digest, event_type, round_id,
              candidate_index, transport_attempt, model_ref, error_code, created_at
            ) VALUES (?, ?, ?, 'model.attempt.abandoned_after_restart', ?, ?, ?, ?, NULL, ?)
          `).run(
            `${eventId}:abandoned_after_restart`,
            input.turnId,
            routeDigest,
            input.event.roundId,
            input.event.candidateIndex,
            input.event.transportAttempt ?? null,
            input.event.modelRef,
            new Date().toISOString(),
          );
          return { status: "abandoned_after_restart" };
        }
      }
      this.db.query(`
        INSERT OR IGNORE INTO btcc_model_route_events (
          event_id, turn_id, route_digest, event_type, round_id,
          candidate_index, transport_attempt, model_ref, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        input.turnId,
        routeDigest,
        input.event.type,
        input.event.roundId,
        input.event.candidateIndex,
        input.event.transportAttempt ?? null,
        input.event.modelRef,
        input.event.errorCode ?? null,
        new Date().toISOString(),
      );
      if (input.route) {
        const updated = this.db.query(`
          UPDATE btcc_turns SET route_state_json = ?
          WHERE turn_id = ? AND revision = ? AND execution_fence = ?
        `).run(JSON.stringify(input.route), input.turnId, input.expectedRevision, input.executionFence);
        if (updated.changes !== 1) throw new Error("BTCC model route persistence lost Turn CAS");
      }
      return { status: "recorded" };
    })();
  }

  async loadModelRouteAttemptHistory(input: {
    turnId: string;
    roundId: string;
    routeDigest: string;
    candidateIndex: number;
    modelRef: string;
  }): Promise<ModelRouteAttemptHistory> {
    const rows = this.db.query<{
      event_type: string;
      transport_attempt: number | null;
    }, [string, string, string, number, string]>(`
      SELECT event_type, transport_attempt
      FROM btcc_model_route_events
      WHERE turn_id = ? AND route_digest = ? AND round_id = ?
        AND candidate_index = ? AND model_ref = ?
        AND transport_attempt IS NOT NULL
      ORDER BY transport_attempt ASC, created_at ASC
    `).all(
      input.turnId,
      input.routeDigest,
      input.roundId,
      input.candidateIndex,
      input.modelRef,
    );
    const history: {
      started: number[];
      failed: number[];
      succeeded: number[];
      abandoned: number[];
    } = { started: [], failed: [], succeeded: [], abandoned: [] };
    for (const row of rows) {
      if (row.transport_attempt === null) continue;
      if (row.event_type === "model.attempt.started") history.started.push(row.transport_attempt);
      if (row.event_type === "model.attempt.failed") history.failed.push(row.transport_attempt);
      if (row.event_type === "model.attempt.succeeded") history.succeeded.push(row.transport_attempt);
      if (row.event_type === "model.attempt.abandoned_after_restart") history.abandoned.push(row.transport_attempt);
    }
    return history;
  }

  async loadModelRoundAcceptance(input: {
    turnId: string;
    roundId: string;
    routeDigest: string;
    candidateIndex: number;
    modelRef: string;
    checkpointId: string;
    checkpointRevision: number;
  }): Promise<ModelRoundResult | undefined> {
    this.assertActiveCheckpoint(input);
    const row = this.db.query<{
      normalized_response_json: string;
      provider_identity_json: string | null;
    }, [string, string, string, number, string, string, number]>(`
      SELECT normalized_response_json, provider_identity_json
      FROM btcc_model_round_acceptances
      WHERE turn_id = ? AND round_id = ? AND route_digest = ?
        AND candidate_index = ? AND model_ref = ?
        AND checkpoint_id = ? AND checkpoint_revision = ?
    `).get(
      input.turnId,
      input.roundId,
      input.routeDigest,
      input.candidateIndex,
      input.modelRef,
      input.checkpointId,
      input.checkpointRevision,
    );
    if (!row) return undefined;
    return hydrateAcceptedModelRound(
      row.normalized_response_json,
      row.provider_identity_json,
    );
  }

  async recordModelRoundAcceptance(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    checkpointId: string;
    checkpointRevision: number;
    roundId: string;
    routeDigest: string;
    candidateIndex: number;
    transportAttempt: number;
    modelRef: string;
    result: ModelRoundResult;
  }): Promise<void> {
    this.db.transaction(() => {
      this.assertRouteClaim(input);
      this.assertActiveCheckpoint(input);
      const normalized = normalizeAcceptedModelRound(input.result);
      const acceptanceId = `${input.turnId}:${input.roundId}:${input.routeDigest}:${input.candidateIndex}:${input.modelRef}`;
      this.db.query(`
        INSERT OR IGNORE INTO btcc_model_round_acceptances (
          acceptance_id, turn_id, round_id, route_digest, candidate_index,
          checkpoint_id, checkpoint_revision, model_ref, transport_attempt,
          normalized_response_json,
          provider_identity_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        acceptanceId,
        input.turnId,
        input.roundId,
        input.routeDigest,
        input.candidateIndex,
        input.checkpointId,
        input.checkpointRevision,
        input.modelRef,
        input.transportAttempt,
        JSON.stringify(normalized),
        input.result.providerIdentity ? JSON.stringify(input.result.providerIdentity) : null,
        new Date().toISOString(),
      );
      const eventId = `${input.turnId}:model.attempt.succeeded:${input.roundId}:${input.candidateIndex}:${input.transportAttempt}:${input.modelRef}`;
      this.db.query(`
        INSERT OR IGNORE INTO btcc_model_route_events (
          event_id, turn_id, route_digest, event_type, round_id,
          candidate_index, transport_attempt, model_ref, error_code, created_at
        ) VALUES (?, ?, ?, 'model.attempt.succeeded', ?, ?, ?, ?, NULL, ?)
      `).run(
        eventId,
        input.turnId,
        input.routeDigest,
        input.roundId,
        input.candidateIndex,
        input.transportAttempt,
        input.modelRef,
        new Date().toISOString(),
      );
    })();
  }

  private assertRouteClaim(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    checkpointId: string;
    checkpointRevision: number;
  }): void {
    const claim = this.db.query<{
      turn_id: string;
      turn_revision: number;
      execution_fence: number;
      checkpoint_id: string;
      checkpoint_revision: number;
      status: string;
    }, [string]>(`
      SELECT turn_id, turn_revision, execution_fence, checkpoint_id,
        checkpoint_revision, status
      FROM btcc_state_claims WHERE claim_id = ?
    `).get(input.claimId);
    const current = this.db.query<{
      revision: number;
      execution_fence: number;
      active_checkpoint_id: string | null;
      semantic_state: string;
    }, [string]>(`
      SELECT revision, execution_fence, active_checkpoint_id, semantic_state
      FROM btcc_turns WHERE turn_id = ?
    `).get(input.turnId);
    if (!claim || !current || claim.turn_id !== input.turnId ||
        claim.turn_revision !== input.expectedRevision ||
        claim.execution_fence !== input.executionFence || claim.status !== "active" ||
        claim.checkpoint_id !== input.checkpointId ||
        claim.checkpoint_revision !== input.checkpointRevision ||
        current.revision !== input.expectedRevision || current.execution_fence !== input.executionFence ||
        current.active_checkpoint_id !== input.checkpointId ||
        current.semantic_state === "delivered" || current.semantic_state === "cancelled") {
      throw new Error("BTCC model response acceptance lost exact Turn claim");
    }
  }

  private assertActiveCheckpoint(input: {
    turnId: string;
    checkpointId: string;
    checkpointRevision: number;
  }): void {
    const row = this.db.query<{
      active_checkpoint_id: string | null;
      checkpoint_id: string | null;
      checkpoint_revision: number | null;
      is_active: number | null;
    }, [string, number, string]>(`
      SELECT turn.active_checkpoint_id, checkpoint.checkpoint_id,
        checkpoint.checkpoint_revision, checkpoint.is_active
      FROM btcc_turns AS turn
      LEFT JOIN btcc_checkpoints AS checkpoint
        ON checkpoint.checkpoint_id = ?
        AND checkpoint.turn_id = turn.turn_id
        AND checkpoint.checkpoint_revision = ?
      WHERE turn.turn_id = ?
    `).get(input.checkpointId, input.checkpointRevision, input.turnId);
    if (!row || row.active_checkpoint_id !== input.checkpointId ||
        row.checkpoint_id !== input.checkpointId ||
        row.checkpoint_revision !== input.checkpointRevision || row.is_active !== 1) {
      throw new Error("BTCC model response acceptance is not bound to the active checkpoint");
    }
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

  private loadWakeIdentity(
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

function hydrateProgressDestination(
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
    (destination.peer.kind !== "dm" &&
      destination.peer.kind !== "group" &&
      destination.peer.kind !== "thread" &&
      destination.peer.kind !== "channel") ||
    typeof destination.peer.id !== "string" ||
    typeof destination.replyToMessageId !== "string"
  ) {
    throw new Error("BTCC progress destination is invalid");
  }
  return {
    transport: destination.transport,
    accountId: destination.accountId,
    peer: {
      kind: destination.peer.kind,
      id: destination.peer.id,
      ...(typeof destination.peer.parentId === "string"
        ? { parentId: destination.peer.parentId }
        : {}),
    },
    replyToMessageId: destination.replyToMessageId,
  };
}

/**
 * Acceptance replay is deliberately limited to the normalized response
 * contract. Raw provider payloads are not durable response state and must not
 * cross a restart boundary; the normalized continuation and provider-owned
 * message data needed to resume the admitted round are retained explicitly.
 */
function normalizeAcceptedModelRound(result: ModelRoundResult): ModelRoundResult {
  const normalized: ModelRoundResult = {
    toolCalls: result.toolCalls.map(normalizeToolCall),
  };
  if (typeof result.text === "string") normalized.text = result.text;
  if (result.textToolCallNames) {
    normalized.textToolCallNames = result.textToolCallNames.map((name) => {
      if (typeof name !== "string") throw new Error("BTCC accepted response has invalid text tool name");
      return name;
    });
  }
  if (result.assistantMessage) {
    normalized.assistantMessage = normalizeAssistantMessage(result.assistantMessage);
  }
  const continuation = safeJsonClone(result.continuation);
  if (continuation !== undefined) normalized.continuation = continuation;
  if (result.usage === null) {
    normalized.usage = null;
  } else if (result.usage) {
    normalized.usage = {
      model: result.usage.model,
      promptTokens: result.usage.promptTokens,
      cachedTokens: result.usage.cachedTokens,
      totalTokens: result.usage.totalTokens,
      outputTokens: result.usage.outputTokens,
    };
  }
  if (result.providerIdentity) {
    normalized.providerIdentity = normalizeProviderIdentity(result.providerIdentity);
  }
  return normalized;
}

function hydrateAcceptedModelRound(
  value: string,
  providerIdentityJson: string | null,
): ModelRoundResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BTCC accepted response is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.toolCalls)) {
    throw new Error("BTCC accepted response has invalid normalized shape");
  }
  const result = normalizeAcceptedModelRound(parsed as unknown as ModelRoundResult);
  if (providerIdentityJson) {
    let identity: unknown;
    try {
      identity = JSON.parse(providerIdentityJson);
    } catch {
      throw new Error("BTCC accepted response provider identity is not valid JSON");
    }
    result.providerIdentity = normalizeProviderIdentity(identity);
  }
  return result;
}

function normalizeToolCall(call: ModelRoundToolCall): ModelRoundToolCall {
  if (!isRecord(call) || typeof call.id !== "string" ||
      typeof call.name !== "string" || typeof call.rawArguments !== "string" ||
      !isRecord(call.arguments)) {
    throw new Error("BTCC accepted response has invalid tool call");
  }
  return {
    id: call.id,
    name: call.name,
    arguments: cloneJsonRecord(call.arguments),
    rawArguments: call.rawArguments,
    ...(call.origin === "native" || call.origin === "text"
      ? { origin: call.origin }
      : {}),
  };
}

function normalizeAssistantMessage(message: ModelRoundMessage): ModelRoundMessage {
  if (!isRecord(message) ||
      (message.role !== "system" && message.role !== "user" &&
        message.role !== "assistant" && message.role !== "tool") ||
      typeof message.content !== "string") {
    throw new Error("BTCC accepted response has invalid assistant message");
  }
  const normalized: ModelRoundMessage = {
    role: message.role,
    content: message.content,
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.name === "string" ? { name: message.name } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(normalizeToolCall) } : {}),
  };
  const providerData = safeJsonClone(message.providerData);
  if (providerData !== undefined) normalized.providerData = providerData;
  const imageAttachments = safeJsonClone(message.imageAttachments);
  if (Array.isArray(imageAttachments)) {
    normalized.imageAttachments = imageAttachments as ModelRoundMessage["imageAttachments"];
  }
  return normalized;
}

function normalizeProviderIdentity(identity: unknown): NonNullable<ModelRoundResult["providerIdentity"]> {
  if (!isRecord(identity) || typeof identity.provider !== "string" ||
      typeof identity.configuredModel !== "string" ||
      typeof identity.reportedModel !== "string") {
    throw new Error("BTCC accepted response has invalid provider identity");
  }
  return {
    provider: identity.provider,
    configuredModel: identity.configuredModel,
    reportedModel: identity.reportedModel,
  };
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const cloned = safeJsonClone(value);
  if (!isRecord(cloned)) {
    throw new Error("BTCC accepted response tool arguments are not JSON serializable");
  }
  return cloned;
}

function safeJsonClone(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
