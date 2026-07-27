import type {
  BtccPersistenceTypes,
  WorkLedgerCommit,
  AvailableSpecRevision,
  GoverningSpecRevision,
} from "../../../btcc/gateway-api.ts";
import {
  acceptReviewedPlanAuthority,
  assertPromotionPermit,
  bindManagedProgram,
  resolveStoppedReviewTask,
} from "../../../btcc/gateway-api.ts";
import { acceptManagedDeferral } from "./accept-managed-deferral.ts";
import { acceptProjectFeedback } from "./revise-program.ts";
import { canOpenPromotionFrontier } from "../../../btcc/work-ledger/frontier-readiness.ts";

type Program = BtccPersistenceTypes["managedProgramState"];
type Reviewed = Extract<Program, { planningState: "reviewed" }>;
type Mutation = WorkLedgerCommit["mutation"];

export function reduceProjectProgram(
  current: Program | null,
  commit: WorkLedgerCommit,
  availableSpecs: AvailableSpecRevision[] = current?.availableSpecs ?? [],
  governingSpecs: GoverningSpecRevision[] = current?.governingSpecs ?? [],
): Program {
  const mutation = commit.mutation;
  if (mutation.kind === "bind_program") {
    return bindManagedProgram(current, mutation, availableSpecs, governingSpecs);
  }
  const program = requireProgram(current, mutation);
  if (mutation.kind === "install_reviewed_plan") return installPlan(program, mutation.product);
  if (mutation.kind === "accept_managed_deferral") {
    return acceptManagedDeferral(program, mutation);
  }
  const reviewed = requireReviewed(program, mutation.cursor.expectedManifestRevision);
  const next = structuredClone(reviewed);
  switch (mutation.kind) {
    case "select_attempt":
      selectAttempt(next, mutation.attempt);
      break;
    case "attach_result":
      attachResult(next, mutation.product);
      break;
    case "attach_review":
      attachReview(next, mutation.product);
      break;
    case "accept_feedback_plan":
      return acceptProjectFeedback(next, mutation.product);
    case "close_implementation_frontier":
      closeImplementation(next, mutation.promotionAssemblies, mutation.promotionPermit);
      break;
    case "close_promotion_frontier":
      if (next.frontier !== "promotion_open" || next.tasks.some((task) => task.status !== "accepted")) {
        throw changed("promotion frontier");
      }
      next.frontier = "closed";
      next.works.forEach((work) => { work.status = "closed"; });
      break;
    case "accept_promotion_deferral":
      acceptPromotionDeferral(next, mutation.product);
      break;
    case "close_deferred_promotion_frontier":
      if (next.frontier !== "promotion_open" ||
        next.activeDeferral?.anchor.ref.id !== mutation.deferredAnchorRef.id ||
        !next.promotionDeferral) throw changed("deferred promotion frontier");
      next.frontier = "closed";
      break;
    case "cancel_program":
      if (next.frontier === "closed" || next.frontier === "cancelled") {
        throw changed("cancellation frontier");
      }
      next.frontier = "cancelled";
      next.cancellation = mutation.cancellation;
      next.tasks.forEach((task) => {
        if (task.status !== "accepted") task.status = "cancelled";
        const attempt = task.attempts.at(-1);
        if (attempt && attempt.status !== "accepted") attempt.status = "closed_unaccepted";
      });
      next.works.forEach((work) => {
        if (work.status !== "closed") work.status = "cancelled";
      });
      delete next.activeDeferral;
      delete next.promotionDeferral;
      break;
  }
  next.manifestRevision += 1;
  return selectCurrent(next);
}

function installPlan(program: Program, product: Extract<Mutation, {
  kind: "install_reviewed_plan";
}>["product"]): Reviewed {
  const candidate = product.candidate;
  const authority = acceptReviewedPlanAuthority(program, product);
  if (
    program.planningState === "reviewed" &&
    (candidate.revisionOrigin.kind === "deferred_continuation" ||
      candidate.revisionOrigin.kind === "stopped_continuation")
  ) {
    return installContinuedPlan(program, product, authority);
  }
  const works = candidate.works.map((work) => ({ work, status: "planned" as const }));
  const tasks = candidate.tasks.map((task) => ({ task, status: "planned" as const, attempts: [] }));
  return selectCurrent({
    ...program,
    ...authority,
    planningState: "reviewed",
    acceptedPlan: candidate,
    plan: candidate.plan,
    planningReviewRef: product.review.ref,
    works,
    tasks,
    currentWork: works[0]!,
    currentTask: tasks[0]!,
    criteria: candidate.criteria,
    verificationQuestions: candidate.verificationQuestions,
    artifactLifecycle: candidate.artifactLifecycle,
    promotionAssemblies: [],
    frontier: "implementation_open",
  });
}

