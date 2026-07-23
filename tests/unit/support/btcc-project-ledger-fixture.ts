import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentRef } from "../../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type { ResultCandidateProduct } from
  "../../../packages/butler-agent/src/agent/btcc/execution/index.ts";
import type { WorkLedgerCommit } from
  "../../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import type { PlanningAcceptedProduct } from
  "../../../packages/butler-agent/src/agent/btcc/planning/index.ts";
import { authorPlanCandidate } from
  "../../../packages/butler-agent/src/agent/btcc/planning/plan-graph/index.ts";
import type { TaskReviewProduct } from
  "../../../packages/butler-agent/src/agent/btcc/review/index.ts";
import type { ManagedAttempt } from
  "../../../packages/butler-agent/src/agent/btcc/work/index.ts";
import type { ReviewedManagedProgramState } from
  "../../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";
import {
  ledgerManifestContentHash,
  ledgerMutationId,
  type ManagedProgramState,
} from "../../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";

const roots: string[] = [];

export function clearProjectFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export async function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "btcc-project-work-ledger-"));
  roots.push(root);
  const butlerData = join(root, "data");
  const workspace = join(root, "workspace", "fixture-project");
  mkdirSync(workspace, { recursive: true });
  const core = await loadProjectLedgerCore();
  const previous = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = butlerData;
  let ledgerRoot: string;
  try {
    core.initProject({ project: workspace, id: "fixture-project", name: "Fixture" });
    ledgerRoot = core.ledgerRoot(workspace);
  } finally {
    if (previous === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previous;
  }
  core.createRecord(ledgerRoot, {
    kind: "spec",
    id: "SPEC-FIXTURE",
    title: "Fixture spec",
    status: "active",
    parentId: "SPEC-FIXTURE-PARENT",
    body: "# Fixture spec\n",
  });
  return { root, ledgerRoot, core };
}

export function reviewedPlan(options: {
  goalContractRef?: { id: string; sha256: string };
  authorityRef?: { id: string; sha256: string };
  availableSpecRefs?: Array<{ id: string; sha256: string }>;
  governingSpecSelections?: string[];
  specifications?: Array<{
    logicalId: string;
    parentId: string;
    concernId: string;
    title: string;
    body: string;
  }>;
  requireGoverningSpec?: boolean;
} = {}): PlanningAcceptedProduct {
  const goalContractRef = options.goalContractRef
    ?? contentRef("goal-contract", { request: "Produce result" });
  const authorityRef = options.authorityRef
    ?? contentRef("authority", { scope: "fixture-project" });
  const candidate = authorPlanCandidate({
    strategy: "Produce one reviewed result.",
    ...(options.governingSpecSelections
      ? { governingSpecSelections: options.governingSpecSelections }
      : {}),
    ...(options.specifications ? { specifications: options.specifications } : {}),
    works: [{
      logicalId: "result",
      outcome: "The requested result is complete.",
      dependencyWorkIds: [],
      tasks: [{
        logicalId: "produce-result",
        intendedOutcome: "Produce and verify the requested result.",
        dependencyTaskIds: [],
        targetScopeRefs: ["workspace:/fixture"],
        effectClass: "none",
        criteria: [{
          statement: "The requested result satisfies the original intent.",
          question: "Does the result satisfy the original intent?",
          sourceGoalFieldIds: ["request", "intended_result"],
          sourceRequiredOutcomeRefs: ["required-outcome-fixture"],
        }],
      }],
    }],
    risks: [], assumptions: [], effectIntents: [], integrationCriteria: [],
    promotionSelectors: [],
  }, {
    ledgerId: "project:fixture-project",
    programId: "program-fixture",
    observedManifestRevision: 1,
    goalContractRef,
    authorityRef,
    governingSpecRefs: options.availableSpecRefs ?? [],
    availableSpecs: (options.availableSpecRefs ?? []).map((revisionRef) => ({
      logicalId: "SPEC-FIXTURE",
      parentId: "SPEC-FIXTURE-PARENT",
      concernId: "SPEC-FIXTURE",
      title: "Fixture spec",
      status: "specified",
      revisionRef,
    })),
    requireGoverningSpec: options.requireGoverningSpec,
    requiredOutcomeId: "required-outcome-fixture",
    artifactPersistence: "not_required",
    workspaceScopeRef: "workspace:/fixture",
    specParentRootId: "fixture-project",
  });
  const reviewBody = {
    candidateRef: candidate.ref,
    originalGoalContractRef: candidate.goalContractRef,
    reviewedBundleRef: candidate.bundle.ref,
    reviewedWorkGraphRef: candidate.workGraph.ref,
    reviewedWorkRefs: candidate.works.map((work) => work.ref),
    reviewedTaskRefs: candidate.tasks.map((task) => task.ref),
    reviewedCriterionRefs: candidate.criteria.map((criterion) => criterion.ref),
    reviewedVerificationQuestionRefs: candidate.verificationQuestions.map((item) => item.ref),
    reviewedEffectIntentRefs: candidate.effectIntents.map((item) => item.ref),
    reviewedIntegrationCriterionRefs: candidate.integrationCriteria.map((item) => item.ref),
    reviewedArtifactLifecycleRef: candidate.artifactLifecycle.ref,
    reviewedSpecRevisionRefs: candidate.authoredSpecRevisionRefs,
    verdict: "accepted" as const,
    findings: [] as [],
  };
  return {
    kind: "planning_accepted",
    candidate,
    review: { ref: contentRef("planning-review", reviewBody), ...reviewBody },
  };
}

