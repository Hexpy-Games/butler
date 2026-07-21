import {
  contentRef,
  requireRecord,
  requireString,
  requireStringArray,
  type ContentRef,
} from "../../core/index.ts";
import type { ManagedTask, PlanningCandidate } from "../contracts.ts";

export type DraftArtifactPolicy =
  | {
      kind: "workspace_artifact";
      targetScopeRef: string;
      baselinePolicy: "capture_at_workspace_provision";
    }
  | { kind: "repository_promotion"; targetScopeRef: string };

export function readArtifactPolicy(
  value: unknown,
  label: string,
  workspaceScopeRef: string,
): DraftArtifactPolicy | undefined {
  if (value === undefined) return undefined;
  const policy = requireRecord(value, `${label}.artifactPolicy`);
  const kind = requireString(policy.kind, `${label}.artifactPolicy.kind`);
  if (kind === "workspace_artifact") {
    return {
      kind,
      targetScopeRef: workspaceScopeRef,
      baselinePolicy: "capture_at_workspace_provision",
    };
  }
  if (kind === "repository_promotion") {
    return { kind, targetScopeRef: workspaceScopeRef };
  }
  throw new Error("Task artifact policy is invalid");
}

export function authorArtifactLifecycle(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
  programId: string,
): PlanningCandidate["artifactLifecycle"] {
  const promotionSelectors = materializePromotionSelectors(submission, tasks);
  const body = {
    programId,
    taskPolicies: tasks.map((task) => ({ taskRef: task.ref, policy: task.artifactPolicy })),
    promotionSelectors,
    promotionTaskRefs: tasks
      .filter((task) => task.artifactPolicy.kind === "repository_promotion")
      .map((task) => task.ref),
    effectIntentRefs: [] as [],
    integrationCriteria: [] as [],
    promotionProtocol: promotionSelectors.length === 0
      ? "not_applicable" as const
      : "journaled_complete_target_exchange_v1" as const,
  };
  return { ref: contentRef("artifact-lifecycle", body), ...body };
}

function materializePromotionSelectors(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
) {
  if (submission.promotionSelectors === undefined) return [];
  if (!Array.isArray(submission.promotionSelectors)) {
    throw new Error("promotionSelectors must be an array");
  }
  const byLogicalId = new Map(tasks.map((task) => [task.taskLogicalId, task]));
  return submission.promotionSelectors.map((item, index) => {
    const draft = requireRecord(item, `promotionSelectors[${index}]`);
    const implementationTaskRefs = requireStringArray(
      draft.implementationTaskIds,
      "implementationTaskIds",
    ).map((id) => requiredTask(byLogicalId, id, "implementation"));
    const integrationTaskRef = requiredTask(
      byLogicalId,
      requireString(draft.integrationTaskId, "integrationTaskId"),
      "integration",
    );
    const promotionTaskRef = requiredTask(
      byLogicalId,
      requireString(draft.promotionTaskId, "promotionTaskId"),
      "promotion",
    );
    const promotionTask = tasks.find((task) => task.ref.id === promotionTaskRef.id)!;
    if (promotionTask.artifactPolicy.kind !== "repository_promotion") {
      throw new Error("Promotion selector names a non-promotion Task");
    }
    const body = {
      targetScopeRef: promotionTask.artifactPolicy.targetScopeRef,
      implementationTaskRefs,
      integrationTaskRef,
      promotionTaskRef,
      baselinePolicy: "capture_at_workspace_provision" as const,
      promotionProtocol: "journaled_complete_target_exchange_v1" as const,
    };
    return { ref: contentRef("promotion-selector", body), ...body };
  });
}

function requiredTask(
  tasks: Map<string, ManagedTask>,
  logicalId: string,
  role: string,
): ContentRef {
  const task = tasks.get(logicalId);
  if (!task) throw new Error(`Promotion selector has no ${role} Task: ${logicalId}`);
  return task.ref;
}
