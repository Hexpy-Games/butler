import { requireRecord, requireString } from "../core/index.ts";
import type {
  CorrectionExecutionRequirement,
  FeedbackPlanProduct,
  ManagedTask,
} from "./contracts.ts";

export function decodeCorrectionExecutionRequirement(
  value: unknown,
): CorrectionExecutionRequirement {
  const requirement = requireRecord(value, "CorrectionExecutionRequirement");
  const kind = requireString(requirement.kind, "CorrectionExecutionRequirement.kind");
  if (kind === "observation_only") return { kind };
  if (kind !== "workspace_mutation") {
    throw new Error("CorrectionExecutionRequirement kind is invalid");
  }
  const workspaceScopeRef = requireString(
    requirement.workspaceScopeRef,
    "CorrectionExecutionRequirement.workspaceScopeRef",
  );
  if (!Array.isArray(requirement.writablePaths) || requirement.writablePaths.length === 0) {
    throw new Error("CorrectionExecutionRequirement writable paths are empty");
  }
  const writablePaths = requirement.writablePaths.map((path, index) =>
    requireContainedCorrectionPath(
      requireString(path, `CorrectionExecutionRequirement.writablePaths[${index}]`),
    ));
  if (new Set(writablePaths).size !== writablePaths.length) {
    throw new Error("CorrectionExecutionRequirement writable paths must be unique");
  }
  return { kind, workspaceScopeRef, writablePaths };
}

export function assertAcceptedCorrectionFitsCurrentTask(
  candidate: FeedbackPlanProduct["candidate"],
  currentTask: ManagedTask,
): void {
  if (candidate.correctionKind !== "implementation_repair") return;
  const requirement = candidate.correctionPlan.executionRequirement;
  if (requirement.kind === "observation_only") return;

  const policy = currentTask.artifactPolicy;
  const mutationScope = policy.kind === "workspace_artifact"
    ? policy.mutationScope
    : undefined;
  if (
    policy.kind !== "workspace_artifact" ||
    policy.workspaceScopeRef !== requirement.workspaceScopeRef ||
    mutationScope?.kind !== "contained_paths" ||
    !requirement.writablePaths.every((requested) =>
      mutationScope.writablePaths.some((owned) => contains(owned, requested)))
  ) {
    throw new Error(
      "Accepted implementation repair exceeds current Task authority; " +
        "Feedback Planning Review must revise feedback_intent",
    );
  }
}

function contains(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function requireContainedCorrectionPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized || normalized.startsWith("/") || normalized.includes("\0") ||
    normalized[1] === ":"
  ) {
    throw new Error("CorrectionExecutionRequirement path must be workspace-relative");
  }
  if (normalized === ".") return normalized;
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("CorrectionExecutionRequirement path must remain inside the workspace");
  }
  return normalized;
}
