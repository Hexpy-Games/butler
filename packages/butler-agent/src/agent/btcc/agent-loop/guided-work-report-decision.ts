import { dispositionMaterialFingerprint, type DurableWorkView } from "../work/index.ts";

export type AcceptedWorkResult = { status: "success" | "blocked" };
export type GuidedWorkReportDecision =
  | { status: "report"; result?: AcceptedWorkResult }
  | { status: "continue"; observation: string };

/** A declaration describes the current Work, not just a successful tool call. */
export function isFreshCurrentDisposition(work: DurableWorkView | null, turnId: string): boolean {
  if (!work || work.status === "abandoned") return true;
  const disposition = work.latestDisposition;
  return Boolean(disposition && disposition.originTurnId === turnId &&
    disposition.disposition === work.status && disposition.materialFingerprint &&
    disposition.materialFingerprint === dispositionMaterialFingerprint(work));
}

/** Ordinary conversations may yield open Work; a delegated assignment must finish or block. */
export function guidedWorkReportDecision(
  work: DurableWorkView | null,
  turnId: string,
  requiresTerminalResult: boolean,
): GuidedWorkReportDecision {
  if (work && isFreshCurrentDisposition(work, turnId)) {
    if (work.status === "completed") return { status: "report", result: { status: "success" } };
    if (work.status === "blocked") return { status: "report", result: { status: "blocked" } };
  }
  if (!requiresTerminalResult && isFreshCurrentDisposition(work, turnId)) return { status: "report" };
  return {
    status: "continue",
    observation: requiresTerminalResult
      ? "The delegated assignment is still open. Continue the remaining actions in the same Work and workspace using the current Plan and results. An open disposition saves progress; it does not finish this assignment. When the requested work is done, record completed and report. If a real external blocker prevents further work, record blocked with the reason and report. Use the existing wait or approval flow when waiting is necessary."
      : "Before reporting the final answer, call record_work_disposition for the explicitly bound Work. Choose completed, open, or blocked with a concise summary and valid action/evidence details, then report.",
  };
}
