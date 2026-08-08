import type {
  RecordCloseoutMissingInput,
  RecordWorkCheckpointInput,
  RecordWorkDispositionInput,
  RecordWorkReviewInput,
  ReplaceWorkPlanInput,
  StartWorkInput,
  ContinueWorkInput,
  WorkTurnScope,
} from "./contracts.ts";
import { digest, stableJson } from "../identity/index.ts";

export function validateStartWork(input: StartWorkInput): void {
  validateMutation(input);
  requiredText(input.objective, "objective");
}

export function validateContinueWork(input: ContinueWorkInput): void {
  validateMutation(input);
  requiredText(input.workId, "workId");
}

export function validateReplacePlan(input: ReplaceWorkPlanInput): void {
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

export function validateCheckpoint(input: RecordWorkCheckpointInput): void {
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

export function validateReview(input: RecordWorkReviewInput): void {
  validateMutation(input);
  requiredText(input.summary, "summary");
  input.corrections.forEach((correction, index) =>
    requiredText(correction, `corrections[${index}]`));
  validateActionUpdates(input.actionUpdates ?? []);
}

export function validateDisposition(input: RecordWorkDispositionInput): void {
  validateMutation(input);
  requiredText(input.workId, "workId");
  requiredText(input.summary, "summary");
  if (
    input.disposition !== "completed" &&
    input.disposition !== "open" &&
    input.disposition !== "blocked"
  ) {
    throw new Error(`Unsupported Work disposition: ${input.disposition}`);
  }
  validateDispositionActionUpdates(input.actionUpdates ?? []);
  validateTextList(input.remainingActions ?? [], "remainingActions");
  validateTextList(input.evidenceRefs ?? [], "evidenceRefs");
  validateTextList(input.followups ?? [], "followups");
  if (input.nextCondition !== undefined) {
    requiredText(input.nextCondition, "nextCondition");
  }
}

export function validateCloseoutMissing(input: RecordCloseoutMissingInput): void {
  validateScope(input);
  requiredText(input.workId, "workId");
}

export function workRequestFingerprint(operation: string, input: unknown): string {
  return digest(stableJson({ operation, input }));
}

function validateDispositionActionUpdates(
  updates: RecordWorkDispositionInput["actionUpdates"],
): void {
  const keys = new Set<string>();
  for (const [index, update] of (updates ?? []).entries()) {
    requiredText(update.actionKey, `actionUpdates[${index}].actionKey`);
    if (keys.has(update.actionKey)) {
      throw new Error(`Durable Work action update is duplicated: ${update.actionKey}`);
    }
    keys.add(update.actionKey);
    if (
      update.status !== "done" &&
      update.status !== "skipped" &&
      update.status !== "blocked"
    ) {
      throw new Error(`Unsupported Work disposition action status: ${update.status}`);
    }
    if (update.note !== undefined) {
      requiredText(update.note, `actionUpdates[${index}].note`);
    }
  }
}

function validateTextList(values: readonly string[], field: string): void {
  values.forEach((value, index) => requiredText(value, `${field}[${index}]`));
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

export function validateMutation(input: WorkTurnScope & { mutationCallId: string }): void {
  validateScope(input);
  requiredText(input.mutationCallId, "mutationCallId");
}

export function validateScope(scope: WorkTurnScope): void {
  requiredText(scope.turnId, "turnId");
  requiredText(scope.sessionId, "sessionId");
  if (scope.projectRef !== undefined) requiredText(scope.projectRef, "projectRef");
}

export function requiredText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Durable Work requires ${field}`);
  }
}
