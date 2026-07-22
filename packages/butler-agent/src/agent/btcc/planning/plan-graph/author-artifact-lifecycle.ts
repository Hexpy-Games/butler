import { contentRef, requireRecord, requireString, type ContentRef } from "../../core/index.ts";
import type {
  ManagedEffectIntent,
  ManagedIntegrationCriterion,
  ManagedTask,
  PlanningCandidate,
} from "../contracts.ts";
import {
  materializeEffectIntents,
  materializeIntegrationCriteria,
  materializePromotionSelectors,
} from "./author-lifecycle-records.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

export type DraftArtifactPolicy =
  | {
      kind: "workspace_artifact";
      targetScopeRef: string;
      targetPath: string;
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
  const targetPath = requireContainedTargetPath(
    requireString(policy.targetPath, `${label}.artifactPolicy.targetPath`),
  );
  const targetScopeRef = containedWorkspaceScope(workspaceScopeRef, targetPath);
  if (kind === "workspace_artifact") {
    return {
      kind,
      targetScopeRef,
      targetPath,
      baselinePolicy: "capture_at_workspace_provision",
    };
  }
  if (kind === "repository_promotion") return { kind, targetScopeRef, targetPath };
  rejectPlanningProposal("artifact_policy_invalid", "Task artifact policy is invalid");
}

export function authorArtifactLifecycle(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
  authority: {
    programId: string;
    requiredOutcomeId: string;
    authorityRef: ContentRef;
  },
): {
  lifecycle: PlanningCandidate["artifactLifecycle"];
  effectIntents: ManagedEffectIntent[];
  integrationCriteria: ManagedIntegrationCriterion[];
} {
  const selectors = materializePromotionSelectors(submission, tasks);
  const effects = materializeEffectIntents(submission, tasks, selectors, authority);
  const integration = materializeIntegrationCriteria(submission, tasks, selectors, authority);
  const body = {
    programId: authority.programId,
    taskPolicies: tasks.map((task) => ({
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

function requireContainedTargetPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") || normalized.length === 0 || normalized === "." ||
    normalized.includes("\0") || normalized[1] === ":"
  ) {
    rejectPlanningProposal(
      "artifact_target_invalid",
      "Artifact targetPath must name a workspace-relative contained target",
    );
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    rejectPlanningProposal(
      "artifact_target_escapes",
      "Artifact targetPath escapes or ambiguously names the workspace",
    );
  }
  return segments.join("/");
}

function containedWorkspaceScope(workspaceScopeRef: string, targetPath: string): string {
  const scope = workspaceScopeRef.endsWith("/") ? workspaceScopeRef.slice(0, -1) : workspaceScopeRef;
  return `${scope}/${targetPath}`;
}
