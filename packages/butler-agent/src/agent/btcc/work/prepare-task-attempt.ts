import type { ArtifactWorkspaceRuntime } from "../artifact/index.ts";
import { contentRef } from "../core/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";
import type { ManagedAttempt } from "./contracts.ts";

export async function prepareTaskAttempt(input: {
  turnId: string;
  turnRevision: number;
  program: ReviewedManagedProgramState;
  task: ReviewedManagedProgramState["tasks"][number];
  artifacts: ArtifactWorkspaceRuntime;
}): Promise<ManagedAttempt> {
  const previousAttempt = input.task.attempts.at(-1);
  const attemptBody = {
    taskRef: input.task.task.ref,
    owningTurnId: input.turnId,
    createdByTurnRevision: input.turnRevision,
    ...(previousAttempt ? { previousAttemptRef: previousAttempt.ref } : {}),
    ...(input.program.correctionPlanRef
      ? { correctionPlanRef: input.program.correctionPlanRef }
      : {}),
  };
  const attemptRef = contentRef("attempt", attemptBody);
  const common = { ...attemptBody, ref: attemptRef, status: "ready" as const };
  const policy = input.task.task.artifactPolicy;
  if (policy.kind === "non_artifact") {
    const target = createNonArtifactTarget(input.program.programId, attemptRef, input.task);
    return { ...common, ...target };
  }
  if (policy.kind === "repository_promotion") {
    return { ...common, ...createPromotionTarget(input.program, attemptRef, input.task) };
  }
  const work = input.program.works.find(
    (candidate) => candidate.work.workLogicalId === input.task.task.workLogicalId,
  );
  if (!work) throw new Error("Artifact Task has no owning Work");
  const provision = await input.artifacts.acquireProgramWorkspace({
    turnId: input.turnId,
    turnRevision: input.turnRevision,
    programId: input.program.programId,
    workRef: work.work.ref,
    taskRef: input.task.task.ref,
    attemptRef,
    targetScopeRef: policy.targetScopeRef,
    baselinePolicy: policy.baselinePolicy,
  });
  const targetBody = {
    taskRef: input.task.task.ref,
    attemptRef,
    target: {
      kind: "provisioned_workspace" as const,
      provisionOutcomeRef: provision.outcome.ref,
      workspaceRef: provision.workspace.ref,
      baselineRef: provision.baseline.ref,
      acceptedBaseRevisionRefs: acceptedWorkspaceRevisions(input.program, input.task),
    },
  };
  const executionTarget = { ref: contentRef("task-execution-target", targetBody), ...targetBody };
  const creation = {
    kind: "observed_workspace_provision" as const,
    provisionOutcomeRef: provision.outcome.ref,
  };
  const bindingBody = {
    programId: input.program.programId,
    taskRef: input.task.task.ref,
    attemptRef,
    executionTargetRef: executionTarget.ref,
    creation,
  };
  return {
    ...common,
    executionTargetRef: executionTarget.ref,
    executionTarget,
    executionTargetBinding: {
      ref: contentRef("attempt-execution-target-binding", bindingBody), ...bindingBody,
    },
    workspaceProvision: provision,
  };
}

function createPromotionTarget(
  program: ReviewedManagedProgramState,
  attemptRef: ReturnType<typeof contentRef>,
  task: ReviewedManagedProgramState["tasks"][number],
) {
  const authorization = program.promotionAuthorization;
  if (!authorization || !authorization.promotionTaskRefs.some(
    (ref) => ref.id === task.task.ref.id,
  )) throw new Error("Promotion Task is not named by the active authorization");
  const assembly = program.promotionAssemblies.find(
    (candidate) => candidate.candidate.promotionTaskRef.id === task.task.ref.id,
  );
  if (!assembly) throw new Error("Promotion Task has no reviewed candidate assembly");
  const targetBody = {
    taskRef: task.task.ref,
    attemptRef,
    target: {
      kind: "repository_promotion" as const,
      authorizationRef: authorization.ref,
      workspaceRef: assembly.candidate.workspaceRef,
      candidateRef: assembly.candidate.ref,
      resolutionRef: assembly.resolution.ref,
      baselineRef: assembly.resolution.baselineRef,
      finalSnapshotRef: assembly.candidate.finalSnapshotRef,
    },
  };
  const executionTarget = { ref: contentRef("task-execution-target", targetBody), ...targetBody };
  const creation = {
    kind: "authorized_promotion_selection" as const,
    authorizationRef: authorization.ref,
    resolutionRef: assembly.resolution.ref,
  };
  const bindingBody = {
    programId: program.programId,
    taskRef: task.task.ref,
    attemptRef,
    executionTargetRef: executionTarget.ref,
    creation,
  };
  return {
    executionTargetRef: executionTarget.ref,
    executionTarget,
    executionTargetBinding: {
      ref: contentRef("attempt-execution-target-binding", bindingBody), ...bindingBody,
    },
  };
}

function createNonArtifactTarget(
  programId: string,
  attemptRef: ReturnType<typeof contentRef>,
  task: ReviewedManagedProgramState["tasks"][number],
) {
  if (task.task.artifactPolicy.kind !== "non_artifact") {
    throw new Error("Non-artifact target received an artifact Task");
  }
  const targetBody = {
    taskRef: task.task.ref,
    attemptRef,
    target: task.task.artifactPolicy,
  };
  const executionTarget = { ref: contentRef("task-execution-target", targetBody), ...targetBody };
  const bindingBody = {
    programId,
    taskRef: task.task.ref,
    attemptRef,
    executionTargetRef: executionTarget.ref,
    creation: { kind: "accepted_non_artifact_selection" as const },
  };
  return {
    executionTargetRef: executionTarget.ref,
    executionTarget,
    executionTargetBinding: {
      ref: contentRef("attempt-execution-target-binding", bindingBody), ...bindingBody,
    },
  };
}

function acceptedWorkspaceRevisions(
  program: ReviewedManagedProgramState,
  task: ReviewedManagedProgramState["tasks"][number],
) {
  const dependencies = new Set(task.task.dependencyTaskRefs.map((ref) => ref.id));
  return program.tasks
    .filter((candidate) => dependencies.has(candidate.task.ref.id))
    .filter((candidate) => candidate.currentReview?.review.verdict === "passed")
    .flatMap((candidate) => candidate.currentResult?.result.kind === "workspace_artifact"
      ? [candidate.currentResult.result.workspaceRevisionRef]
      : []);
}
