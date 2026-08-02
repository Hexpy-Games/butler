import type {
  DurableWorkService,
  DurableWorkStore,
  RecordWorkCheckpointInput,
  RecordWorkReviewInput,
  ReplaceWorkPlanInput,
  WorkTurnScope,
} from "./contracts.ts";
import {
  applyWorkActionUpdates,
  assertWorkStageTransition,
  progressForReplacementPlan,
  unresolvedWorkActionKeys,
} from "./work-progress-policy.ts";
import { digest, stableJson } from "../identity/index.ts";

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
    bindOpenWork(scope, expectedWorkId) {
      validateScope(scope);
      if (expectedWorkId !== undefined) {
        requiredText(expectedWorkId, "expectedWorkId");
      }
      return store.bindOpenWork(scope, expectedWorkId);
    },
    async replacePlan(input) {
      validateReplacePlan(input);
      const startNew = input.startNew ?? false;
      const context = startNew ? null : await store.loadContext(input);
      assertWorkStageTransition(context?.work.currentStage, "planning");
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
      assertWorkStageTransition(currentStage, "review");
      const nextStage = input.nextStage ?? "review";
      assertWorkStageTransition("review", nextStage);
      const actionProgress = applyWorkActionUpdates(
        context.work,
        input.actionUpdates ?? [],
      );
      const completeWork = input.subject === "result" &&
        input.verdict === "accept" &&
        unresolvedWorkActionKeys(actionProgress).length === 0 &&
        context.work.latestPlanReview?.verdict === "accept" &&
        context.work.latestPlanReview.boundPlanRevisionId ===
          context.work.currentPlan?.planRevisionId &&
        (context.work.effectBlockers?.length ?? 0) === 0;
      return store.recordReview({
        ...input,
        expectedPlanRevisionId: plan.planRevisionId,
        expectedProgressRevision: context.work.latestCheckpoint?.revision ?? 0,
        expectedResultSequence: context.work.resultRefs.length,
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
        actionProgress,
        progressChanged: (input.actionUpdates?.length ?? 0) > 0,
        completeWork,
      });
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

function validateReplacePlan(input: ReplaceWorkPlanInput): void {
  validateMutation(input);
  requiredText(input.objective, "objective");
  if (input.actions.length === 0) {
    throw new Error("Durable Work plan requires at least one action");
  }
  input.checks.forEach((check, index) => requiredText(check, `checks[${index}]`));
  input.governingRefs?.forEach((reference, index) =>
    requiredText(reference, `governingRefs[${index}]`));
  const keys = new Set<string>();
  for (const [index, action] of input.actions.entries()) {
    requiredText(action.actionKey, `actions[${index}].actionKey`);
    requiredText(action.description, `actions[${index}].description`);
    if (keys.has(action.actionKey)) {
      throw new Error(`Durable Work actionKey is duplicated: ${action.actionKey}`);
    }
    keys.add(action.actionKey);
    action.dependencyKeys.forEach((key, dependencyIndex) =>
      requiredText(key, `actions[${index}].dependencyKeys[${dependencyIndex}]`));
    if (action.effect) {
      requiredText(action.effect.capability, `actions[${index}].effect.capability`);
      requiredText(action.effect.target, `actions[${index}].effect.target`);
    }
  }
  for (const action of input.actions) {
    for (const dependencyKey of action.dependencyKeys) {
      if (!keys.has(dependencyKey)) {
        throw new Error(
          `Durable Work action dependency is missing: ${action.actionKey} -> ${dependencyKey}`,
        );
      }
      if (dependencyKey === action.actionKey) {
        throw new Error(`Durable Work action cannot depend on itself: ${action.actionKey}`);
      }
    }
  }
}

function validateCheckpoint(input: RecordWorkCheckpointInput): void {
  validateMutation(input);
  const updates = input.actionUpdates ?? [];
  if (
    input.nextStage === undefined &&
    updates.length === 0 &&
    !input.publicSummary?.trim() &&
    !input.nextStep?.trim()
  ) {
    throw new Error("Durable Work progress requires a stage, action update, or summary");
  }
  validateActionUpdates(updates);
}

function validateReview(input: RecordWorkReviewInput): void {
  validateMutation(input);
  requiredText(input.summary, "summary");
  input.corrections.forEach((correction, index) =>
    requiredText(correction, `corrections[${index}]`));
  validateActionUpdates(input.actionUpdates ?? []);
}

function validateActionUpdates(updates: RecordWorkCheckpointInput["actionUpdates"]): void {
  const actionKeys = new Set<string>();
  for (const [index, update] of (updates ?? []).entries()) {
    requiredText(update.actionKey, `actionUpdates[${index}].actionKey`);
    if (actionKeys.has(update.actionKey)) {
      throw new Error(`Durable Work action update is duplicated: ${update.actionKey}`);
    }
    actionKeys.add(update.actionKey);
    if (update.note !== undefined) {
      requiredText(update.note, `actionUpdates[${index}].note`);
    }
  }
}

function validateMutation(input: WorkTurnScope & { mutationCallId: string }): void {
  validateScope(input);
  requiredText(input.mutationCallId, "mutationCallId");
}

function validateScope(scope: WorkTurnScope): void {
  requiredText(scope.turnId, "turnId");
  requiredText(scope.sessionId, "sessionId");
  if (scope.projectRef !== undefined) requiredText(scope.projectRef, "projectRef");
}

function requiredText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Durable Work requires ${field}`);
  }
}

async function requireWorkContext(
  store: DurableWorkStore,
  scope: WorkTurnScope,
) {
  const context = await store.loadContext(scope);
  if (!context) throw new Error("Durable Work progress requires open Work");
  return context;
}

function workRequestFingerprint(operation: string, input: unknown): string {
  return digest(stableJson({ operation, input }));
}
