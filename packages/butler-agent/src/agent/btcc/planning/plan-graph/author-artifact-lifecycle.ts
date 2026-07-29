import { contentRef, requireRecord, requireString, type ContentRef } from "../../core/index.ts";
import type {
  ManagedEffectIntent,
  ManagedIntegrationCriterion,
  ManagedTask,
  PlanningCandidate,
  TaskMutationScope,
} from "../contracts.ts";
import type { GoalRequiredTargetEffect } from "../../conception/index.ts";
import {
  materializeEffectIntents,
  materializeIntegrationCriteria,
  materializePromotionSelectors,
} from "./author-lifecycle-records.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

export type DraftArtifactPolicy =
  | {
      kind: "workspace_artifact";
      workspaceScopeRef: string;
      workspacePath: string;
      mutationScope: TaskMutationScope;
      baselinePolicy: "capture_at_workspace_provision";
    }
  | { kind: "repository_promotion"; targetScopeRef: string; targetPath: string };

export function readArtifactPolicy(
  value: unknown,
  label: string,
  workspaceScopeRef: string,
): DraftArtifactPolicy | undefined {
  if (value === undefined) return undefined;
  const policy = requireRecord(value, `${label}.artifactPolicy`);
  const kind = requireString(policy.kind, `${label}.artifactPolicy.kind`);
  if (kind === "workspace_artifact") {
    const workspacePath = requireContainedPath(
      requireString(policy.workspacePath, `${label}.artifactPolicy.workspacePath`),
      "workspace_path",
    );
    return {
      kind,
      workspaceScopeRef: containedWorkspaceScope(workspaceScopeRef, workspacePath),
      workspacePath,
      mutationScope: readMutationScope(policy.mutationScope, label),
      baselinePolicy: "capture_at_workspace_provision",
    };
  }
  const targetPath = requireContainedPath(
    requireString(policy.targetPath, `${label}.artifactPolicy.targetPath`),
    "promotion_target",
  );
  const targetScopeRef = containedWorkspaceScope(workspaceScopeRef, targetPath);
  if (kind === "repository_promotion") return { kind, targetScopeRef, targetPath };
  rejectPlanningProposal("artifact_policy_invalid", "Task artifact policy is invalid");
}

function readMutationScope(value: unknown, label: string): TaskMutationScope {
  const scope = requireRecord(value, `${label}.artifactPolicy.mutationScope`);
  const kind = requireString(scope.kind, `${label}.artifactPolicy.mutationScope.kind`);
  if (kind === "read_only") return { kind };
  if (kind === "contained_paths") {
    if (!Array.isArray(scope.writablePaths) || scope.writablePaths.length === 0) {
      rejectPlanningProposal("artifact_mutation_scope_empty", "Writable mutation scope is empty");
    }
    const writablePaths = scope.writablePaths.map((path, index) => requireContainedPath(
      requireString(path, `${label}.artifactPolicy.mutationScope.writablePaths[${index}]`),
      "writable_path",
    ));
    if (new Set(writablePaths).size !== writablePaths.length) {
      rejectPlanningProposal("artifact_mutation_scope_duplicate", "Writable paths must be unique");
    }
    return { kind, writablePaths };
  }
  rejectPlanningProposal("artifact_mutation_scope_invalid", "Task mutation scope is invalid");
}

export function authorArtifactLifecycle(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
  authority: {
    programId: string;
    requiredOutcomeId: string;
    authorityRef: ContentRef;
    requiredTargetEffects: GoalRequiredTargetEffect[];
  },
  carriedArtifactTasks: ManagedTask[] = [],
): {
  lifecycle: PlanningCandidate["artifactLifecycle"];
  effectIntents: ManagedEffectIntent[];
  integrationCriteria: ManagedIntegrationCriterion[];
} {
  const selectableTasks = [...carriedArtifactTasks, ...tasks];
  const carriedTaskIds = new Set(carriedArtifactTasks.map((task) => task.ref.id));
  const selectors = materializePromotionSelectors(
    submission,
    selectableTasks,
    carriedTaskIds,
  );
  const effects = materializeEffectIntents(submission, tasks, selectors, authority);
  const integration = materializeIntegrationCriteria(
    submission,
    selectableTasks,
    selectors,
    authority,
  );
  const body = {
    programId: authority.programId,
    taskPolicies: selectableTasks.map((task) => ({
      taskRef: task.ref,
      policy: task.artifactPolicy,
      effectIntentRefs: effects
        .filter((effect) => effect.owningTaskKey.taskLogicalId === task.taskLogicalId)
        .map((effect) => effect.ref),
    })),
    promotionSelectors: selectors,
    promotionTaskRefs: tasks
      .filter((task) => task.artifactPolicy.kind === "repository_promotion")
      .map((task) => task.ref),
    effectIntentRefs: effects.map((effect) => effect.ref),
    integrationCriterionRefs: integration.map((criterion) => criterion.ref),
    promotionProtocol: selectors.length === 0
      ? "not_applicable" as const
      : "journaled_complete_target_exchange_v1" as const,
  };
  return {
    lifecycle: { ref: contentRef("artifact-lifecycle", body), ...body },
    effectIntents: effects,
    integrationCriteria: integration,
  };
}

type PathField = "workspace_path" | "promotion_target" | "writable_path";

const PATH_FIELD = {
  workspace_path: {
    code: "artifact_workspace_path_invalid",
    label: "workspacePath",
  },
  promotion_target: {
    code: "artifact_promotion_target_invalid",
    label: "repository-promotion targetPath",
  },
  writable_path: {
    code: "artifact_writable_path_invalid",
    label: "mutationScope writablePath",
  },
} as const;

function requireContainedPath(value: string, field: PathField): string {
  const normalized = value.replaceAll("\\", "/");
  const diagnostic = PATH_FIELD[field];
  if (
    normalized.startsWith("/") || normalized.length === 0 ||
    normalized.includes("\0") || normalized[1] === ":"
  ) {
    rejectPlanningProposal(
      diagnostic.code,
      `${diagnostic.label} must be relative to the admitted workspace scope; ` +
        "use \".\" for the exact admitted root",
    );
  }
  if (normalized === ".") return normalized;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    rejectPlanningProposal(
      diagnostic.code,
      `${diagnostic.label} must be a normalized contained path and cannot escape ` +
        "the admitted workspace scope",
    );
  }
  return segments.join("/");
}

function containedWorkspaceScope(workspaceScopeRef: string, targetPath: string): string {
  const scope = workspaceScopeRef.endsWith("/") ? workspaceScopeRef.slice(0, -1) : workspaceScopeRef;
  if (targetPath === ".") return scope;
  return `${scope}/${targetPath}`;
}
