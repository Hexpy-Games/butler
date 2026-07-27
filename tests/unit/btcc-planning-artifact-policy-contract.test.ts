import { describe, expect, test } from "bun:test";
import { authorPlanCandidate } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import { PLANNING_AUTHORING_CONTRACTS } from
  "../../packages/butler-agent/src/agent/btcc/planning/authoring-contracts.ts";
import { resolveDutyInstructions } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/prompt-duty-catalog.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

describe("BTCC Planning artifact-policy contract", () => {
  test("states the semantic boundary between transient results and workspace lineage", () => {
    const artifactBoundary = PLANNING_AUTHORING_CONTRACTS[0]?.applicableRules
      .filter((rule) =>
        rule.includes("non_artifact") || rule.includes("workspace_artifact") ||
        rule.includes("read-only local command"),
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
    expect(artifactBoundary).toContain("read-only local command");
    expect(artifactBoundary).toContain("effectClass none");
    expect(artifactBoundary).toContain("no EffectIntent");
    expect(artifactBoundary).toContain("non-workspace user target or external system");
    const [effectDuty] = resolveDutyInstructions(["declare_effects_risks_assumptions"]);
    expect(effectDuty?.instruction).toContain("read-only local command is an observation");
    expect(effectDuty?.instruction).toContain("Never classify from a tool, process, command");
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

  test("materializes five visible read-only command Tasks without effects or artifacts", () => {
    const commands = ["pwd", "ls", "seq 1 1500", "du -sh .", "bun --version"];
    const candidate = authorPlanCandidate({
      strategy: "Run each requested command as one visible observation Task.",
      works: [{
        logicalId: "observe-commands",
        outcome: "All five requested local command observations are returned.",
        dependencyWorkIds: [],
        tasks: commands.map((command, index) => ({
          logicalId: `observe-command-${index + 1}`,
          intendedOutcome: `Return the transient output of ${command}.`,
          dependencyTaskIds: index === 0 ? [] : [`observe-command-${index}`],
          effectClass: "none",
          targetScopeRefs: ["workspace:/agent-runtime"],
          criteria: [{
            statement: `${command} completes and its observation is retained.`,
            question: `Did ${command} return the requested observation?`,
            sourceGoalFieldIds: ["request", "intended_result"],
            sourceRequiredOutcomeRefs: ["required-outcome-1"],
          }],
        })),
      }],
      risks: [], assumptions: [], effectIntents: [], integrationCriteria: [],
      promotionSelectors: [], specifications: [], governingSpecSelections: [],
    }, {
      ledgerId: "ledger-command-observation",
      programId: "program-command-observation",
      observedManifestRevision: 1,
      goalContractRef: ref("goal-command-observation"),
      authorityRef: ref("authority-command-observation"),
      governingSpecRefs: [ref("spec-command-observation")],
      requiredOutcomeId: "required-outcome-1",
      artifactPersistence: "not_required",
      workspaceScopeRef: "workspace:/agent-runtime",
    });

    expect(candidate.tasks).toHaveLength(5);
    expect(candidate.tasks.every((task) => task.effectClass === "none")).toBe(true);
    expect(candidate.tasks.map((task) => task.artifactPolicy)).toEqual(
      commands.map(() => ({
        kind: "non_artifact",
        targetScopeRefs: ["workspace:/agent-runtime"],
      })),
    );
    expect(candidate.effectIntents).toEqual([]);
    expect(candidate.artifactLifecycle.promotionProtocol).toBe("not_applicable");
  });
});
