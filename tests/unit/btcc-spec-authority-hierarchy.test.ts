import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { authorPlanningProposal } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import type { WorkLedgerCommit } from
  "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import {
  canonicalMutationId,
  clearProjectFixtures,
  projectBindingCommit,
  projectFixture,
  reviewedPlan,
} from "./support/btcc-project-ledger-fixture.ts";
import { artifactTask } from "./support/btcc-planning-fixture.ts";

afterEach(clearProjectFixtures);

describe("BTCC Spec authority hierarchy", () => {
  test("returns an invalid authored hierarchy as a reviewed Planning draft", () => {
    const draft = authorPlanningProposal({
      ...artifactPlan(),
      specifications: [{
        logicalId: "SPEC-AUTHORED",
        parentId: "missing-parent",
        concernId: "authored-concern",
        title: "Authored contract",
        body: "The requested behavior is normative.",
      }],
    }, authoringState());

    expect(draft).toMatchObject({
      kind: "planning_draft",
      validationFindings: [{ code: "specification_parent_unavailable" }],
    });
  });

  test("persists the exact reviewed parent and concern metadata", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({
      stagingRoot: join(fixture.root, "staging"),
    });
    const binding = projectBindingCommit();
    const bound = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot,
      expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
      commit: binding.commit,
    });
    await adapter.promoteAndObserve(bound.publication);
    const accepted = reviewedPlan({
      goalContractRef: binding.goalContract.ref,
      authorityRef: binding.authority.ref,
      availableSpecRefs: bound.program.availableSpecRefs,
      specifications: [{
        logicalId: "new-spec",
        parentId: "fixture-project",
        concernId: "new-spec-concern",
        title: "New exact Spec",
        body: "# Exact behavior\n",
      }],
      requireGoverningSpec: true,
    });
    const install = await prepareInstall(
      adapter,
      fixture.ledgerRoot,
      accepted,
    );

    await adapter.promoteAndObserve(install.publication);
    const found = fixture.core.resolveRecord(fixture.ledgerRoot, {
      kind: "spec",
      id: "new-spec",
    });
    expect(fixture.core.readRecordData(found.filePath)).toMatchObject({
      logicalId: "new-spec",
      parentId: "fixture-project",
      concernId: "new-spec-concern",
    });
  });
});

function authoringState() {
  return {
    ledgerId: "ledger-1",
    programId: "program-1",
    observedManifestRevision: 1,
    goalContractRef: ref("goal"),
    authorityRef: ref("authority"),
    governingSpecRefs: [ref("spec")],
    requiredOutcomeId: "required-outcome-1",
    artifactPersistence: "required" as const,
    workspaceScopeRef: "workspace:/repo",
    specParentRootId: "project-1",
  };
}

function artifactPlan() {
  return {
    strategy: "Implement, integrate, and promote.",
    works: [{
      logicalId: "feature",
      outcome: "The feature is complete.",
      dependencyWorkIds: [],
      tasks: [
        artifactTask("implement", [], "request", "workspace_artifact"),
        artifactTask("integrate", ["implement"], "intended_result", "workspace_artifact"),
        artifactTask("promote", ["implement", "integrate"], "request", "repository_promotion"),
      ],
    }],
    risks: [],
    assumptions: [],
    effectIntents: [{
      occurrenceKey: "promote-once",
      taskId: "promote",
      actionKind: "repository_promotion",
      action: "Promote the reviewed workspace.",
      payload: "packages/feature",
      desiredOutcome: "The target repository contains the reviewed bytes.",
      sourceGoalFieldIds: ["request"],
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
    }],
    integrationCriteria: [{
      logicalId: "integrated",
      statement: "The implementation is integrated before promotion.",
      sourceGoalFieldIds: ["request", "intended_result"],
      sourceRequiredOutcomeRefs: ["required-outcome-1"],
      participatingTaskIds: ["implement", "integrate"],
      integrationTaskId: "integrate",
      promotionTaskId: "promote",
      observableCompatibility: "The integrated workspace passes verification.",
    }],
    promotionSelectors: [{
      implementationTaskIds: ["implement"],
      integrationTaskId: "integrate",
      promotionTaskId: "promote",
    }],
  };
}

async function prepareInstall(
  adapter: ReturnType<typeof createProjectWorkLedgerPublicationAdapter>,
  projectRoot: string,
  product: ReturnType<typeof reviewedPlan>,
) {
  const commit: WorkLedgerCommit = {
    mutationId: "pending",
    turnId: "turn-authored-spec",
    expectedTurnRevision: 4,
    mutation: { kind: "install_reviewed_plan", product },
  };
  const previous = await adapter.loadProgram(projectRoot, product.candidate.programId);
  commit.mutationId = canonicalMutationId(commit, previous);
  return adapter.prepareCommit({
    projectRoot,
    expectedBase: await adapter.observeCanonicalHead(projectRoot),
    commit,
  });
}

const ref = (id: string) => ({ id, sha256: `${id}-sha` });
