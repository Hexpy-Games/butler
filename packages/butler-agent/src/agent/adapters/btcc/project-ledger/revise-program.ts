import type {
  BtccPersistenceTypes,
  WorkLedgerCommit,
} from "../../../btcc/gateway-api.ts";
import { acceptFeedbackAuthority } from "../../../btcc/gateway-api.ts";

type Program = Extract<
  BtccPersistenceTypes["managedProgramState"],
  { planningState: "reviewed" }
>;
type Product = Extract<
  WorkLedgerCommit["mutation"],
  { kind: "accept_feedback_plan" }
>["product"];
type RevisedCandidate = Exclude<
  Product["candidate"],
  { correctionKind: "implementation_repair" }
>;
type TaskImpact = RevisedCandidate["impactMap"][number];

export function acceptProjectFeedback(program: Program, product: Product): Program {
  const authority = acceptFeedbackAuthority(program, product);
  return product.candidate.correctionKind === "implementation_repair"
    ? product.candidate.correctionPlan.findingDecisions.length === 0 ||
        product.candidate.correctionPlan.findingDecisions
          .some((decision) => decision.decision === "apply_now")
      ? reopenRepairTasks(program, product, authority.manifestRevision)
      : reopenDispositionReview(program, product, authority.manifestRevision)
    : installRevisedProgram(program, product, authority);
}

function reopenDispositionReview(
  program: Program,
  product: Product,
  manifestRevision: number,
): Program {
  for (const ref of product.candidate.correctionPlan.targetTaskRefs) {
    const task = taskById(program, ref.id);
    if (
      task.status !== "review_failed" ||
      !task.currentResult ||
      task.currentReview?.review.verdict !== "not_passed"
    ) {
      throw changed("finding disposition target");
    }
    const attempt = task.attempts.at(-1);
    if (!attempt || attempt.status !== "review_failed") {
      throw changed("finding disposition Attempt");
    }
    attempt.status = "result_submitted";
    task.status = "result_submitted";
    workByLogicalId(program, task.task.workLogicalId).status = "active";
  }
  program.correctionPlanRef = product.candidate.correctionPlan.ref;
  program.frontier = "implementation_open";
  program.manifestRevision = manifestRevision;
  return selectCurrent(program);
}

function reopenRepairTasks(
  program: Program,
  product: Product,
  manifestRevision: number,
): Program {
  const candidate = product.candidate;
  for (const ref of candidate.correctionPlan.targetTaskRefs) {
    const task = taskById(program, ref.id);
    if (task.status !== "review_failed" && task.status !== "accepted") {
      throw changed("repair target");
    }
    if (task.status === "review_failed") closeFailedAttempt(task);
    task.status = "planned";
    delete task.currentResult;
    delete task.currentReview;
    workByLogicalId(program, task.task.workLogicalId).status = "planned";
  }
  program.correctionPlanRef = candidate.correctionPlan.ref;
  program.frontier = "implementation_open";
  program.manifestRevision = manifestRevision;
  return selectCurrent(program);
}

function installRevisedProgram(
  program: Program,
  product: Product,
  authority: ReturnType<typeof acceptFeedbackAuthority>,
): Program {
  const candidate = product.candidate;
  if (candidate.correctionKind === "implementation_repair") return program;
  const plan = candidate.nextPlanCandidate;
  if (program.manifestRevision !== plan.observedManifestRevision) {
    throw changed("revised graph base");
  }
  const previous = new Map(program.tasks.map((task) => [task.task.ref.id, task]));
  const impacts = new Map(candidate.impactMap
    .filter((impact) => impact.successorTaskRef)
    .map((impact) => [impact.successorTaskRef!.id, impact]));
  const works = plan.works.map((work) => ({ work, status: "planned" as const }));
  const tasks = plan.tasks.map((task) =>
    applyTaskImpact(task, impacts.get(task.ref.id), previous));
  const next: Program = {
    ...program,
    ...authority,
    acceptedPlan: plan,
    plan: plan.plan,
    planningReviewRef: product.review.ref,
    works,
    tasks,
    criteria: plan.criteria,
    verificationQuestions: plan.verificationQuestions,
    artifactLifecycle: plan.artifactLifecycle,
    promotionAssemblies: [],
    frontier: "implementation_open",
    correctionPlanRef: candidate.correctionPlan.ref,
  };
  delete next.promotionPermit;
  delete next.activeDeferral;
  delete next.promotionDeferral;
  for (const work of next.works) {
    if (tasksFor(next, work).every((task) => task.status === "accepted")) {
      work.status = "closed";
    }
  }
  return selectCurrent(next);
}

function applyTaskImpact(
  task: Program["tasks"][number]["task"],
  impact: TaskImpact | undefined,
  previous: Map<string, Program["tasks"][number]>,
): Program["tasks"][number] {
  if (!impact?.successorTaskRef) return { task, status: "planned", attempts: [] };
  const prior = previous.get(impact.priorTaskRef.id);
  if (!prior) throw changed("revision impact");
  if (impact.disposition === "unaffected") return { ...prior, task };
  if (impact.disposition === "revalidate") return prepareRevalidation(prior, task);
  if (task.ref.id !== prior.task.ref.id) {
    return { task, status: "planned", attempts: [] };
  }
  const attempts = structuredClone(prior.attempts);
  const attempt = attempts.at(-1);
  if (attempt && attempt.status !== "accepted") attempt.status = "closed_unaccepted";
  return { task, status: "planned", attempts };
}

function prepareRevalidation(
  prior: Program["tasks"][number],
  task: Program["tasks"][number]["task"],
): Program["tasks"][number] {
  if (prior.status !== "accepted" || !prior.currentResult) {
    throw changed("revalidation result");
  }
  const attempts = structuredClone(prior.attempts);
  const attempt = attempts.at(-1);
  if (!attempt || attempt.status !== "accepted") throw changed("revalidation Attempt");
  attempt.status = "result_submitted";
  const next = { ...prior, task, attempts, status: "result_submitted" as const };
  delete next.currentReview;
  next.revalidationSource = {
    priorTaskRef: prior.task.ref,
    resultRef: prior.currentResult.result.ref,
  };
  return next;
}

function closeFailedAttempt(task: Program["tasks"][number]): void {
  const attempt = task.attempts.at(-1);
  if (!attempt || attempt.status !== "review_failed") throw changed("failed repair Attempt");
  attempt.status = "closed_unaccepted";
}

function selectCurrent(program: Program): Program {
  const currentTask = program.tasks.find((task) =>
    ["selected", "result_submitted", "review_failed"].includes(task.status)) ??
    [...program.tasks].sort((left, right) =>
      left.task.executionOrdinal - right.task.executionOrdinal)
      .find((task) => task.status === "planned") ??
    program.tasks.at(-1)!;
  program.currentTask = currentTask;
  program.currentWork = workByLogicalId(program, currentTask.task.workLogicalId);
  return program;
}

function taskById(program: Program, id: string) {
  const task = program.tasks.find((item) => item.task.ref.id === id);
  if (!task) throw changed("Task");
  return task;
}

function workByLogicalId(program: Program, id: string) {
  const work = program.works.find((item) => item.work.workLogicalId === id);
  if (!work) throw changed("Work");
  return work;
}

function tasksFor(program: Program, work: Program["works"][number]) {
  return program.tasks.filter((task) =>
    task.task.workLogicalId === work.work.workLogicalId);
}

function changed(subject: string): Error {
  return new Error(`Project Work Ledger ${subject} changed`);
}
