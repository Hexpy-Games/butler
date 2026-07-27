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
