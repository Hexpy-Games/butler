import type {
  BtccFinalArtifact,
  BtccTurnOutcome,
} from "../../../agent/btcc/index.ts";

export function projectTurnOutcome(
  outcome: BtccTurnOutcome,
): { text: string; artifacts: BtccFinalArtifact[] } {
  if (outcome.kind === "delivered" || outcome.kind === "already_delivered") {
    return { text: outcome.content, artifacts: outcome.artifacts ?? [] };
  }
  if (outcome.kind === "cancelled" || outcome.kind === "already_cancelled") {
    return { text: "", artifacts: [] };
  }
  throw new Error(`BTCC inbound did not reach a deliverable outcome: ${outcome.kind}`);
}
