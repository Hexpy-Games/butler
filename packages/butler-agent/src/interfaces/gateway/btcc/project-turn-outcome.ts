import type {
  BtccFinalArtifact,
  BtccTurnOutcome,
  ChangedFileDetail,
} from "../../../agent/btcc/index.ts";
import { projectBtccFinalReport } from "../../../agent/btcc/index.ts";
import type { ProjectLedgerPlan } from "../../../agent/btcc/project-plan.ts";

export function projectTurnOutcome(
  outcome: BtccTurnOutcome,
): {
  text: string;
  artifacts: BtccFinalArtifact[];
  changedFiles: ChangedFileDetail[];
  workStatus?: "completed" | "blocked";
  acceptedWorkResult?: { status: "success" | "blocked" | "failed" };
  runtimeFailure?: { code: string; retryable: boolean };
  plan?: ProjectLedgerPlan;
} {
  if (outcome.kind === "delivered" || outcome.kind === "already_delivered") {
    return {
      text: outcome.content,
      artifacts: outcome.artifacts ?? [],
      changedFiles: outcome.changedFiles ?? [],
      ...(outcome.workStatus ? { workStatus: outcome.workStatus } : {}),
      ...(outcome.runtimeFailure ? { runtimeFailure: outcome.runtimeFailure } : {}),
      ...("acceptedWorkResult" in outcome && outcome.acceptedWorkResult
        ? { acceptedWorkResult: outcome.acceptedWorkResult }
        : {}),
      ...( "plan" in outcome && outcome.plan ? { plan: outcome.plan } : {}),
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
    summary: result.text.trim(),
    changedArtifacts: [...new Set([
      ...projected.changedArtifacts,
      ...result.artifacts.map((artifact) => artifact.safePathLabel),
    ])],
    changedFiles: result.changedFiles,
  };
}