function installContinuedPlan(
  program: Reviewed,
  product: Extract<Mutation, { kind: "install_reviewed_plan" }>["product"],
  authority: ReturnType<typeof acceptReviewedPlanAuthority>,
): Reviewed {
  const candidate = product.candidate;
  const priorTasks = new Map(program.tasks.map((task) => [task.task.ref.id, task]));
  const candidateTaskIds = new Set(candidate.tasks.map((task) => task.ref.id));
  const reviewTask = candidate.revisionOrigin.kind === "stopped_continuation"
    ? resolveStoppedReviewTask(candidate.revisionOrigin, program.tasks)
    : null;
  if (reviewTask && !candidate.tasks.some((task) => refsEqual(task.ref, reviewTask.task.ref))) {
    throw new Error("Stopped continuation integrity violation: accepted Plan lost the current Task");
  }
  const carriedCompleted = program.tasks
    .filter((task) => task.status === "accepted" && !candidateTaskIds.has(task.task.ref.id));
  const tasks = candidate.tasks.map((task) => {
    const prior = priorTasks.get(task.ref.id);
    if (reviewTask && refsEqual(task.ref, reviewTask.task.ref)) {
      return structuredClone(reviewTask);
    }
    if (prior?.status === "accepted") return structuredClone(prior);
    const attempts = structuredClone(prior?.attempts ?? []);
    const current = attempts.at(-1);
    if (current && current.status !== "accepted") current.status = "closed_unaccepted";
    return { task, status: "planned" as const, attempts };
  });
  tasks.push(...structuredClone(carriedCompleted));
  const candidateWorkIds = new Set(candidate.works.map((work) => work.workLogicalId));
  const carriedWorkIds = new Set([
    ...carriedCompleted.map((task) => task.task.workLogicalId),
    ...(reviewTask ? [reviewTask.task.workLogicalId] : []),
  ]);
  const carriedWorks = program.works.filter((work) =>
    carriedWorkIds.has(work.work.workLogicalId) &&
    !candidateWorkIds.has(work.work.workLogicalId));
  const works = [
    ...candidate.works.map((work) => ({ work, status: "planned" as const })),
    ...structuredClone(carriedWorks),
  ];
  const next: Reviewed = {
    ...program,
    ...authority,
    acceptedPlan: candidate,
    plan: candidate.plan,
    planningReviewRef: product.review.ref,
    works,
    tasks,
    currentWork: works[0]!,
    currentTask: tasks[0]!,
    criteria: candidate.criteria,
    verificationQuestions: candidate.verificationQuestions,
    artifactLifecycle: candidate.artifactLifecycle,
    promotionAssemblies: [],
    frontier: "implementation_open",
  };
  delete next.activeDeferral;
  delete next.promotionDeferral;
  delete next.promotionPermit;
  for (const work of next.works) {
    if (tasksFor(next, work).every((task) => task.status === "accepted")) {
      work.status = "closed";
    }
  }
  return selectCurrent(next);
}

