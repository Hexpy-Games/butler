import type {
  BtccPersistenceTypes,
  WorkLedgerCommit,
  AvailableSpecRevision,
} from "../../../btcc/index.ts";
import { acceptManagedDeferral } from "./accept-managed-deferral.ts";

type Program = BtccPersistenceTypes["managedProgramState"];
type Reviewed = Extract<Program, { planningState: "reviewed" }>;
type Mutation = WorkLedgerCommit["mutation"];

export function reduceProjectProgram(
  current: Program | null,
  commit: WorkLedgerCommit,
  availableSpecs: AvailableSpecRevision[] = current?.availableSpecs ?? [],
): Program {
  const mutation = commit.mutation;
  if (mutation.kind === "bind_program") return bindProgram(current, mutation, availableSpecs);
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
      return acceptFeedback(next, mutation.product);
    case "close_implementation_frontier":
      closeImplementation(next, mutation.promotionAssemblies);
      break;
    case "authorize_promotion":
      if (next.frontier !== "awaiting_consolidation") throw changed("promotion frontier");
      next.frontier = "promotion_open";
      next.promotionAuthorization = mutation.product.authorization;
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
        next.activeDeferral?.anchor.ref.id !== mutation.product.dossier.deferredAnchorRef?.id ||
        !next.promotionDeferral) throw changed("deferred promotion frontier");
      next.frontier = "closed";
      break;
  }
  next.manifestRevision += 1;
  return selectCurrent(next);
}

function bindProgram(
  current: Program | null,
  mutation: Extract<Mutation, { kind: "bind_program" }>,
  availableSpecs: AvailableSpecRevision[],
): Program {
  const { authority, goalContract } = mutation.product;
  const binding = authority.managedBinding;
  if (!current) {
    return {
      ledgerId: binding.ledgerId,
      programId: binding.programId,
      manifestRevision: 1,
      goalContractRef: goalContract.ref,
      authorityRef: authority.ref,
      availableSpecs,
      availableSpecRefs: availableSpecs.map((spec) => spec.revisionRef),
      governingSpecRefs: [],
      requiredOutcomeId: goalContract.requiredOutcome.outcomeId,
      planningState: "unplanned",
    };
  }
  if (binding.source !== "deferred_goal" || binding.continuationBinding.kind !== "deferred_goal" ||
    current.programId !== binding.programId ||
    current.manifestRevision !== binding.expectedManifestRevision ||
    current.activeDeferral?.anchor.ref.id !== binding.continuationBinding.anchorRef.id) {
    throw changed("deferred Program binding");
  }
  return { ...current, authorityRef: authority.ref, manifestRevision: current.manifestRevision + 1 };
}

