import type { Database } from "bun:sqlite";
import type {
  StateExecutionClaim,
  TurnContinuationBudgetExhaustedError,
} from "../../../btcc/turn/index.ts";
import { isM1CompactReplayControlTool } from
  "../../../tools/m1-compact-replay.ts";
import { SqliteTurnContinuationBudgetStore } from
  "./sqlite-turn-continuation-budget.ts";

export class SqliteGuidedToolContinuationBudget {
  private readonly budget: SqliteTurnContinuationBudgetStore;

  constructor(private readonly db: Database) {
    this.budget = new SqliteTurnContinuationBudgetStore(db);
  }

  recordBatchStartInTransaction(input: {
    turnId: string;
    operationBatchId?: string;
    claim?: StateExecutionClaim;
  }): TurnContinuationBudgetExhaustedError | null {
    if (!input.claim) return null;
    if (!input.operationBatchId) {
      throw new Error("Turn continuation tool round requires operationBatchId");
    }
    const existing = this.db.query<{ call_id: string }, [string, string]>(`
      SELECT call_id FROM btcc_guided_tool_calls
      WHERE turn_id = ? AND operation_batch_id = ? LIMIT 1
    `).get(input.turnId, input.operationBatchId);
    if (existing) return null;
    return this.budget.recordToolRoundInTransaction({
      turnId: input.turnId,
      expectedRevision: input.claim.turnRevision,
      executionFence: input.claim.executionFence,
      claimId: input.claim.claimId,
      nowMs: Date.now(),
    }).terminal;
  }

  recordCompletedResultInTransaction(input: {
    callId: string;
    toolName: string;
    status: "completed" | "failed" | "cancelled";
    result?: unknown;
    claim?: StateExecutionClaim;
  }): TurnContinuationBudgetExhaustedError | null {
    if (!input.claim || input.status !== "completed" ||
        isM1CompactReplayControlTool(input.toolName) ||
        !resultSucceeded(input.result)) return null;
    const identity = this.db.query<{
      turn_id: string;
      result_ref: string | null;
    }, [string]>(`
      SELECT turn_id, result_ref FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(input.callId);
    if (!identity?.result_ref) return null;
    return this.budget.recordDurableResultRefsInTransaction({
      turnId: identity.turn_id,
      expectedRevision: input.claim.turnRevision,
      executionFence: input.claim.executionFence,
      claimId: input.claim.claimId,
      nowMs: Date.now(),
      refs: [identity.result_ref],
    }).terminal;
  }
}

function resultSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return (value as { ok?: unknown }).ok !== false;
}
