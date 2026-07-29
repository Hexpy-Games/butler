import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { discoverContinuationCandidates } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { reduceProjectProgram } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/reduce-program.ts";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type { PlanningAcceptedProduct } from "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";
import { authorReplannedStoppedTask, authorResumedStoppedPlan, bindAndContinue, bindStoppedContinuation, continuedPlanningAccepted, freshContinuationCommand } from "./support/btcc-stopped-work-fixture.ts";
import { seedResultSubmittedStoppedProgram } from "./support/btcc-stopped-result-fixture.ts";

test("Planning rejects a replacement graph when the stopped Plan resume contract is required", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const rebound = bindStoppedContinuation(storage, continuation);

  expect(authorReplannedStoppedTask(rebound, continuation)).toMatchObject({
    kind: "planning_draft",
    validationFindings: [{ code: "stopped_result_plan_must_resume" }],
  });
  db.close();
});

test("stopped ResultCandidate identity mismatch is rejected", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  expect(() => bindAndContinue(storage, continuation, (candidate) => {
    if (candidate.revisionOrigin.kind !== "stopped_continuation" ||
      !candidate.revisionOrigin.stoppedResultRef) throw new Error("Stopped result provenance expected");
    candidate.revisionOrigin.stoppedResultRef.sha256 = "forged-result-sha256";
  })).toThrow("ResultCandidate record identity or kind mismatch");
  db.close();
});

test("Planning rejects forged stopped Plan, Goal, and Task identities", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const rebound = bindStoppedContinuation(storage, continuation);
  for (const mutate of [
    (candidate: typeof continuation) => {
      candidate.context!.acceptedPlan!.goalContractRef.sha256 = "forged-goal-sha";
    },
    (candidate: typeof continuation) => {
      candidate.context!.acceptedPlan!.ref.sha256 = "forged-plan-sha";
    },
    (candidate: typeof continuation) => {
      candidate.context!.frontier.interruptedTask!.task.ref.sha256 = "forged-task-sha";
    },
  ]) {
    const forged = structuredClone(continuation);
    mutate(forged);
    expect(authorResumedStoppedPlan(rebound, forged)).toMatchObject({
      kind: "planning_draft",
      validationFindings: [{ code: "stopped_result_plan_identity_mismatch" }],
    });
  }
  db.close();
});

test("Planning resumes a stopped ResultCandidate after an earlier continuation changed the outer Goal", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const rebound = bindStoppedContinuation(storage, continuation);
  const multiHopContinuation = structuredClone(continuation);
  multiHopContinuation.originalGoalContractRef = rebound.goalContractRef;

  expect(authorResumedStoppedPlan(rebound, multiHopContinuation)).toMatchObject({
    revisionOrigin: {
      kind: "stopped_continuation",
      stoppedPlanGoalContractRef: continuation.context?.acceptedPlan?.goalContractRef,
    },
  });
  db.close();
});

test("Project materialization preserves the same reviewed stopped-result Plan", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const rebound = bindStoppedContinuation(storage, continuation);
  if (rebound.planningState !== "reviewed") throw new Error("Reviewed Program expected");
  expect(rebound.goalContractRef).not.toEqual(rebound.plan.goalContractRef);
  const product: PlanningAcceptedProduct = continuedPlanningAccepted(rebound, continuation);
  expect(product.candidate.goalContractRef).toEqual(rebound.goalContractRef);
  expect(product.candidate.plan.goalContractRef).toEqual(rebound.plan.goalContractRef);
  expect(product.candidate.revisionOrigin).toMatchObject({
    kind: "stopped_continuation",
    stoppedPlanGoalContractRef: rebound.plan.goalContractRef,
  });

  const continued = reduceProjectProgram(rebound, {
    mutationId: "project-continuation-materialization",
    turnId: "turn-fresh-continuation",
    expectedTurnRevision: 8,
    mutation: { kind: "install_reviewed_plan", product },
  });

  if (continued.planningState !== "reviewed") throw new Error("Reviewed Program expected");
  expect(continued.plan.ref).toEqual(rebound.plan.ref);
  expect(continued.artifactLifecycle.ref).toEqual(rebound.artifactLifecycle.ref);
  expect(continued.currentTask.task.ref).toEqual(rebound.currentTask.task.ref);
  expect(continued.currentTask.attempts.at(-1)?.attemptRecord.ref)
    .toEqual(rebound.currentTask.attempts.at(-1)?.attemptRecord.ref);
  expect(continued.currentTask.currentResult?.result.ref)
    .toEqual(rebound.currentTask.currentResult?.result.ref);
  db.close();
});

test("Project materialization accepts an attested non-blocking Planning backlog finding", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const storage = await seedResultSubmittedStoppedProgram(db);
  const [continuation] = await discoverContinuationCandidates(db, freshContinuationCommand());
  if (!continuation) throw new Error("Stopped continuation expected");
  const rebound = bindStoppedContinuation(storage, continuation);
  if (rebound.planningState !== "reviewed") throw new Error("Reviewed Program expected");
  const product: PlanningAcceptedProduct = continuedPlanningAccepted(rebound, continuation);
  const subject = product.review.reviewedSubjects.find((item) => item.kind === "task");
  if (!subject) throw new Error("Task review subject expected");
  const findingBody = {
    rootCauseKey: "external-reliability-backlog",
    priority: "P2" as const,
    scopeRelation: "outside_current_scope" as const,
    recommendedDisposition: "backlog" as const,
    affectedSubjectIds: [subject.subjectId],
    dimension: "effect_authority" as const,
    message: "External reliability can be improved separately.",
    dispositionRationale: "The accepted Plan already handles the current scope.",
    origin: { kind: "backlog_candidate" as const },
  };
  subject.findings.push({
    ref: contentRef("planning-finding", findingBody),
    ...findingBody,
  });
  const { ref: _oldReviewRef, ...reviewBody } = product.review;
  product.review.ref = contentRef("planning-review", reviewBody);

  expect(() => reduceProjectProgram(rebound, {
    mutationId: "project-continuation-with-backlog-finding",
    turnId: "turn-fresh-continuation",
    expectedTurnRevision: 8,
    mutation: { kind: "install_reviewed_plan", product },
  })).not.toThrow();
  db.close();
});
