import type {
  DurableWorkReview,
  DurableWorkService,
  DurableWorkStore,
  DurableWorkView,
  WorkTurnScope,
} from "./contracts.ts";
import {
  applyWorkActionUpdates,
  assertWorkStageTransition,
  progressForReplacementPlan,
} from "./work-progress-policy.ts";
import {
  validateCheckpoint,
  validateCloseoutMissing,
  validateContinueWork,
  validateDisposition,
  validateReplacePlan,
  validateReview,
  validateStartWork,
  validateMutation,
  validateScope,
  requiredText,
  workRequestFingerprint,
} from "./work-input-validation.ts";

export function createDurableWorkService(
  store: DurableWorkStore,
): DurableWorkService {
  return {
    loadContext(scope) {
      validateScope(scope);
      return store.loadContext(scope);
    },
    importOpenLegacyWork(scope) {
      validateScope(scope);
      return store.importOpenLegacyWork(scope);
    },
    startWork(input) {
      validateStartWork(input);
      const { backfillToolCallIds: _backfillToolCallIds, ...identityInput } = input;
      return store.startWork({
        ...input,
        requestSha256: workRequestFingerprint("start_work", identityInput),
      });
    },
    continueWork(input) {
      validateContinueWork(input);
      const { backfillToolCallIds: _backfillToolCallIds, ...identityInput } = input;
      return store.continueWork({
        ...input,
        requestSha256: workRequestFingerprint("continue_work", identityInput),
      });
    },
    async replacePlan(input) {
      validateReplacePlan(input);
      const startNew = input.startNew ?? false;
      const context = startNew ? null : await store.loadContext(input);
      const openingPlan = !context?.work.currentPlan;
      if (context && !openingPlan) {
        assertWorkStageTransition(context.work.currentStage, "planning");
      } else {
        assertWorkStageTransition(undefined, "conception");
        assertWorkStageTransition("conception", "planning");
      }
      return store.replacePlan({
        ...input,
        startNew,
        governingRefs: input.governingRefs ?? [],
        requestSha256: workRequestFingerprint("replace_plan", {
          turnId: input.turnId,
          sessionId: input.sessionId,
          projectRef: input.projectRef ?? null,
          mutationCallId: input.mutationCallId,
          startNew,
          objective: input.objective,
          governingRefs: input.governingRefs ?? [],
          actions: input.actions,
          checks: input.checks,
        }),
        ...(context?.work.workId ? { expectedWorkId: context.work.workId } : {}),
        ...(context
          ? {
              expectedProgressRevision:
                context.work.latestCheckpoint?.revision ?? 0,
            }
          : {}),
        actionProgress: progressForReplacementPlan(
          input.actions,
          context?.work.actionProgress ?? [],
        ),
        openingPlan,
      });
    },
    async recordCheckpoint(input) {
      validateCheckpoint(input);
      const context = await requireWorkContext(store, input);
      const plan = context.work.currentPlan;
      if (!plan || !context.work.currentStage) {
        throw new Error("Durable Work progress requires a current Plan and stage");
      }
      const nextStage = input.nextStage ?? context.work.currentStage;
      assertWorkStageTransition(context.work.currentStage, nextStage);
      return store.recordCheckpoint({
        ...input,
        expectedPlanRevisionId: plan.planRevisionId,
        expectedProgressRevision: context.work.latestCheckpoint?.revision ?? 0,
        requestSha256: workRequestFingerprint("record_checkpoint", {
          turnId: input.turnId,
          sessionId: input.sessionId,
          projectRef: input.projectRef ?? null,
          mutationCallId: input.mutationCallId,
          nextStage: input.nextStage ?? null,
          actionUpdates: input.actionUpdates ?? [],
          publicSummary: input.publicSummary ?? null,
          nextStep: input.nextStep ?? null,
        }),
        stage: nextStage,
        actionProgress: applyWorkActionUpdates(
          context.work,
          input.actionUpdates ?? [],
        ),
        publicSummary: input.publicSummary?.trim() ?? "",
        nextStep: input.nextStep?.trim() ?? "",
      });
    },
    async recordReview(input) {
      validateReview(input);
      const context = await requireWorkContext(store, input);
      const plan = context.work.currentPlan;
      const currentStage = context.work.currentStage;
      if (!plan || !currentStage) {
        throw new Error("Durable Work Review requires a current Plan and stage");
      }
      const entryStage = input.subject === "completion" ? "validation" : "review";
      assertWorkStageTransition(currentStage, entryStage);
      const nextStage = input.nextStage ?? entryStage;
      assertWorkStageTransition(entryStage, nextStage);
      const actionProgress = applyWorkActionUpdates(
        context.work,
        input.actionUpdates ?? [],
      );
      const acceptedResultReview = currentAcceptedResultReview(context.work);
      return store.recordReview({
        ...input,
        expectedPlanRevisionId: plan.planRevisionId,
        expectedProgressRevision: context.work.latestCheckpoint?.revision ?? 0,
        expectedResultSequence: context.work.resultRefs.length,
        ...(input.subject === "completion" && acceptedResultReview
          ? {
              expectedResultReviewRevisionId:
                acceptedResultReview.reviewRevisionId,
            }
          : {}),
        requestSha256: workRequestFingerprint("record_review", {
          turnId: input.turnId,
          sessionId: input.sessionId,
          projectRef: input.projectRef ?? null,
          mutationCallId: input.mutationCallId,
          subject: input.subject,
          verdict: input.verdict,
          summary: input.summary,
          corrections: input.corrections,
          actionUpdates: input.actionUpdates ?? [],
          nextStage: input.nextStage ?? null,
        }),
        currentStage,
        entryStage,
        actionProgress,
        progressChanged: (input.actionUpdates?.length ?? 0) > 0,
      });
    },
    recordDisposition(input) {
      validateDisposition(input);
      const {
        backfillToolCallIds: _backfillToolCallIds,
        ...identityInput
      } = input;
      return store.recordDisposition({
        ...input,
        summary: input.summary.trim(),
        actionUpdates: input.actionUpdates ?? [],
        remainingActions: input.remainingActions ?? [],
        evidenceRefs: input.evidenceRefs ?? [],
        followups: input.followups ?? [],
        requestSha256: workRequestFingerprint(
          "record_work_disposition",
          identityInput,
        ),
      });
    },
    recordCloseoutMissing(input) {
      validateCloseoutMissing(input);
      return store.recordCloseoutMissing(input);
    },
    attachToolResult(input) {
      validateMutation(input);
      requiredText(input.toolCallId, "toolCallId");
      return store.attachToolResult(input);
    },
    boundWorkForTurn(turnId) {
      requiredText(turnId, "turnId");
      return store.boundWorkForTurn(turnId);
    },
  };
}

async function requireWorkContext(
  store: DurableWorkStore,
  scope: WorkTurnScope,
) {
  const context = await store.loadContext(scope);
  if (!context) throw new Error("Durable Work progress requires open Work");
  return context;
}

function currentAcceptedResultReview(
  work: DurableWorkView,
): DurableWorkReview | undefined {
  const review = work.latestResultReview;
  if (review?.verdict !== "accept") return undefined;
  const resultRefs = work.resultRefs.map(({ resultRef }) => resultRef);
  if (review.boundResultRefs.length !== resultRefs.length) return undefined;
  return review.boundResultRefs.every((resultRef, index) =>
      resultRef === resultRefs[index])
    ? review
    : undefined;
}