function refsEqual(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function selectAttempt(program: Reviewed, attempt: Extract<Mutation, { kind: "select_attempt" }>[
  "attempt"]): void {
  const task = taskById(program, attempt.attemptRecord.taskRef.id);
  if (task.status !== "planned") throw changed("selected Task");
  task.status = "selected";
  task.attempts.push({ ...attempt, status: "ready" });
  workByLogicalId(program, task.task.workLogicalId).status = "active";
  if (attempt.attemptRecord.correctionPlanRef) {
    program.correctionPlanRef = attempt.attemptRecord.correctionPlanRef;
  } else {
    delete program.correctionPlanRef;
  }
}

function attachResult(program: Reviewed, product: Extract<Mutation, { kind: "attach_result" }>[
  "product"]): void {
  const result = product.result;
  const task = taskById(program, result.taskRef.id);
  const attempt = attemptById(task, result.attemptRef.id);
  if (task.status !== "selected" || attempt.status !== "ready") throw changed("Result Task");
  attempt.status = "result_submitted";
  task.status = "result_submitted";
  task.currentResult = product;
}

function attachReview(program: Reviewed, product: Extract<Mutation, { kind: "attach_review" }>[
  "product"]): void {
  const review = product.review;
  const task = taskById(program, review.taskRef.id);
  const attempt = attemptById(task, review.attemptRef.id);
  if (task.status !== "result_submitted" || attempt.status !== "result_submitted") {
    throw changed("reviewed Task");
  }
  const status = review.verdict === "passed" ? "accepted" : "review_failed";
  attempt.status = status;
  attempt.review = product;
  task.status = status;
  task.currentReview = product;
  if (status === "accepted") {
    delete task.revalidationSource;
    delete program.correctionPlanRef;
  }
  const work = workByLogicalId(program, task.task.workLogicalId);
  if (tasksFor(program, work).every((item) => item.status === "accepted")) work.status = "closed";
}

function closeImplementation(
  program: Reviewed,
  assemblies: Reviewed["promotionAssemblies"],
  permit: Reviewed["promotionPermit"],
): void {
  if (!canOpenPromotionFrontier(program)) {
    throw changed("implementation frontier");
  }
  assertPromotionPermit({
    programId: program.programId,
    currentAuthorityRef: program.authorityRef,
    acceptedPlanRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    assemblies,
    permit,
  });
  program.promotionAssemblies = assemblies;
  const hasPromotion = program.tasks.some((task) =>
    task.task.artifactPolicy.kind === "repository_promotion");
  if (hasPromotion !== Boolean(permit) || hasPromotion !== (assemblies.length > 0)) {
    throw changed("promotion permit");
  }
  if (permit) program.promotionPermit = permit;
  else delete program.promotionPermit;
  program.frontier = hasPromotion ? "promotion_open" : "closed";
  for (const work of program.works) {
    work.status = tasksFor(program, work).some((task) => task.task.artifactPolicy.kind === "repository_promotion")
      ? "active" : "closed";
  }
}

function acceptPromotionDeferral(program: Reviewed, product: Extract<Mutation, {
  kind: "accept_promotion_deferral";
}>["product"]): void {
  const task = taskById(program, product.deferral.promotionTaskRef.id);
  const attempt = attemptById(task, product.deferral.attemptRef.id);
  if (program.frontier !== "promotion_open" || task.status !== "selected" || attempt.status !== "ready" ||
    program.promotionPermit?.ref.id !== product.deferral.authorizationRef.id) {
    throw changed("promotion deferral");
  }
  attempt.status = "promotion_deferred";
  task.status = "promotion_deferred";
  program.activeDeferral = { kind: "managed_deferral", blocker: product.blocker, anchor: product.anchor };
  program.promotionDeferral = product;
}

function requireProgram(current: Program | null, mutation: Exclude<Mutation, { kind: "bind_program" }>): Program {
  const programId = mutation.kind === "install_reviewed_plan"
    ? mutation.product.candidate.programId : mutation.cursor.programId;
  if (!current || current.programId !== programId) throw changed("Program");
  return current;
}

function requireReviewed(program: Program, revision: number): Reviewed {
  if (program.planningState !== "reviewed" || program.manifestRevision !== revision) {
    throw changed("manifest base");
  }
  return program;
}

function taskById(program: Reviewed, id: string) {
  const task = program.tasks.find((item) => item.task.ref.id === id);
  if (!task) throw changed("Task");
  return task;
}

function attemptById(task: Reviewed["tasks"][number], id: string) {
  const attempt = task.attempts.find((item) => item.attemptRecord.ref.id === id);
  if (!attempt) throw changed("Attempt");
  return attempt;
}

function workByLogicalId(program: Reviewed, id: string) {
  const work = program.works.find((item) => item.work.workLogicalId === id);
  if (!work) throw changed("Work");
  return work;
}

function tasksFor(program: Reviewed, work: Reviewed["works"][number]) {
  return program.tasks.filter((task) => task.task.workLogicalId === work.work.workLogicalId);
}

function selectCurrent(program: Reviewed): Reviewed {
  const currentTask = program.tasks.find((task) =>
    ["selected", "result_submitted", "review_failed"].includes(task.status)) ??
    [...program.tasks].sort((a, b) => a.task.executionOrdinal - b.task.executionOrdinal)
      .find((task) => task.status === "planned") ?? program.tasks.at(-1)!;
  program.currentTask = currentTask;
  program.currentWork = workByLogicalId(program, currentTask.task.workLogicalId);
  return program;
}

function changed(subject: string): Error {
  return new Error(`Project Work Ledger ${subject} changed`);
}