export function projectBindingCommit(options: {
  governingSpecLogicalIds?: string[];
} = {}): {
  goalContract: Extract<WorkLedgerCommit["mutation"], { kind: "bind_program" }>["product"]["goalContract"];
  authority: Extract<WorkLedgerCommit["mutation"], { kind: "bind_program" }>["product"]["authority"];
  commit: WorkLedgerCommit;
} {
  const continuationBody = { kind: "new_request" as const, inboxId: "inbox-project" };
  const continuation = { ref: contentRef("continuation-binding", continuationBody), ...continuationBody };
  const goalBody = {
    originalMessageId: "message-project",
    originalMessageSha256: "message-sha256",
    request: "Produce the fixture result",
    intendedResult: "A verified fixture result",
    acceptanceIntent: "The canonical Spec and result are satisfied",
    artifactPersistence: "not_required" as const,
    fields: [
      { fieldId: "request" as const, semanticRole: "required_outcome" as const, statement: "Produce" },
      { fieldId: "intended_result" as const, semanticRole: "required_outcome" as const, statement: "Verify" },
    ] as const,
    requiredOutcome: {
      outcomeId: "required-outcome-fixture",
      sourceGoalFieldIds: ["request", "intended_result"] as const,
    },
    lensAssessments: {} as never,
    personalizationRefs: [],
    governingSpecLogicalIds: options.governingSpecLogicalIds ?? ["SPEC-FIXTURE"],
    nonGoals: [],
  };
  const goalContract = { ref: contentRef("goal-contract", goalBody), ...goalBody };
  const authorityBody = {
    goalContractRef: goalContract.ref,
    route: "managed" as const,
    ledgerScope: { kind: "project" as const, projectRef: "project:fixture-project" },
    managedBinding: {
      ledgerId: "project:fixture-project",
      programId: "program-fixture",
      expectedManifestRevision: 0,
      source: "new_program" as const,
      continuationBinding: continuation,
    },
  };
  const authority = { ref: contentRef("authority-revision", authorityBody), ...authorityBody };
  const reviewBody = {
    candidateRef: contentRef("goal-candidate", { goalContractRef: goalContract.ref }),
    originalMessageId: goalContract.originalMessageId,
    originalMessageSha256: goalContract.originalMessageSha256,
    originalGoalContractRef: goalContract.ref,
    reviewedLensIds: [],
    reviewedFieldIds: ["request", "intended_result"] as ["request", "intended_result"],
    reviewedOutcomeIds: ["required-outcome-fixture"] as [string],
    reviewedArtifactPersistence: goalContract.artifactPersistence,
    continuationBindingRef: continuation.ref,
    verdict: "accepted" as const,
    findings: [] as [],
  };
  const review = { ref: contentRef("goal-contract-review", reviewBody), ...reviewBody };
  const boundary = {
    goalContract,
    authority,
    commit: {
      mutationId: "",
      turnId: "turn-project-bind",
      expectedTurnRevision: 2,
      mutation: {
        kind: "bind_program" as const,
        sessionId: "session-project",
        product: { kind: "goal_contract_accepted" as const, goalContract, authority, review },
      },
    },
  } satisfies {
    goalContract: typeof goalContract;
    authority: typeof authority;
    commit: WorkLedgerCommit;
  };
  boundary.commit.mutationId = canonicalMutationId(boundary.commit, null);
  return boundary;
}

