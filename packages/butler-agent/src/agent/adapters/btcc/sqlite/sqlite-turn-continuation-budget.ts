import type { Database } from "bun:sqlite";
import {
  parseTurnContinuationBudgetState,
  transitionTurnContinuationBudget,
  TurnContinuationBudgetExhaustedError,
  type TurnContinuationBudgetEvent,
  type TurnContinuationBudgetState,
} from "../../../btcc/turn/index.ts";

export class SqliteTurnContinuationBudgetStore {
  constructor(private readonly db: Database) {}

  transition(input: {
    turnId: string;
    expectedRevision: number;
    executionFence: number;
    claimId: string;
    event: TurnContinuationBudgetEvent;
    nowMs: number;
  }): TurnContinuationBudgetState {
    const transaction = this.db.transaction((): {
      state: TurnContinuationBudgetState;
      terminal: TurnContinuationBudgetExhaustedError | null;
    } => {
      const claim = this.db.query<{
        turn_id: string; turn_revision: number; execution_fence: number; status: string;
      }, [string]>(`
        SELECT turn_id, turn_revision, execution_fence, status
        FROM btcc_state_claims WHERE claim_id = ?
      `).get(input.claimId);
      if (!claim || claim.status !== "active" || claim.turn_id !== input.turnId ||
          claim.turn_revision !== input.expectedRevision ||
          claim.execution_fence !== input.executionFence) {
        throw new Error("turn_continuation_claim_mismatch");
      }
      const raw = this.db.query<{ continuation_budget_json: string | null }, [string]>(`
        SELECT continuation_budget_json FROM btcc_turns WHERE turn_id = ?
      `).get(input.turnId)?.continuation_budget_json;
      if (!raw) throw new Error("turn_continuation_dependency_missing");
      const current = parseTurnContinuationBudgetState(JSON.parse(raw), input.turnId);
      let next: TurnContinuationBudgetState;
      let terminal: TurnContinuationBudgetExhaustedError | null = null;
      try {
        next = transitionTurnContinuationBudget(current, input.event, input.nowMs);
      } catch (error) {
        if (!(error instanceof TurnContinuationBudgetExhaustedError)) throw error;
        next = error.state;
        terminal = error;
      }
      const nextJson = JSON.stringify(next);
      if (nextJson !== raw) {
        const updated = this.db.query(`
          UPDATE btcc_turns SET continuation_budget_json = ?
          WHERE turn_id = ? AND revision = ? AND execution_fence = ?
            AND continuation_budget_json = ?
        `).run(nextJson, input.turnId, input.expectedRevision, input.executionFence, raw);
        if (updated.changes !== 1) throw new Error("turn_continuation_atomic_update_failed");
      }
      return { state: next, terminal };
    });
    const result = transaction();
    if (result.terminal) throw result.terminal;
    return result.state;
  }
}
