import type { BtccAgentLoopInput } from "./contracts.ts";
import type { TurnRecord } from "../turn/index.ts";

type Transition = NonNullable<
  Parameters<import("./contracts.ts").BtccAgentLoop["run"]>[0]["transitionContinuationBudget"]
>;

export function guidedContinuationBudget(
  turn: TurnRecord,
  transition: Transition | undefined,
): BtccAgentLoopInput["continuationBudget"] {
  if (!turn.continuationBudget) return undefined;
  if (!transition) throw new Error("turn_continuation_dependency_missing");
  return {
    state: turn.continuationBudget,
    admitRequest: async ({ roundId, requestDigest, modelFacingBytes }) => {
      await transition({ kind: "admit_request", roundId, requestDigest, modelFacingBytes });
    },
    recordOutput: async ({ roundId, outputBytes }) => {
      await transition({ kind: "record_output", roundId, outputBytes });
    },
    recordToolRound: async ({ roundId }) => {
      await transition({ kind: "record_tool_round", roundId });
    },
  };
}
