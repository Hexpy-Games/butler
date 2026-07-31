import type {
  DurableWorkService,
  DurableWorkStore,
  RecordWorkCheckpointInput,
  RecordWorkReviewInput,
  ReplaceWorkPlanInput,
  WorkTurnScope,
} from "./contracts.ts";

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
    replacePlan(input) {
      validateReplacePlan(input);
      return store.replacePlan({ ...input, startNew: input.startNew ?? false });
    },
    recordCheckpoint(input) {
      validateCheckpoint(input);
      return store.recordCheckpoint(input);
    },
    recordReview(input) {
      validateReview(input);
      return store.recordReview({
        ...input,
        completeWork: input.subject === "result" && input.verdict === "accept",
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
  requiredText(input.publicSummary, "publicSummary");
  requiredText(input.nextStep, "nextStep");
}

function validateReview(input: RecordWorkReviewInput): void {
  validateMutation(input);
  requiredText(input.summary, "summary");
  input.corrections.forEach((correction, index) =>
    requiredText(correction, `corrections[${index}]`));
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
