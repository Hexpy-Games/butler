import {
  allowedNextWorkStages,
  type ClaimWorkCloseoutCorrectionInput,
  type DurableWorkDisposition,
  type DurableWorkReview,
  type DurableWorkView,
  type RecordWorkDispositionCommand,
  type RecordWorkReviewCommand,
} from "../../../btcc/work/index.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import { projectWorkRecordId, requestDigest } from "./project-work-json.ts";
import {
  checkpointChild,
  statusForProgress,
} from "./project-work-mapping.ts";
import {
  immutableChildUpdate,
  projectWorkViewUpdates,
} from "./project-work-record-updates.ts";
import { requireCurrentProjectWork } from "./project-work-snapshot.ts";
import {
  mutationIdentity,
  publishedWorkId,
  workRevisions,
  type ProjectWorkWriteContext,
} from "./project-work-write-context.ts";

export async function recordProjectWorkReview(
  context: ProjectWorkWriteContext,
  command: RecordWorkReviewCommand,
): Promise<DurableWorkView> {
  const identity = mutationIdentity(command);
  let targetWorkId: string | undefined;
  const outcome = await context.publish(identity, async () => {
    const current = await context.requireBound(command);
    targetWorkId = current.view.workId;
    if (
      current.manifest.currentPlanRevisionId !==
        command.expectedPlanRevisionId ||
      current.manifest.checkpointRevision !==
        command.expectedProgressRevision ||
      current.manifest.resultSequence !== command.expectedResultSequence
    )
      invalid("project_work_review_precondition_mismatch");
    const at = await context.recordedAt(identity);
    let checkpointRevision = current.manifest.checkpointRevision;
    const children: ProjectWorkChild[] = [];
    const checkpointInput = {
      ...command,
      publicSummary: command.summary,
      nextStep: command.corrections[0] ?? "",
    };
    if (
      command.subject === "completion" ||
      command.currentStage !== command.entryStage ||
      command.progressChanged
    ) {
      checkpointRevision += 1;
      children.push(
        checkpointChild(
          current,
          checkpointInput,
          identity,
          at,
          checkpointRevision,
          command.entryStage,
          `${command.mutationCallId}\0${command.entryStage}-entry`,
          command.expectedPlanRevisionId,
        ),
      );
    }
    const reviewRevision = current.manifest.reviewRevision + 1;
    const review = reviewFor(command, current.view, reviewRevision, at);
    children.push({
      schema: "butler.btcc-project-work-review.v1",
      workId: current.view.workId,
      operationIdentity: identity,
      boundResultSequence: current.view.resultRefs.length,
      review,
    });
    let latestCheckpoint = children.findLast(
      (item) => item.schema === "butler.btcc-project-work-checkpoint.v1",
    )?.checkpoint;
    if (command.nextStage !== command.entryStage) {
      checkpointRevision += 1;
      const exit = checkpointChild(
        current,
        checkpointInput,
        identity,
        at,
        checkpointRevision,
        command.nextStage,
        `${command.mutationCallId}\0${command.entryStage}-exit`,
        command.expectedPlanRevisionId,
      );
      children.push(exit);
      latestCheckpoint = exit.checkpoint;
    }
    const view: DurableWorkView = {
      ...current.view,
      status: statusForProgress(command.actionProgress),
      currentStage: command.nextStage,
      allowedNextStages: allowedNextWorkStages(command.nextStage),
      actionProgress: command.actionProgress,
      ...(latestCheckpoint ? { latestCheckpoint } : {}),
      ...(command.subject === "plan" ? { latestPlanReview: review } : {}),
      ...(command.subject === "result" ? { latestResultReview: review } : {}),
      ...(command.subject === "completion"
        ? { latestCompletionValidation: review }
        : {}),
      updatedAt: at,
    };
    return projectWorkViewUpdates({
      scope: context.input.scope,
      current,
      view,
      operationIdentity: identity,
      children,
      material: await context.captureMaterial(current.view, view, identity),
      revisions: {
        ...workRevisions(current.manifest),
        checkpointRevision,
        checkpointResultSequence: latestCheckpoint
          ? current.view.resultRefs.length
          : current.manifest.checkpointResultSequence,
        reviewRevision,
      },
    });
  });
  const workId = targetWorkId ?? publishedWorkId(outcome);
  if (!workId) invalid("project_work_replay_target_missing");
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId,
  });
  return context.afterMutation(current);
}

