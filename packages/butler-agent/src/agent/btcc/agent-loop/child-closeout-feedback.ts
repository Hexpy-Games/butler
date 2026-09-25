import { unresolvedWorkActionKeys, type DurableWorkView } from "../work/index.ts";
import type { GuidedToolJournalRecord } from "../ports/index.ts";
import type { AcceptedWorkResult } from "./guided-work-report-decision.ts";

/**
 * A delegated child that replies without a terminal disposition gets one
 * actionable correction. A second text-only reply settles as `incomplete`
 * for the parent to re-plan; it is never a runtime failure or user-facing.
 */
export function childCloseoutObservation(input: {
  work: DurableWorkView | null;
  candidateWorkId?: string;
}): string {
  const exits = [
    "record_work_disposition completed, with evidence, when the requested work is done;",
    "record_work_disposition blocked, with evidence and a next_condition, only for a real external blocker;",
    "record_work_disposition blocked with blocked_code needs_user_decision when only the user can decide, stating the exact question in next_condition.",
  ];
  if (!input.work) {
    return [
      "Your reply was not delivered as the assignment result: no Work is bound to this Turn, so the assignment has no terminal disposition.",
      input.candidateWorkId
        ? `Bind the assigned Work with continue_work (work_id: ${input.candidateWorkId}); use start_work only if no assigned Work exists.`
        : "Bind the assigned Work with continue_work, or start_work if no assigned Work exists.",
      "Then continue the remaining work and finish with one of:",
      ...exits,
    ].join("\n");
  }
  const unresolved = unresolvedWorkActionKeys(input.work.actionProgress);
  return [
    `Your reply was not delivered as the assignment result: Work ${input.work.workId} is ${input.work.status} and has no terminal disposition from this Turn.`,
    unresolved.length
      ? `Unresolved Plan actions: ${unresolved.join(", ")}. Continue them with tools, or finish with one of:`
      : "Finish with one of:",
    ...exits,
    "Saving open records progress only; it does not end the assignment.",
  ].join("\n");
}

/** The incomplete child result: the model's own text plus the recorded Work facts. */
export function incompleteChildResult(work: DurableWorkView | null, text: string): {
  result: AcceptedWorkResult;
  text: string;
} {
  const evidence = workEvidence(work);
  return {
    result: { status: "incomplete", code: "child_closeout_missing", evidence },
    text: text.trim() || `No final report was written. ${evidence[0] ?? "No Work was bound."}`,
  };
}

/** A blocked disposition carries its recorded code; needs_user_decision is relayed upward. */
export function blockedChildResult(
  work: DurableWorkView,
  records: readonly GuidedToolJournalRecord[],
): AcceptedWorkResult {
  const disposition = [...records].reverse().find((record) =>
    record.toolName === "record_work_disposition" && record.status === "completed" &&
    record.arguments.disposition === "blocked");
  const code = disposition?.arguments.blocked_code === "needs_user_decision"
    ? "needs_user_decision"
    : undefined;
  return { status: "blocked", ...(code ? { code } : {}), evidence: workEvidence(work) };
}

export function abandonedChildResult(work: DurableWorkView): AcceptedWorkResult {
  return { status: "blocked", code: "work_abandoned", evidence: workEvidence(work) };
}

function workEvidence(work: DurableWorkView | null): string[] {
  if (!work) return [];
  const unresolved = unresolvedWorkActionKeys(work.actionProgress);
  return [
    `Work ${work.workId} status: ${work.status}`,
    ...(unresolved.length ? [`Unresolved actions: ${unresolved.join(", ")}`] : []),
    ...(work.latestCheckpoint?.publicSummary ? [`Latest checkpoint: ${work.latestCheckpoint.publicSummary}`] : []),
    ...(work.latestDisposition?.summary ? [`Latest disposition: ${work.latestDisposition.disposition}: ${work.latestDisposition.summary}`] : []),
    ...(work.latestDisposition?.nextCondition ? [`Next condition: ${work.latestDisposition.nextCondition}`] : []),
  ];
}