function installPlan(program: Program, product: Extract<Mutation, {
  kind: "install_reviewed_plan";
}>["product"]): Reviewed {
  const candidate = product.candidate;
  if (program.manifestRevision !== candidate.observedManifestRevision ||
    program.goalContractRef.id !== candidate.goalContractRef.id ||
    program.authorityRef.id !== candidate.authorityRef.id ||
    !selectedSpecsAvailable(program, candidate)) throw changed("Plan base");
  const works = candidate.works.map((work) => ({ work, status: "planned" as const }));
  const tasks = candidate.tasks.map((task) => ({ task, status: "planned" as const, attempts: [] }));
  return selectCurrent({
    ...program,
    availableSpecs: mergeAvailableSpecs(program.availableSpecs, candidate.authoredSpecs),
    availableSpecRefs: uniqueRefs([...program.availableSpecRefs, ...candidate.authoredSpecRevisionRefs]),
    governingSpecRefs: candidate.governingSpecRefs,
    manifestRevision: program.manifestRevision + 1,
    planningState: "reviewed",
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

function selectAttempt(program: Reviewed, attempt: Extract<Mutation, { kind: "select_attempt" }>[
  "attempt"]): void {
  const task = taskById(program, attempt.taskRef.id);
  if (task.status !== "planned") throw changed("selected Task");
  task.status = "selected";
  task.attempts.push({ ...attempt, status: "ready" });
  workByLogicalId(program, task.task.workLogicalId).status = "active";
  delete program.correctionPlanRef;
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
  task.status = status;
  task.currentReview = product;
  const work = workByLogicalId(program, task.task.workLogicalId);
  if (tasksFor(program, work).every((item) => item.status === "accepted")) work.status = "closed";
}

function acceptFeedback(program: Reviewed, product: Extract<Mutation, {
  kind: "accept_feedback_plan";
}>["product"]): Reviewed {
  const candidate = product.candidate;
  if (candidate.correctionKind === "implementation_repair") {
    for (const ref of candidate.correctionPlan.targetTaskRefs) {
      const task = taskById(program, ref.id);
      if (task.status !== "review_failed" && task.status !== "accepted") throw changed("repair target");
      if (task.status === "review_failed") {
        const attempt = task.attempts.at(-1);
        if (!attempt || attempt.status !== "review_failed") throw changed("failed repair Attempt");
        attempt.status = "closed_unaccepted";
      }
      task.status = "planned";
      delete task.currentResult;
      delete task.currentReview;
      workByLogicalId(program, task.task.workLogicalId).status = "planned";
    }
    program.correctionPlanRef = candidate.correctionPlan.ref;
    program.frontier = "implementation_open";
    program.manifestRevision += 1;
    return selectCurrent(program);
  }
  return installRevisedGraph(program, product);
}

function installRevisedGraph(program: Reviewed, product: Exclude<Extract<Mutation, {
  kind: "accept_feedback_plan";
}>["product"]["candidate"], { correctionKind: "implementation_repair" }> extends never
  ? never : Extract<Mutation, { kind: "accept_feedback_plan" }>["product"]): Reviewed {
  const candidate = product.candidate;
  if (candidate.correctionKind === "implementation_repair") return program;
  const plan = candidate.nextPlanCandidate;
  if (program.manifestRevision !== plan.observedManifestRevision) throw changed("revised graph base");
  const previous = new Map(program.tasks.map((task) => [task.task.ref.id, task]));
  const impact = new Map(candidate.impactMap.filter((item) => item.successorTaskRef)
    .map((item) => [item.successorTaskRef!.id, item]));
  const works = plan.works.map((work) => ({ work, status: "planned" as const }));
  const tasks = plan.tasks.map((task) => {
    const existing = previous.get(task.ref.id);
    return impact.get(task.ref.id)?.disposition === "unaffected" && existing
      ? { ...existing, task }
      : { task, status: "planned" as const, attempts: [] };
  });
  const next: Reviewed = {
    ...program,
    manifestRevision: program.manifestRevision + 1,
    authorityRef: candidate.correctionKind === "authority_scope_revision"
      ? candidate.proposedAuthority.ref : plan.authorityRef,
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
  for (const work of next.works) {
    if (tasksFor(next, work).every((task) => task.status === "accepted")) work.status = "closed";
  }
  return selectCurrent(next);
}

function closeImplementation(program: Reviewed, assemblies: Reviewed["promotionAssemblies"]): void {
  const implementation = program.tasks.filter((task) => task.task.artifactPolicy.kind !== "repository_promotion");
  if (program.frontier !== "implementation_open" || implementation.some((task) => task.status !== "accepted")) {
    throw changed("implementation frontier");
  }
  program.promotionAssemblies = assemblies;
  const hasPromotion = program.tasks.some((task) => task.task.artifactPolicy.kind === "repository_promotion");
  program.frontier = hasPromotion ? "awaiting_consolidation" : "closed";
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
    program.promotionAuthorization?.ref.id !== product.deferral.authorizationRef.id) {
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
  const attempt = task.attempts.find((item) => item.ref.id === id);
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

function uniqueRefs<T extends { id: string }>(refs: T[]): T[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

function selectedSpecsAvailable(
  program: Program,
  candidate: Extract<Mutation, { kind: "install_reviewed_plan" }>["product"]["candidate"],
): boolean {
  if (candidate.governingSpecRefs.length === 0) return false;
  const available = new Set([
    ...program.availableSpecRefs,
    ...candidate.authoredSpecRevisionRefs,
  ].map((ref) => ref.id));
  return candidate.governingSpecRefs.every((ref) => available.has(ref.id));
}

function mergeAvailableSpecs(
  current: AvailableSpecRevision[],
  authored: Array<{ logicalId: string; title: string; ref: { id: string; sha256: string } }>,
): AvailableSpecRevision[] {
  const byLogicalId = new Map(current.map((spec) => [spec.logicalId, spec]));
  for (const spec of authored) {
    byLogicalId.set(spec.logicalId, {
      logicalId: spec.logicalId,
      title: spec.title,
      status: "specified",
      revisionRef: spec.ref,
    });
  }
  return [...byLogicalId.values()].sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}
