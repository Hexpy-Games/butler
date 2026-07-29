import type { OperationAuthority } from "../core/index.ts";
import type { CorrectionExecutionRequirement } from "../planning/index.ts";
import type { requireCurrentAttempt } from "../turn/index.ts";

type ExecutionTarget =
  ReturnType<typeof requireCurrentAttempt>["executionTarget"]["target"];

export function scopeTaskExecution(input: {
  admittedAuthority: OperationAuthority;
  target: ExecutionTarget;
  artifactTargetScopeRef?: string;
  correctionRequirement?: CorrectionExecutionRequirement;
  externalEffect?: {
    ref: { id: string; sha256: string };
    occurrenceKey: string;
    targetScopeRef: string;
  };
}): {
  targetScopeRefs: string[];
  operationAuthority: OperationAuthority;
} {
  if (
    input.correctionRequirement?.kind === "workspace_mutation" &&
    input.target.kind !== "provisioned_workspace"
  ) {
    throw new Error("Workspace correction requires a provisioned workspace Task");
  }
  if (input.target.kind === "provisioned_workspace") {
    if (!input.artifactTargetScopeRef) {
      throw new Error("Provisioned workspace is missing its artifact target scope");
    }
    return {
      targetScopeRefs: [],
      operationAuthority: {
        observationScopeRefs: input.admittedAuthority.observationScopeRefs.filter(
          (scopeRef) => scopeRef !== input.artifactTargetScopeRef,
        ),
        mutation: {
          kind: "workspace_only",
          workspaceRef: input.target.workspaceRef,
          operationRoot: input.target.operationRoot,
          mutationScope: correctionMutationScope(input),
        },
      },
    };
  }
  if (input.target.kind === "repository_promotion") {
    if (input.correctionRequirement?.kind === "observation_only") {
      return observationOnly(input.admittedAuthority);
    }
    return {
      targetScopeRefs: [],
      operationAuthority: {
        observationScopeRefs: input.admittedAuthority.observationScopeRefs,
        mutation: {
          kind: "repository_promotion_only",
          authorizationRef: input.target.authorizationRef,
          candidateRef: input.target.candidateRef,
          resolutionRef: input.target.resolutionRef,
          baselineRef: input.target.baselineRef,
          finalSnapshotRef: input.target.finalSnapshotRef,
        },
      },
    };
  }
  if (input.externalEffect) {
    if (input.correctionRequirement?.kind === "observation_only") {
      return observationOnly(input.admittedAuthority, input.target.targetScopeRefs);
    }
    if (!input.target.targetScopeRefs.includes(input.externalEffect.targetScopeRef)) {
      throw new Error("External Effect target is outside the current Task target");
    }
    return {
      targetScopeRefs: input.target.targetScopeRefs,
      operationAuthority: {
        observationScopeRefs: input.admittedAuthority.observationScopeRefs,
        mutation: {
          kind: "external_effect_only",
          effectIntentRef: input.externalEffect.ref,
          occurrenceKey: input.externalEffect.occurrenceKey,
          targetScopeRef: input.externalEffect.targetScopeRef,
        },
      },
    };
  }
  return {
    targetScopeRefs: input.target.targetScopeRefs,
    operationAuthority: input.correctionRequirement?.kind === "observation_only"
      ? { ...input.admittedAuthority, mutation: { kind: "forbidden" } }
      : input.admittedAuthority,
  };
}

function correctionMutationScope(
  input: Parameters<typeof scopeTaskExecution>[0],
) {
  if (input.target.kind !== "provisioned_workspace") {
    throw new Error("Correction mutation scope requires a workspace target");
  }
  const requirement = input.correctionRequirement;
  if (!requirement) return input.target.mutationScope;
  if (requirement.kind === "observation_only") return { kind: "read_only" } as const;
  if (requirement.workspaceScopeRef !== input.artifactTargetScopeRef) {
    throw new Error("Correction workspace scope differs from current Task authority");
  }
  const accepted = input.target.mutationScope;
  if (
    accepted.kind !== "contained_paths" ||
    !requirement.writablePaths.every((requested) =>
      accepted.writablePaths.some((owned) => contains(owned, requested)))
  ) {
    throw new Error("Correction writable paths exceed current Task authority");
  }
  return { kind: "contained_paths" as const, writablePaths: requirement.writablePaths };
}

function observationOnly(
  authority: OperationAuthority,
  targetScopeRefs: string[] = [],
) {
  return {
    targetScopeRefs,
    operationAuthority: { ...authority, mutation: { kind: "forbidden" as const } },
  };
}

function contains(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}