export async function recordProjectWorkDisposition(
  context: ProjectWorkWriteContext,
  command: RecordWorkDispositionCommand,
): Promise<DurableWorkView> {
  context.assertScope(command);
  const identity = mutationIdentity(command);
  const allowCompleted =
    command.disposition === "open" &&
    command.runtimeOwnedOpenGeneration?.version === 1;
  await context.publish(identity, async () => {
    const current = await context.requireBound(command, allowCompleted);
    if (current.view.workId !== command.workId)
      invalid("project_work_disposition_target_mismatch");
    if (
      command.expectedMaterialFingerprint &&
      command.expectedMaterialFingerprint !==
        current.manifest.materialFingerprint
    )
      invalid("project_work_material_fingerprint_mismatch");
    const decision = await context.input.runtimeProjection.prepareDisposition({
      command,
      current: current.view,
    });
    if (decision.mode === "current_view") return null;
    const at = await context.recordedAt(identity);
    const revision = current.manifest.dispositionRevision + 1;
    const children: ProjectWorkChild[] = [];
    let checkpointRevision = current.manifest.checkpointRevision;
    let latestCheckpoint = current.view.latestCheckpoint;
    if (current.view.currentPlan) {
      checkpointRevision += 1;
      const checkpoint = checkpointChild(
        current,
        {
          ...command,
          actionProgress: decision.actionProgress,
          publicSummary: command.summary,
          nextStep:
            command.remainingActions?.[0] ?? command.nextCondition ?? "",
        },
        identity,
        at,
        checkpointRevision,
        current.view.currentStage ?? "planning",
        `${command.mutationCallId}\0disposition`,
        current.view.currentPlan.planRevisionId,
      );
      children.push(checkpoint);
      latestCheckpoint = checkpoint.checkpoint;
    }
    const provisional: DurableWorkView = {
      ...current.view,
      status: command.disposition,
      actionProgress: decision.actionProgress,
      ...(latestCheckpoint ? { latestCheckpoint } : {}),
      updatedAt: at,
    };
    const material = await context.captureMaterial(
      current.view,
      provisional,
      identity,
    );
    const disposition: DurableWorkDisposition = {
      dispositionRevisionId: projectWorkRecordId(
        "disposition",
        command.mutationCallId,
      ),
      revision,
      resultSequence: current.view.resultRefs.length,
      materialFingerprint: material.materialFingerprint,
      runtimeOwnedOpen: allowCompleted,
      disposition: command.disposition,
      summary: command.summary,
      actionUpdates: command.actionUpdates ?? [],
      remainingActions: command.remainingActions ?? [],
      ...(command.nextCondition
        ? { nextCondition: command.nextCondition }
        : {}),
      evidenceRefs: command.evidenceRefs ?? [],
      evidenceSnapshot: decision.evidenceSnapshot,
      followups: command.followups ?? [],
      originTurnId: command.turnId,
      createdAt: at,
    };
    children.unshift({
      schema: "butler.btcc-project-work-disposition.v1",
      workId: current.view.workId,
      operationIdentity: identity,
      disposition,
      materialSnapshot: material.materialSnapshot,
    });
    return projectWorkViewUpdates({
      scope: context.input.scope,
      current,
      view: { ...provisional, latestDisposition: disposition },
      operationIdentity: identity,
      children,
      revisions: {
        ...workRevisions(current.manifest),
        checkpointRevision,
        checkpointResultSequence: latestCheckpoint
          ? current.view.resultRefs.length
          : current.manifest.checkpointResultSequence,
        dispositionRevision: revision,
      },
      material,
    });
  });
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId: command.workId,
  });
  return context.afterMutation(current);
}

export async function claimProjectWorkCloseoutCorrection(
  context: ProjectWorkWriteContext,
  command: ClaimWorkCloseoutCorrectionInput,
): Promise<boolean> {
  const diagnosticKey = requestDigest(
    `btcc-guided-work-closeout-missing.v1\0${command.turnId}\0${command.workId}`,
  );
  const diagnosticId = projectWorkRecordId("diagnostic", diagnosticKey);
  const identity = {
    kind: "closeout_diagnostic" as const,
    id: diagnosticId,
    requestSha256: requestDigest({
      turnId: command.turnId,
      workId: command.workId,
    }),
  };
  const outcome = await context.publish(identity, async () => {
    const current = await context.requireBound(command, true);
    if (current.view.workId !== command.workId)
      invalid("project_work_closeout_target_mismatch");
    const child: ProjectWorkChild = {
      schema: "butler.btcc-project-work-closeout-diagnostic.v1",
      workId: command.workId,
      operationIdentity: identity,
      diagnostic: {
        diagnosticId,
        code: "closeout_missing",
        turnId: command.turnId,
        createdAt: await context.recordedAt(identity),
      },
    };
    const update = await immutableChildUpdate({
      scope: context.input.scope,
      workId: command.workId,
      id: diagnosticId,
      kind: "reference",
      title: "Guided Work closeout diagnostic",
      child,
    });
    if (!update) invalid("project_work_occurrence_receipt_missing");
    return [update];
  });
  return !outcome.replayed;
}

function reviewFor(
  command: RecordWorkReviewCommand,
  view: DurableWorkView,
  revision: number,
  at: string,
): DurableWorkReview {
  return {
    reviewRevisionId: projectWorkRecordId("review", command.mutationCallId),
    revision,
    subject: command.subject,
    verdict: command.verdict,
    summary: command.summary,
    corrections: command.corrections,
    ...(command.subject !== "result"
      ? { boundPlanRevisionId: command.expectedPlanRevisionId }
      : {}),
    ...(command.subject === "completion" &&
    command.expectedResultReviewRevisionId
      ? { boundResultReviewRevisionId: command.expectedResultReviewRevisionId }
      : {}),
    ...(command.subject !== "plan"
      ? { boundActionProgress: command.actionProgress }
      : {}),
    boundResultRefs:
      command.subject === "plan"
        ? []
        : view.resultRefs.map((item) => item.resultRef),
    originTurnId: command.turnId,
    createdAt: at,
  };
}
function invalid(message: string): never {
  throw new Error(message);
}
