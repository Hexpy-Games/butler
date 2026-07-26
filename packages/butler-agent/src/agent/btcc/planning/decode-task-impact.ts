import {
  requireRecord,
  requireString,
  requireStringArray,
  type ContentRef,
} from "../core/index.ts";
import type { ManagedTask } from "./contracts.ts";
import type { TaskImpact } from "./correction-contracts.ts";

type CurrentTaskState = {
  task: Pick<ManagedTask, "ref" | "taskLogicalId">;
  status: string;
  hasCurrentResult: boolean;
};

export function decodeTaskImpact(input: {
  submission: unknown;
  currentTasks: CurrentTaskState[];
  nextTasks: ManagedTask[];
}): TaskImpact[] {
  if (
    !Array.isArray(input.submission) ||
    input.submission.length !== input.currentTasks.length
  ) {
    throw new Error(
      "Feedback Planning impact map must cover every current Task",
    );
  }
  const current = new Map(
    input.currentTasks.map((state) => [state.task.taskLogicalId, state]),
  );
  const next = new Map(
    input.nextTasks.map((task) => [task.taskLogicalId, task]),
  );
  const visitedPrior = new Set<string>();
  const visitedSuccessor = new Set<string>();

  const impacts = input.submission.map((item, index) => {
    const record = requireRecord(item, `impactMap[${index}]`);
    const priorTaskLogicalId = requireString(
      record.priorTaskLogicalId,
      `impactMap[${index}].priorTaskLogicalId`,
    );
    const prior = current.get(priorTaskLogicalId);
    if (!prior || visitedPrior.has(priorTaskLogicalId)) {
      throw new Error("Feedback Planning changed or repeated a current Task");
    }
    visitedPrior.add(priorTaskLogicalId);
    const disposition = requireDisposition(record.disposition);
    const successorTaskLogicalId = record.successorTaskLogicalId
      ? requireString(
          record.successorTaskLogicalId,
          `impactMap[${index}].successorTaskLogicalId`,
        )
      : undefined;
    const successor = successorTaskLogicalId
      ? next.get(successorTaskLogicalId)
      : undefined;
    validateSuccessor({ disposition, prior, successor });
    if (successor) {
      if (visitedSuccessor.has(successor.taskLogicalId)) {
        throw new Error(
          "Feedback Planning mapped more than one prior Task to one successor",
        );
      }
      visitedSuccessor.add(successor.taskLogicalId);
    }
    const base = {
      priorTaskRef: prior.task.ref,
      reason: requireString(record.reason, `impactMap[${index}].reason`),
    };
    if (disposition === "replan") return { ...base, disposition };
    if (!successor) throw new Error(`${disposition} impact lost its successor Task`);
    if (disposition === "revalidate") {
      return {
        ...base,
        disposition,
        successorTaskRef: successor.ref,
        revalidationPrerequisiteTaskRefs:
          decodeRevalidationPrerequisites(record, successor, next),
      };
    }
    return { ...base, disposition, successorTaskRef: successor.ref };
  });
  if (visitedPrior.size !== current.size) {
    throw new Error("Feedback Planning omitted a current Task");
  }
  return impacts;
}

function decodeRevalidationPrerequisites(
  record: Record<string, unknown>,
  successor: ManagedTask | undefined,
  next: Map<string, ManagedTask>,
): ContentRef[] {
  if (!successor) return [];
  const ids = requireStringArray(
    record.revalidationPrerequisiteTaskLogicalIds,
    "revalidationPrerequisiteTaskLogicalIds",
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("Revalidation repeated a prerequisite Task");
  }
  const dependencyIds = new Set(successor.dependencyTaskRefs.map((ref) => ref.id));
  return ids.map((logicalId) => {
    const prerequisite = next.get(logicalId);
    if (!prerequisite || prerequisite.taskLogicalId === successor.taskLogicalId) {
      throw new Error("Revalidation prerequisite is not a distinct revised Task");
    }
    if (
      prerequisite.executionOrdinal >= successor.executionOrdinal ||
      !dependencyIds.has(prerequisite.ref.id)
    ) {
      throw new Error(
        `Revalidation Task ${successor.taskLogicalId} must run after and depend on ` +
        `prerequisite ${logicalId}`,
      );
    }
    return prerequisite.ref;
  });
}

function validateSuccessor(input: {
  disposition: TaskImpact["disposition"];
  prior: CurrentTaskState;
  successor?: ManagedTask;
}): void {
  if (input.disposition !== "replan" && !input.successor) {
    throw new Error(
      `${input.disposition} impact requires a current successor Task`,
    );
  }
  if (!input.successor) return;
  if (
    (input.disposition === "unaffected" ||
      input.disposition === "revalidate") &&
    input.successor.taskLogicalId !== input.prior.task.taskLogicalId
  ) {
    throw new Error(
      `${input.disposition} impact must preserve Task logical identity`,
    );
  }
  if (
    input.disposition === "unaffected" &&
    refKey(input.successor.ref) !== refKey(input.prior.task.ref)
  ) {
    throw new Error(
      `unaffected impact for Task ${input.prior.task.taskLogicalId} cannot change ` +
      "the Task revision; preserve the exact accepted Task or classify it as " +
      "revalidate, rework, or replan",
    );
  }
  if (
    input.disposition === "revalidate" &&
    (input.prior.status !== "accepted" || !input.prior.hasCurrentResult)
  ) {
    throw new Error(
      `Task ${input.prior.task.taskLogicalId} has status ${input.prior.status} ` +
      `and currentResult=${input.prior.hasCurrentResult}; revalidate requires an ` +
      "accepted concrete result, so classify this changed Task as rework or replan",
    );
  }
}

function requireDisposition(value: unknown): TaskImpact["disposition"] {
  if (
    value !== "unaffected" &&
    value !== "revalidate" &&
    value !== "rework" &&
    value !== "replan"
  ) {
    throw new Error("Feedback Planning impact disposition is invalid");
  }
  return value;
}

function refKey(ref: ContentRef): string {
  return `${ref.id}\0${ref.sha256}`;
}
