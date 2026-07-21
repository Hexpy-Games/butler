import type { ReviewedPromotionAssembly } from "../artifact/index.ts";
import { contentRef } from "../core/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

export function assemblePromotionCandidates(
  program: ReviewedManagedProgramState,
): ReviewedPromotionAssembly[] {
  return program.artifactLifecycle.promotionSelectors.map((selector) => {
    const implementationTasks = selector.implementationTaskRefs.map((ref) =>
      requireAcceptedTask(program, ref.id));
    const integrationTask = requireAcceptedTask(program, selector.integrationTaskRef.id);
    const promotionTask = program.tasks.find(
      (task) => task.task.ref.id === selector.promotionTaskRef.id,
    );
    if (!promotionTask || promotionTask.task.artifactPolicy.kind !== "repository_promotion") {
      throw new Error("Promotion selector lost its planned promotion Task");
    }
    const sourceTasks = uniqueTasks([...implementationTasks, integrationTask]);
    const results = sourceTasks.map((task) => {
      const result = task.currentResult?.result;
      if (!result || result.kind !== "workspace_artifact") {
        throw new Error("Promotion candidate requires accepted workspace Results");
      }
      return result;
    });
    const workspaceRef = results[0]!.workspaceRef;
    if (results.some((result) => result.workspaceRef.id !== workspaceRef.id)) {
      throw new Error("Promotion candidate spans more than one Program workspace");
    }
    const finalResult = integrationTask.currentResult!.result;
    if (finalResult.kind !== "workspace_artifact") {
      throw new Error("Promotion integration Result is not an artifact revision");
    }
    const candidateBody = {
      programId: program.programId,
      workspaceRef,
      implementationReviewRefs: implementationTasks.map((task) => task.currentReview!.review.ref),
      integrationReviewRef: integrationTask.currentReview!.review.ref,
      acceptedWorkspaceRevisionRefs: results.map((result) => result.workspaceRevisionRef),
      finalSnapshotRef: finalResult.workspaceRevision.targetSnapshotRef,
      finalArtifactRevisionRefs: deduplicateRefs(
        results.flatMap((result) => result.artifactRevisionRefs),
      ),
      promotionTaskRef: promotionTask.task.ref,
    };
    const candidate = {
      ref: contentRef("reviewed-promotion-candidate", candidateBody), ...candidateBody,
    };
    const baselineRef = requireBaselineRef(integrationTask);
    const resolutionBody = {
      selectorRef: selector.ref,
      candidateRef: candidate.ref,
      baselineRef,
      exactFrontierTaskRefs: sourceTasks.map((task) => task.task.ref),
    };
    return {
      candidate,
      resolution: {
        ref: contentRef("promotion-resolution-receipt", resolutionBody), ...resolutionBody,
      },
    };
  });
}

function requireAcceptedTask(program: ReviewedManagedProgramState, taskId: string) {
  const task = program.tasks.find((candidate) => candidate.task.ref.id === taskId);
  if (!task || task.status !== "accepted" || task.currentReview?.review.verdict !== "passed") {
    throw new Error("Promotion selector references an unaccepted Task");
  }
  return task;
}

function requireBaselineRef(
  task: ReviewedManagedProgramState["tasks"][number],
) {
  const target = task.attempts.at(-1)?.executionTarget.target;
  if (!target || target.kind !== "provisioned_workspace") {
    throw new Error("Promotion candidate integration Task has no workspace baseline");
  }
  return target.baselineRef;
}

function uniqueTasks<T extends { task: { ref: { id: string } } }>(tasks: T[]): T[] {
  return [...new Map(tasks.map((task) => [task.task.ref.id, task])).values()];
}

function deduplicateRefs<T extends { id: string }>(refs: T[]): T[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}
