import type { Database } from "bun:sqlite";
import {
  parseTurnContinuationBudgetState,
  transitionTurnContinuationBudget,
  TurnContinuationBudgetExhaustedError,
  TurnContinuationBudgetStorageError,
  type TurnContinuationBudgetEvent,
  type TurnContinuationBudgetState,
} from "../../../btcc/turn/index.ts";

export type SqliteContinuationBudgetMutation = {
  state: TurnContinuationBudgetState | null;
  terminal: TurnContinuationBudgetExhaustedError | null;
};

type InTransactionInput = {
  turnId: string;
  expectedRevision: number;
  executionFence: number;
  claimId: string;
  nowMs: number;
};

export class SqliteTurnContinuationBudgetStore {
  constructor(private readonly db: Database) {}

  recordModelDispatchInTransaction(
    input: InTransactionInput,
  ): SqliteContinuationBudgetMutation {
    return this.mutateInTransaction(input, { kind: "model_dispatch" });
  }

  recordToolRoundInTransaction(
    input: InTransactionInput,
  ): SqliteContinuationBudgetMutation {
    return this.mutateInTransaction(input, { kind: "tool_round" });
  }

  recordTokenUsageInTransaction(
    input: InTransactionInput & {
      promptTokens: number | null;
      outputTokens: number | null;
    },
  ): SqliteContinuationBudgetMutation {
    if (input.promptTokens === null && input.outputTokens === null) {
      return { state: null, terminal: null };
    }
    return this.mutateInTransaction(input, {
      kind: "token_usage",
      promptTokens: input.promptTokens,
      outputTokens: input.outputTokens,
    });
  }

  recordDurableResultRefsInTransaction(
    input: InTransactionInput & { refs: readonly string[] },
  ): SqliteContinuationBudgetMutation {
    if (input.refs.length === 0) return { state: null, terminal: null };
    return this.mutateInTransaction(input, {
      kind: "durable_result_refs",
      refs: input.refs,
    });
  }

  recordNoProgressInTransaction(
    input: InTransactionInput,
  ): SqliteContinuationBudgetMutation {
    return this.mutateInTransaction(input, { kind: "no_progress" });
  }

  private mutateInTransaction(
    input: InTransactionInput,
    event: TurnContinuationBudgetEvent,
  ): SqliteContinuationBudgetMutation {
    this.assertClaim(input);
    const row = this.db.query<
      { continuation_budget_json: string | null },
      [string, number, number]
    >(`
      SELECT continuation_budget_json
      FROM btcc_turns
      WHERE turn_id = ? AND revision = ? AND execution_fence = ?
    `).get(input.turnId, input.expectedRevision, input.executionFence);
    let current: TurnContinuationBudgetState;
    const currentJson = row?.continuation_budget_json ?? null;
    if (currentJson === null) {
      throw new TurnContinuationBudgetStorageError(input.turnId);
    } else {
      try {
        current = parseTurnContinuationBudgetState(
          JSON.parse(currentJson),
          input.turnId,
        );
      } catch (error) {
        throw new TurnContinuationBudgetStorageError(input.turnId, error);
      }
    }
    let next: TurnContinuationBudgetState;
    let terminal: TurnContinuationBudgetExhaustedError | null = null;
    try {
      next = transitionTurnContinuationBudget(current, event, input.nowMs);
    } catch (error) {
      if (!(error instanceof TurnContinuationBudgetExhaustedError)) throw error;
      next = error.state;
      terminal = error;
    }
    if (JSON.stringify(next) !== currentJson) {
      const updated = this.db.query(`
        UPDATE btcc_turns SET continuation_budget_json = ?
        WHERE turn_id = ? AND revision = ? AND execution_fence = ?
          AND continuation_budget_json IS ?
      `).run(
        JSON.stringify(next),
        input.turnId,
        input.expectedRevision,
        input.executionFence,
        currentJson,
      );
      if (updated.changes !== 1) {
        throw new TurnContinuationBudgetStorageError(input.turnId);
      }
    }
    return { state: next, terminal };
  }

  currentResultRefCountInTransaction(input: {
    turnId: string;
  }): number {
    return this.load(input.turnId)?.seenDurableResultRefs.length ?? 0;
  }

  load(turnId: string): TurnContinuationBudgetState | null {
    const value = this.db.query<{ continuation_budget_json: string | null }, [string]>(`
      SELECT continuation_budget_json FROM btcc_turns WHERE turn_id = ?
    `).get(turnId)?.continuation_budget_json;
    if (!value) return null;
    try {
      return parseTurnContinuationBudgetState(
        JSON.parse(value),
        turnId,
      );
    } catch (error) {
      throw new TurnContinuationBudgetStorageError(turnId, error);
    }
  }

  private assertClaim(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
  }): void {
    const claim = this.db.query<{
      turn_id: string;
      turn_revision: number;
      execution_fence: number;
      status: string;
    }, [string]>(`
      SELECT turn_id, turn_revision, execution_fence, status
      FROM btcc_state_claims WHERE claim_id = ?
    `).get(input.claimId);
    if (!claim || claim.turn_id !== input.turnId ||
        claim.turn_revision !== input.expectedRevision ||
        claim.execution_fence !== input.executionFence || claim.status !== "active") {
      throw new TurnContinuationBudgetStorageError(input.turnId);
    }
  }

}
