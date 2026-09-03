import type {
  BtccFinalArtifact,
  BtccTurnOutcome,
  ChangedFileDetail,
} from "../../../agent/btcc/index.ts";
import { projectBtccFinalReport } from "../../../agent/btcc/index.ts";

export function projectTurnOutcome(
  outcome: BtccTurnOutcome,
): {
  text: string;
  artifacts: BtccFinalArtifact[];
  changedFiles: ChangedFileDetail[];
  workStatus?: "completed" | "blocked";
  executionOutcome?: "waiting_for_worker";
} {
  if (outcome.kind === "delivered" || outcome.kind === "already_delivered") {
    return {
      text: outcome.content,
      ...(outcome.executionOutcome ? { executionOutcome: outcome.executionOutcome } : {}),
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
): { summary: string; changedArtifacts: string[]; changedFiles: ChangedFileDetail[] } {
  const projected = projectBtccFinalReport(
    result.text,
    result.changedFiles.map((file) => file.path),
  );
  return {
    summary: structuredReport(result.text) ? projected.summary : result.text.trim(),
    changedArtifacts: projected.changedArtifacts,
    changedFiles: result.changedFiles,
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
