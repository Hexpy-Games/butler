import { describe, expect, test } from "bun:test";
import { authorPlanCandidate } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import { PLANNING_AUTHORING_CONTRACTS } from
  "../../packages/butler-agent/src/agent/btcc/planning/authoring-contracts.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

describe("BTCC Planning artifact-policy contract", () => {
  test("states the semantic boundary between transient results and workspace lineage", () => {
    const artifactBoundary = PLANNING_AUTHORING_CONTRACTS[0]?.applicableRules
      .filter((rule) =>
        rule.includes("non_artifact") || rule.includes("workspace_artifact"),
      )
      .join("\n") ?? "";

    expect(artifactBoundary).toContain(
      "transient observation, answer datum, or external fact/receipt",
    );
    expect(artifactBoundary).toContain(
      "does not create, modify, or require versioned workspace bytes",
    );
    expect(artifactBoundary).toContain("accepted versioned workspace bytes themselves");
    expect(artifactBoundary).toContain("exact review source");
  });

  test("defaults an omitted artifact policy to non-artifact", () => {
    const candidate = authorPlanCandidate({
      strategy: "Observe the admitted target and return the accepted datum.",
      works: [{
        logicalId: "observe",
        outcome: "The requested datum is observed and accepted.",
        dependencyWorkIds: [],
        tasks: [{
          logicalId: "observe-datum",
          intendedOutcome: "Return the transient observation.",
          dependencyTaskIds: [],
          effectClass: "none",
          targetScopeRefs: ["workspace:/repo"],
          criteria: [{
            statement: "The requested observation is returned exactly.",
            question: "Does the result answer the accepted request?",
            sourceGoalFieldIds: ["request", "intended_result"],
            sourceRequiredOutcomeRefs: ["required-outcome-1"],
          }],
        }],
      }],
      risks: [],
      assumptions: [],
      effectIntents: [],
      integrationCriteria: [],
      promotionSelectors: [],
    }, {
      ledgerId: "ledger-1",
      programId: "program-1",
      observedManifestRevision: 1,
      goalContractRef: ref("goal"),
      authorityRef: ref("authority"),
      governingSpecRefs: [ref("spec")],
      requiredOutcomeId: "required-outcome-1",
      artifactPersistence: "not_required",
      workspaceScopeRef: "workspace:/repo",
      specParentRootId: "project-1",
    });

    expect(candidate.tasks[0]?.artifactPolicy).toEqual({
      kind: "non_artifact",
      targetScopeRefs: ["workspace:/repo"],
    });
    expect(candidate.artifactLifecycle.promotionProtocol).toBe("not_applicable");
  });
});
