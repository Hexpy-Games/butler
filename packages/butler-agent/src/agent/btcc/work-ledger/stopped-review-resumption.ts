import type { ContentRef } from "../core/index.ts";
import type { ManagedTaskState } from "./contracts.ts";

export type StoppedReviewProvenance = {
  stoppedTaskRef?: ContentRef;
  stoppedResultRef?: ContentRef;
};

export function resolveStoppedReviewTask(
  provenance: StoppedReviewProvenance,
  priorTasks: ManagedTaskState[],
): ManagedTaskState | null {
  if (!provenance.stoppedResultRef) return null;
  const taskRef = provenance.stoppedTaskRef;
  if (!taskRef) throw integrity("Stopped ResultCandidate has no Task identity");
  const task = priorTasks.find((candidate) => sameRef(candidate.task.ref, taskRef));
  if (!task) throw integrity("Stopped Task identity is not present in the current Program");
  if (task.status !== "result_submitted") {
    throw integrity("Stopped Task is not awaiting Task Review");
  }
  const result = task.currentResult;
  if (!result || result.kind !== "result_candidate") {
    throw integrity("Stopped Task has no immutable ResultCandidate");
  }
  if (
    result.result.kind !== "non_artifact" &&
    result.result.kind !== "workspace_artifact" &&
    result.result.kind !== "repository_promotion"
  ) {
    throw integrity("Stopped immutable record is not a ResultCandidate");
  }
  if (!sameRef(result.result.ref, provenance.stoppedResultRef)) {
    throw integrity("Stopped ResultCandidate identity does not match the current Task result");
  }
  if (!sameRef(result.result.taskRef, taskRef) || result.result.taskRevisionSha256 !== taskRef.sha256) {
    throw integrity("Stopped ResultCandidate does not belong to the exact Task revision");
  }
  const attempt = task.attempts.at(-1);
  if (
    !attempt ||
    attempt.status !== "result_submitted" ||
    !sameRef(attempt.attemptRecord.ref, result.result.attemptRef)
  ) {
    throw integrity("Stopped ResultCandidate does not belong to the current Attempt");
  }
  return task;
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function integrity(message: string): Error {
  return new Error(`Stopped continuation integrity violation: ${message}`);
}
