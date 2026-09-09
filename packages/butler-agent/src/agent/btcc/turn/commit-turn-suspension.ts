import type { BtccTurnOutcome } from "../contracts.ts";
import type {
  StateExecutionClaim,
  TurnRecord,
  TurnStateRepository,
} from "./contracts.ts";

/** Releases execution ownership while preserving one resumable durable Turn. */
export async function commitTurnSuspension(input: {
  turns: TurnStateRepository;
  turn: TurnRecord;
  claim: StateExecutionClaim;
  reason: NonNullable<TurnRecord["suspension"]>;
  authorityContinuation?: TurnRecord["authorityContinuation"];
}): Promise<Extract<BtccTurnOutcome, { kind: "suspended" }>> {
  await input.turns.commitTransition({
    turn: input.turn,
    claim: input.claim,
    transition: {
      kind: "suspend",
      successor: "admitted",
      reason: input.reason,
      authorityContinuation: input.authorityContinuation,
    },
  });
  const suspended = await input.turns.activateCommittedSuccessor(input.turn.turnId);
  if (!suspended.suspension) {
    throw new Error("BTCC suspension commit did not persist its reason");
  }
  return {
    kind: "suspended",
    turnId: suspended.turnId,
    reason: suspended.suspension,
  };
}
