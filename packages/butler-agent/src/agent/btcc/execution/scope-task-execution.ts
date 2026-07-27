import type { OperationAuthority } from "../core/index.ts";
import type { requireCurrentAttempt } from "../turn/index.ts";

type ExecutionTarget =
  ReturnType<typeof requireCurrentAttempt>["executionTarget"]["target"];

export function scopeTaskExecution(input: {
  admittedAuthority: OperationAuthority;
  target: ExecutionTarget;
  artifactTargetScopeRef?: string;
  externalEffect?: {
    ref: { id: string; sha256: string };
    occurrenceKey: string;
    targetScopeRef: string;
  };
}): {
  targetScopeRefs: string[];
  operationAuthority: OperationAuthority;
} {
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
          mutationScope: input.target.mutationScope,
        },
      },
    };
  }
  if (input.target.kind === "repository_promotion") {
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
    operationAuthority: input.admittedAuthority,
  };
}
