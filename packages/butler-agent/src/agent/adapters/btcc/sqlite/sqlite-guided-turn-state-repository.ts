import type { Database } from "bun:sqlite";
import type {
  DeliveryOutbox,
  StateExecutionClaim,
  StopPersistenceOutcome,
  TurnRecord,
  TurnStateRepository,
} from "../../../btcc/turn/index.ts";
import {
  assertGuidedTurnSemanticState,
} from "./guided-turn-state.ts";
import type { RuntimeOwnerAuthority } from "./runtime-owner/index.ts";
import { SqliteGuidedStopController } from
  "./sqlite-guided-stop-controller.ts";
import { SqliteGuidedTransitionWriter } from
  "./sqlite-guided-transition-writer.ts";
import { SqliteStateExecutionClaims } from "./state-execution-claims.ts";
import { SqliteModelRouteRepository } from "./sqlite-model-route-repository.ts";
import {
  assertGuidedTurnRecord,
  hydrateFinalDisposition,
  hydrateFinalPayload,
  hydrateProgressDestination,
  hydrateRoute,
  SqliteGuidedTurnHydration,
  type TurnRow,
} from "./sqlite-guided-turn-hydration.ts";

export class SqliteGuidedTurnStateRepository implements TurnStateRepository {
  private readonly transitions: SqliteGuidedTransitionWriter;
  private readonly stops: SqliteGuidedStopController;
  private readonly stateClaims: SqliteStateExecutionClaims;
  private readonly modelRoute: SqliteModelRouteRepository;
  private readonly hydration: SqliteGuidedTurnHydration;

  constructor(
    private readonly db: Database,
    owner: RuntimeOwnerAuthority,
  ) {
    this.transitions = new SqliteGuidedTransitionWriter(db);
    this.stops = new SqliteGuidedStopController(db);
    this.stateClaims = new SqliteStateExecutionClaims(db, owner);
    this.modelRoute = new SqliteModelRouteRepository(db);
    this.hydration = new SqliteGuidedTurnHydration(db);
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
    const checkpoint = this.hydration.loadCheckpoint(row, state);
    const outbox = this.hydration.loadOutbox(row.delivery_outbox_id);
    const finalPayload = hydrateFinalPayload(row.final_payload_json);
    const route = hydrateRoute(row.route);
    const finalDisposition = hydrateFinalDisposition(row.final_disposition);
    const wakeIdentity = this.hydration.loadWakeIdentity(row.turn_id);
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

  async persistModelRoute(
    input: Parameters<SqliteModelRouteRepository["persistModelRoute"]>[0],
  ): Promise<void> {
    return this.modelRoute.persistModelRoute(input);
  }

  async recordModelRouteEvent(
    input: Parameters<SqliteModelRouteRepository["recordModelRouteEvent"]>[0],
  ): ReturnType<SqliteModelRouteRepository["recordModelRouteEvent"]> {
    return this.modelRoute.recordModelRouteEvent(input);
  }

  async loadModelRouteAttemptHistory(
    input: Parameters<SqliteModelRouteRepository["loadModelRouteAttemptHistory"]>[0],
  ): ReturnType<SqliteModelRouteRepository["loadModelRouteAttemptHistory"]> {
    return this.modelRoute.loadModelRouteAttemptHistory(input);
  }

  async loadModelRoundAcceptance(
    input: Parameters<SqliteModelRouteRepository["loadModelRoundAcceptance"]>[0],
  ): ReturnType<SqliteModelRouteRepository["loadModelRoundAcceptance"]> {
    return this.modelRoute.loadModelRoundAcceptance(input);
  }

  async recordModelRoundAcceptance(
    input: Parameters<SqliteModelRouteRepository["recordModelRoundAcceptance"]>[0],
  ): ReturnType<SqliteModelRouteRepository["recordModelRoundAcceptance"]> {
    return this.modelRoute.recordModelRoundAcceptance(input);
  }

  async stopTurn(turnId: string): Promise<StopPersistenceOutcome> {
    return this.stops.stop(turnId);
  }
}
