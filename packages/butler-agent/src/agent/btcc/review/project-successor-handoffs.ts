import type { ContentRef } from "../core/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

export type DirectSuccessorHandoff = {
  taskRef: ContentRef;
  taskLogicalId: string;
  intendedOutcome: string;
  executionOrdinal: number;
  artifactPolicy: ReviewedManagedProgramState["tasks"][number]["task"]["artifactPolicy"];
  criteria: ReviewedManagedProgramState["criteria"];
  verificationQuestions: ReviewedManagedProgramState["verificationQuestions"];
};

export function projectDirectSuccessorHandoffs(
  program: ReviewedManagedProgramState,
): DirectSuccessorHandoff[] {
  const currentTaskRef = program.currentTask.task.ref;
  const currentWorkTaskRefs = new Set(program.currentWork.work.taskRefs.map(refKey));

  return program.tasks
    .map((state) => state.task)
    .filter((task) =>
      currentWorkTaskRefs.has(refKey(task.ref)) &&
      task.dependencyTaskRefs.some((dependency) => sameRef(dependency, currentTaskRef)),
    )
    .sort((left, right) => left.executionOrdinal - right.executionOrdinal)
    .map((task) => ({
      taskRef: task.ref,
      taskLogicalId: task.taskLogicalId,
      intendedOutcome: task.intendedOutcome,
      executionOrdinal: task.executionOrdinal,
      artifactPolicy: task.artifactPolicy,
      criteria: task.criterionRefs.map((ref) =>
        requireRef(program.criteria, ref, "successor criterion"),
      ),
      verificationQuestions: task.verificationQuestionRefs.map((ref) =>
        requireRef(program.verificationQuestions, ref, "successor verification question"),
      ),
    }));
}

function requireRef<T extends { ref: ContentRef }>(
  records: T[],
  ref: ContentRef,
  label: string,
): T {
  const record = records.find((candidate) => sameRef(candidate.ref, ref));
  if (!record) throw new Error(`Review cannot resolve a ${label}`);
  return record;
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function refKey(ref: ContentRef): string {
  return `${ref.id}:${ref.sha256}`;
}
