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
  changedFiles: string[];
  workStatus?: "completed" | "blocked";
} {
  if (outcome.kind === "delivered" || outcome.kind === "already_delivered") {
    return {
      text: outcome.content,
      artifacts: outcome.artifacts ?? [],
      changedFiles: outcome.changedFiles ?? [],
      ...(outcome.workStatus ? { workStatus: outcome.workStatus } : {}),
    };
  }
  if (outcome.kind === "cancelled" || outcome.kind === "already_cancelled") {
    return { text: "", artifacts: [], changedFiles: [] };
  }
  throw new Error(`BTCC inbound did not reach a deliverable outcome: ${outcome.kind}`);
}

export function projectChildTerminalReport(
  result: ReturnType<typeof projectTurnOutcome>,
): { summary: string; changedArtifacts: string[] } {
  const projected = projectBtccFinalReport(
    result.text,
    result.changedFiles,
  );
  return {
    summary: structuredReport(result.text) ? projected.summary : result.text.trim(),
    changedArtifacts: projected.changedArtifacts,
  };
}

function structuredReport(content: string): boolean {
  try {
    const value = JSON.parse(content) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
