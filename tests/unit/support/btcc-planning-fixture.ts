export function artifactTask(
  logicalId: string,
  dependencyTaskIds: string[],
  goalField: "request" | "intended_result",
  kind: "workspace_artifact" | "repository_promotion",
) {
  return {
    logicalId,
    intendedOutcome: `${logicalId} outcome`,
    dependencyTaskIds,
    targetScopeRefs: [],
    effectClass: kind === "repository_promotion" ? "external_effect" as const : "none" as const,
    artifactPolicy: kind === "workspace_artifact"
      ? {
          kind,
          workspacePath: "packages/feature",
          mutationScope: logicalId === "integrate"
            ? { kind: "read_only" as const }
            : { kind: "contained_paths" as const, writablePaths: ["src/feature.ts"] },
        }
      : { kind, targetPath: "packages/feature" },
    criteria: [{
      statement: `${logicalId} is complete.`,
      question: `Is ${logicalId} complete?`,
      sourceGoalFieldIds: [goalField],
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
    }],
  };
}