export function canonicalMutationId(
  commit: WorkLedgerCommit,
  previous: ManagedProgramState | null,
): string {
  const mutation = commit.mutation;
  const identity = mutation.kind === "bind_program"
    ? {
        ledgerId: mutation.product.authority.managedBinding.ledgerId,
        programId: mutation.product.authority.managedBinding.programId,
      }
    : mutation.kind === "install_reviewed_plan"
      ? { ledgerId: mutation.product.candidate.ledgerId, programId: mutation.product.candidate.programId }
      : { ledgerId: mutation.cursor.ledgerId, programId: mutation.cursor.programId };
  return ledgerMutationId({
    commit: {
      turnId: commit.turnId,
      expectedTurnRevision: commit.expectedTurnRevision,
      mutation: commit.mutation,
    },
    baseManifestHash: ledgerManifestContentHash(previous, identity),
  });
}

export function successfulResult(
  program: ReviewedManagedProgramState,
  attempt: ManagedAttempt,
): ResultCandidateProduct {
  const body = {
    kind: "non_artifact" as const,
    turnId: attempt.owningTurnId,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    workRef: program.currentWork.work.ref,
    taskRef: program.currentTask.task.ref,
    taskRevisionSha256: program.currentTask.task.ref.sha256,
    attemptRef: attempt.ref,
    executionTargetRef: attempt.executionTargetRef,
    executionCheckpointRef: "checkpoint-execution",
    resultSummaryRef: contentRef("result-summary", { status: "complete" }),
    operationResultRefs: [],
    unresolvedConditionRefs: [] as [],
    targetStateRevisions: [],
    effectReceiptRefs: [] as [],
    artifactRevisionRefs: [] as [],
  };
  return { kind: "result_candidate", result: { ref: contentRef("result-candidate", body), ...body } };
}

export function successfulReview(
  program: ReviewedManagedProgramState,
  attempt: ManagedAttempt,
  result: ResultCandidateProduct,
): TaskReviewProduct {
  const observationBody = {
    taskRef: program.currentTask.task.ref,
    attemptRef: attempt.ref,
    executionTargetRef: attempt.executionTargetRef,
    targetRevisionRefs: [],
    description: "The requested result is complete.",
    observationOperationRefs: [],
    reviewCheckpointRef: "checkpoint-review",
  };
  const observation = {
    ref: contentRef("review-observation", observationBody), ...observationBody,
  };
  const reviewBody = {
    kind: "non_artifact" as const,
    turnId: attempt.owningTurnId,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    resultCandidateRef: result.result.ref,
    workRef: program.currentWork.work.ref,
    taskRef: program.currentTask.task.ref,
    taskRevisionSha256: program.currentTask.task.ref.sha256,
    attemptRef: attempt.ref,
    executionTargetRef: attempt.executionTargetRef,
    reviewCheckpointRef: "checkpoint-review",
    criterionVerdicts: program.criteria.map((criterion) => ({
      criterionRef: criterion.ref,
      verificationQuestionRefs: program.verificationQuestions
        .filter((question) => question.criterionRef.id === criterion.ref.id)
        .map((question) => question.ref),
      currentTargetRevisionRefs: [],
      observationRefs: [observation.ref],
      verdict: "satisfied" as const,
      findingRefs: [],
    })),
    observations: [observation],
    findings: [],
    reviewedTargetStateRevisionRefs: [],
    reviewedArtifactRevisionRefs: [],
    reviewedEffectReceiptRefs: [] as [],
    reviewValidationReceiptSetRefs: [],
    verdict: "passed" as const,
  };
  return { kind: "task_review", review: { ref: contentRef("task-review", reviewBody), ...reviewBody } };
}

async function loadProjectLedgerCore() {
  const root = "../../../packages/project-ledger/src";
  const [commands, lifecycle, docs, fileSystem, recordCommands, indexer, records] = await Promise.all([
    import(`${root}/commands.js`), import(`${root}/lifecycle-commands.js`),
    import(`${root}/docs-migration.js`),
    import(`${root}/fs.js`), import(`${root}/record-commands.js`),
    import(`${root}/indexer.js`), import(`${root}/records.js`),
  ]);
  return {
    initProject: commands.initProject,
    ledgerRoot: fileSystem.ledgerRoot,
    createRecord: recordCommands.createRecord,
    resolveRecord: recordCommands.resolveRecord,
    createWork: lifecycle.createWork,
    createTask: lifecycle.createTask,
    createAttempt: lifecycle.createAttempt,
    migrateDocs: docs.migrateDocs,
    buildIndex: indexer.buildIndex,
    readRecordBody: records.readRecordBody,
    readRecordData: records.readRecordData,
  };
}
