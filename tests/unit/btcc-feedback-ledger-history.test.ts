import { expect, test } from "bun:test";
import { acceptProjectFeedback } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/revise-program.ts";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { authorPlanCandidate } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import type { ReviewedManagedProgramState } from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";
import { reviewedPlan } from "./support/btcc-project-ledger-fixture.ts";

test("feedback Plan preserves accepted Task and Work history outside its new graph", () => {
  const initial = reviewedPlan().candidate;
  const historicalTask = {
    task: initial.tasks[0]!,
    status: "accepted" as const,
    attempts: [],
  };
  const historicalWork = { work: initial.works[0]!, status: "closed" as const };
  const program = {
    ledgerId: initial.ledgerId,
    programId: initial.programId,
    planningState: "reviewed" as const,
    manifestRevision: 2,
    goalContractRef: initial.goalContractRef,
    authorityRef: initial.authorityRef,
    availableSpecs: [],
    availableSpecRefs: [],
    governingSpecs: [],
    governingSpecRefs: [],
    requiredOutcomeId: "required-outcome-fixture",
    acceptedPlan: initial,
    plan: initial.plan,
    planningReviewRef: contentRef("planning-review", "initial"),
    works: [historicalWork],
    tasks: [historicalTask],
    currentWork: historicalWork,
    currentTask: historicalTask,
    criteria: initial.criteria,
    verificationQuestions: initial.verificationQuestions,
    artifactLifecycle: initial.artifactLifecycle,
    promotionAssemblies: [],
    frontier: "implementation_open" as const,
  } as unknown as ReviewedManagedProgramState;
  const nextPlan = authorPlanCandidate({
    strategy: "Promote the already accepted implementation.",
    works: [{
      logicalId: "promotion",
      outcome: "Publish the accepted implementation.",
      dependencyWorkIds: [],
      tasks: [{
        logicalId: "publish-result",
        displayTitle: "승인 결과 반영",
        intendedOutcome: "Publish the accepted implementation.",
        dependencyTaskIds: [],
        targetScopeRefs: ["repository:/fixture"],
        effectClass: "none",
        criteria: [{
          statement: "The accepted implementation is published.",
          question: "Was the accepted implementation published?",
          sourceGoalFieldIds: ["request", "intended_result"],
          sourceRequiredOutcomeRefs: ["required-outcome-fixture"],
        }],
      }],
    }],
    risks: [], assumptions: [], effectIntents: [], integrationCriteria: [],
    promotionSelectors: [],
  }, {
    ledgerId: program.ledgerId,
    programId: program.programId,
    observedManifestRevision: program.manifestRevision,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    governingSpecRefs: [],
    availableSpecs: [],
    requiredOutcomeId: program.requiredOutcomeId,
    artifactPersistence: "not_required",
    workspaceScopeRef: "workspace:/fixture",
  });
  const candidateBody = {
    revisionOrigin: { kind: "initial" as const },
    feedbackIntentRef: contentRef("feedback-intent", "fixture"),
    correctionScopeRef: contentRef("correction-scope", "fixture"),
    correctionPlan: {
      ref: contentRef("correction-plan", "fixture"),
      kind: "correction_plan" as const,
      governingWorkPlanRef: initial.plan.ref,
      targetTaskRefs: [initial.tasks[0]!.ref] as [typeof initial.tasks[number]["ref"]],
      correctionAction: "Publish the accepted implementation.",
      executionRequirement: { kind: "observation_only" as const },
      findingDecisions: [],
      artifactLifecycleRef: nextPlan.artifactLifecycle.ref,
    },
    correctionKind: "governing_revision" as const,
    impactMap: [],
    nextPlanCandidate: nextPlan,
  };
  const candidate = {
    ref: contentRef("feedback-plan-candidate", candidateBody),
    ...candidateBody,
  };
  const product = {
    kind: "feedback_planning_accepted" as const,
    candidate,
    review: {
      ref: contentRef("feedback-planning-review", "fixture"),
      candidateRef: candidate.ref,
      originalGoalContractRef: program.goalContractRef,
      correctionKind: candidate.correctionKind,
      verdict: "accepted" as const,
      findings: [] as [],
      reviewedFindings: [],
      findingVerdicts: [],
    },
  };

  const revised = acceptProjectFeedback(program, product);

  expect(revised.tasks.map((task) => [task.task.ref.id, task.status])).toEqual([
    [nextPlan.tasks[0]!.ref.id, "planned"],
    [initial.tasks[0]!.ref.id, "accepted"],
  ]);
  expect(revised.works.map((work) => [work.work.ref.id, work.status])).toEqual([
    [nextPlan.works[0]!.ref.id, "planned"],
    [initial.works[0]!.ref.id, "closed"],
  ]);
});
