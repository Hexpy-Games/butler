import { expect, test } from "bun:test";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { authorPlanCandidate } from "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";

test("read-only workspace lineage may own one exact external effect", () => {
  const candidate = authorPlanCandidate({
    strategy: "Observe the accepted workspace revision, then reconcile its exact Ledger state.",
    works: [{
      logicalId: "reconcile-work",
      outcome: "The Ledger reflects the observed workspace result.",
      dependencyWorkIds: [],
      tasks: [{
        logicalId: "reconcile-ledger",
        displayTitle: "Ledger reconcile",
        intendedOutcome: "Read the workspace result and reconcile the exact Ledger target.",
        dependencyTaskIds: [],
        targetScopeRefs: ["workspace:/repo", "ledger:project"],
        effectClass: "external_effect",
        artifactPolicy: {
          kind: "workspace_artifact",
          workspacePath: ".",
          mutationScope: { kind: "read_only" },
        },
        criteria: [{
          statement: "The exact observed result is reflected in the Ledger.",
          question: "Does the Ledger match the accepted workspace result?",
          sourceGoalFieldIds: ["request", "intended_result"],
          sourceRequiredOutcomeRefs: ["required-outcome"],
        }],
      }],
    }],
    risks: [],
    assumptions: [],
    effectIntents: [{
      occurrenceKey: "reconcile-ledger",
      taskId: "reconcile-ledger",
      actionKind: "external_target_mutation",
      requiredTargetEffectId: "reconcile-ledger",
      action: "reconcile_project_ledger",
      payload: "Bind the exact accepted result.",
      desiredOutcome: "Ledger and workspace agree.",
      sourceGoalFieldIds: ["request", "intended_result"],
      sourceRequiredOutcomeRefs: ["required-outcome"],
    }],
    integrationCriteria: [],
    promotionSelectors: [],
  }, {
    ledgerId: "ledger:project",
    programId: "program",
    observedManifestRevision: 1,
    goalContractRef: contentRef("goal", { request: "reconcile" }),
    authorityRef: contentRef("authority", { scope: "project" }),
    governingSpecRefs: [],
    availableSpecs: [],
    requireGoverningSpec: false,
    requiredOutcomeId: "required-outcome",
    requiredTargetEffects: [{
      effectId: "reconcile-ledger",
      targetScopeRef: "ledger:project",
      desiredOutcome: "Ledger and workspace agree.",
    }],
    artifactPersistence: "not_required",
    workspaceScopeRef: "workspace:/repo",
  });

  expect(candidate.tasks[0]).toMatchObject({
    effectClass: "external_effect",
    targetScopeRefs: ["workspace:/repo", "ledger:project"],
    artifactPolicy: { kind: "workspace_artifact", mutationScope: { kind: "read_only" } },
  });
  expect(candidate.effectIntents[0]?.targetScopeRef).toBe("ledger:project");
  expect(candidate.effectIntents[0]).toMatchObject({
    normalizedPayload: "Bind the exact accepted result.",
    desiredOutcome: "Ledger and workspace agree.",
  });
  expect(candidate.effectIntents[0]?.normalizedPayloadSha256).toBe(
    contentRef("effect-payload", "Bind the exact accepted result.").sha256,
  );
  expect(candidate.effectIntents[0]?.desiredOutcomeSha256).toBe(
    contentRef("effect-desired-outcome", "Ledger and workspace agree.").sha256,
  );
});

test("every Goal target mutation has one exact external effect boundary", () => {
  const requiredTargetEffects = [{
    effectId: "commit-local-main",
    targetScopeRef: "git:local/main",
    desiredOutcome: "Local main points to the reviewed commit.",
  }];
  const submission = {
    strategy: "Commit the reviewed target through its exact Git ref boundary.",
    works: [{
      logicalId: "commit-work",
      outcome: "The local Git ref contains the reviewed change.",
      dependencyWorkIds: [],
      tasks: [{
        logicalId: "commit-main",
        displayTitle: "Commit local main",
        intendedOutcome: requiredTargetEffects[0]!.desiredOutcome,
        dependencyTaskIds: [],
        targetScopeRefs: [requiredTargetEffects[0]!.targetScopeRef],
        effectClass: "external_effect" as const,
        criteria: [{
          statement: requiredTargetEffects[0]!.desiredOutcome,
          question: "Does local main point to the reviewed commit?",
          sourceGoalFieldIds: ["request", "intended_result"] as const,
          sourceRequiredOutcomeRefs: ["required-outcome"],
        }],
      }],
    }],
    risks: [],
    assumptions: [],
    effectIntents: [{
      occurrenceKey: "commit-main-once",
      taskId: "commit-main",
      actionKind: "external_target_mutation" as const,
      requiredTargetEffectId: "commit-local-main",
      action: "commit_reviewed_bytes",
      payload: "Create one local main commit.",
      desiredOutcome: requiredTargetEffects[0]!.desiredOutcome,
      sourceGoalFieldIds: ["request", "intended_result"] as const,
      sourceRequiredOutcomeRefs: ["required-outcome"],
    }],
    integrationCriteria: [],
    promotionSelectors: [],
  };
  const state = {
    ledgerId: "ledger:project",
    programId: "program",
    observedManifestRevision: 1,
    goalContractRef: contentRef("goal", { request: "commit" }),
    authorityRef: contentRef("authority", { scope: "project" }),
    governingSpecRefs: [],
    availableSpecs: [],
    requireGoverningSpec: false,
    requiredOutcomeId: "required-outcome",
    requiredTargetEffects,
    artifactPersistence: "not_required" as const,
    workspaceScopeRef: "workspace:/repo",
  };

  const candidate = authorPlanCandidate(submission, state);
  expect(candidate.effectIntents[0]).toMatchObject({
    sourceRequiredTargetEffectId: "commit-local-main",
    targetScopeRef: "git:local/main",
  });

  expect(() => authorPlanCandidate({ ...submission, effectIntents: [] }, state))
    .toThrow("External-effect Task has no EffectIntent");
});
