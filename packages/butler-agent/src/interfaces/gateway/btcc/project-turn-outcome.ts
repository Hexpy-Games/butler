import type {
  BtccFinalArtifact,
  BtccTurnOutcome,
} from "../../../agent/btcc/index.ts";
import { projectBtccFinalReport } from "../../../agent/btcc/index.ts";

export function projectTurnOutcome(
  outcome: BtccTurnOutcome,
): {
  text: string;
  artifacts: BtccFinalArtifact[];
  workStatus?: "completed" | "blocked";
} {
  if (outcome.kind === "delivered" || outcome.kind === "already_delivered") {
    return {
      text: outcome.content,
      artifacts: outcome.artifacts ?? [],
      ...(outcome.workStatus ? { workStatus: outcome.workStatus } : {}),
    };
  }
  if (outcome.kind === "cancelled" || outcome.kind === "already_cancelled") {
    return { text: "", artifacts: [] };
  }
  throw new Error(`BTCC inbound did not reach a deliverable outcome: ${outcome.kind}`);
}

export function projectChildTerminalReport(
  result: ReturnType<typeof projectTurnOutcome>,
): { summary: string; changedArtifacts: string[] } {
  return projectBtccFinalReport(
    result.text,
    result.artifacts.map((artifact) => artifact.safePathLabel),
  );
}
