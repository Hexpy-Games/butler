import type { Database } from "bun:sqlite";
import type { ModelRoundResult } from "../../../btcc/ports/index.ts";
import {
  hydrateAcceptedModelRound,
  normalizeAcceptedModelRound,
} from "./sqlite-model-response-normalizer.ts";
import type { SqliteModelRoundAcceptanceInput } from "./sqlite-model-route-types.ts";
import {
  SqliteTurnContinuationBudgetStore,
} from "./sqlite-turn-continuation-budget.ts";
import { TurnContinuationBudgetExhaustedError } from
  "../../../btcc/turn/index.ts";

export class SqliteModelRouteAcceptanceStore {
  private readonly continuationBudget: SqliteTurnContinuationBudgetStore;

  constructor(private readonly db: Database) {
    this.continuationBudget = new SqliteTurnContinuationBudgetStore(db);
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
    if (row) {
      return hydrateAcceptedModelRound(
        row.normalized_response_json,
        row.provider_identity_json,
      );
    }
    const continuationBudget = this.continuationBudget.load(input.turnId);
    if (continuationBudget?.terminal.status === "exhausted") {
      throw new TurnContinuationBudgetExhaustedError(continuationBudget);
    }
    return undefined;
  }

  async recordModelRoundAcceptance(input: SqliteModelRoundAcceptanceInput): Promise<void> {
    this.db.transaction(() => {
      this.assertRouteClaim(input);
      this.assertActiveCheckpoint(input);
      const normalized = normalizeAcceptedModelRound(input.result);
      const acceptanceId = `${input.turnId}:${input.roundId}:${input.routeDigest}:${input.candidateIndex}:${input.modelRef}`;
      const accepted = this.db.query(`
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
          candidate_index, transport_attempt, model_ref, request_hash,
          serialized_request_bytes, durable_result_ref_count, error_code,
          failure_disposition, created_at
        ) VALUES (?, ?, ?, 'model.attempt.succeeded', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        eventId,
        input.turnId,
        input.routeDigest,
        input.roundId,
        input.candidateIndex,
        input.transportAttempt,
        input.modelRef,
        input.requestHash ?? null,
        input.serializedRequestBytes ?? null,
        input.durableResultRefCount ?? null,
        new Date().toISOString(),
      );
      if (accepted.changes === 1 &&
          this.continuationBudget.load(input.turnId) !== null) {
        const usage = input.result.usage;
        const promptTokens = usage?.promptTokens ?? null;
        const outputTokens = usage
          ? usage.providerOutputTokens !== undefined
            ? usage.providerOutputTokens
            : usage.outputTokens
          : null;
        this.continuationBudget.recordTokenUsageInTransaction({
          turnId: input.turnId,
          expectedRevision: input.expectedRevision,
          executionFence: input.executionFence,
          claimId: input.claimId,
          nowMs: Date.now(),
          promptTokens,
          outputTokens,
        });
      }
      this.projectAcceptedExecutionModel({
        turnId: input.turnId,
        modelRef: input.modelRef,
        providerIdentity: normalized.providerIdentity,
      });
    })();
    // An accepted response remains consumable. Any terminal token transition
    // blocks the next provider dispatch instead of suppressing this round.
  }

  private projectAcceptedExecutionModel(input: {
    turnId: string;
    modelRef: string;
    providerIdentity: ModelRoundResult["providerIdentity"];
  }): void {
    if (!tableExists(this.db, "turns") ||
        !columnExists(this.db, "turns", "execution_controls_json") ||
        !columnExists(this.db, "turns", "execution_model_json")) return;
    const requested = this.db.query<{
      execution_controls_json: string | null;
    }, [string]>(`
      SELECT execution_controls_json
      FROM turns
      WHERE id = ?
    `).get(input.turnId);
    if (!requested?.execution_controls_json) return;
    let controls: { model_ref?: unknown };
    try {
      controls = JSON.parse(requested.execution_controls_json) as { model_ref?: unknown };
    } catch {
      return;
    }
    if (typeof controls.model_ref !== "string") return;
    const providerReportedModel = input.providerIdentity
      ? input.providerIdentity.reportedModel.includes("/")
        ? input.providerIdentity.reportedModel
        : `${input.providerIdentity.provider}/${input.providerIdentity.reportedModel}`
      : undefined;
    this.db.query(`
      UPDATE turns
      SET execution_model_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify({
        requested_model_ref: controls.model_ref,
        adapter_effective_model_ref: input.modelRef,
        ...(providerReportedModel
          ? { provider_reported_model_ref: providerReportedModel }
          : {}),
      }),
      new Date().toISOString(),
      input.turnId,
    );
  }

  private assertRouteClaim(input: SqliteModelRoundAcceptanceInput): void {
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
        current.revision !== input.expectedRevision ||
        current.execution_fence !== input.executionFence ||
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
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function columnExists(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .some((candidate) => candidate.name === column);
}
