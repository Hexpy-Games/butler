import {
  boundedArray,
  digestValue,
  exactKeys,
  invalid,
  isoRequired,
  nonnegative,
  object,
  positiveRevision,
  stringArray,
  textRequired,
  textValue,
} from "./project-work-json.ts";

export function validateChild(
  schema: string,
  child: Record<string, unknown>,
): void {
  if (schema.endsWith("-plan.v1")) return validatePlan(child);
  if (schema.endsWith("-checkpoint.v1")) return validateCheckpoint(child);
  if (schema.endsWith("-review.v1")) return validateReview(child);
  if (schema.endsWith("-disposition.v1")) return validateDisposition(child);
  if (schema.endsWith("-result-reference.v1")) return validateResult(child);
  if (schema.endsWith("-binding.v1")) return validateBinding(child);
  exactKeys(child, ["diagnosticId", "code", "turnId", "createdAt"]);
  if (child.code !== "closeout_missing") invalid();
  textRequired(child.turnId);
  isoRequired(child.createdAt);
}

export function stageValue(value: unknown): void {
  if (
    ![
      "conception",
      "planning",
      "execution",
      "review",
      "validation",
      "reporting",
    ].includes(String(value))
  )
    invalid();
}

function validatePlan(child: Record<string, unknown>): void {
  exactKeys(
    child,
    [
      "planRevisionId",
      "revision",
      "objective",
      "actions",
      "checks",
      "originTurnId",
      "createdAt",
    ],
    ["governingRefs"],
  );
  positiveRevision(child.revision);
  textRequired(child.objective);
  textRequired(child.originTurnId);
  isoRequired(child.createdAt);
  stringArray(child.governingRefs ?? []);
  stringArray(child.checks);
  boundedArray(child.actions).forEach((entry) => {
    const action = object(entry);
    exactKeys(
      action,
      ["actionKey", "description", "dependencyKeys"],
      ["effect"],
    );
    textRequired(action.actionKey);
    textRequired(action.description);
    stringArray(action.dependencyKeys);
    if (action.effect !== undefined) {
      const effect = object(action.effect);
      exactKeys(effect, ["capability", "target"]);
      textRequired(effect.capability);
      textRequired(effect.target);
    }
  });
}
function validateCheckpoint(child: Record<string, unknown>): void {
  exactKeys(child, [
    "checkpointRevisionId",
    "revision",
    "planRevisionId",
    "stage",
    "actionProgress",
    "publicSummary",
    "nextStep",
    "referencedResultRefs",
    "originTurnId",
    "createdAt",
  ]);
  positiveRevision(child.revision);
  textRequired(child.planRevisionId);
  stageValue(child.stage);
  boundedArray(child.actionProgress).forEach(validateProgress);
  textValue(child.publicSummary);
  textValue(child.nextStep);
  stringArray(child.referencedResultRefs);
  textRequired(child.originTurnId);
  isoRequired(child.createdAt);
}
function validateReview(child: Record<string, unknown>): void {
  exactKeys(
    child,
    [
      "reviewRevisionId",
      "revision",
      "subject",
      "verdict",
      "summary",
      "corrections",
      "boundResultRefs",
      "originTurnId",
      "createdAt",
    ],
    [
      "boundPlanRevisionId",
      "boundResultReviewRevisionId",
      "boundActionProgress",
    ],
  );
  positiveRevision(child.revision);
  if (
    !["plan", "result", "completion"].includes(String(child.subject)) ||
    !["accept", "revise", "partial"].includes(String(child.verdict))
  )
    invalid();
  textRequired(child.summary);
  stringArray(child.corrections);
  stringArray(child.boundResultRefs);
  textRequired(child.originTurnId);
  isoRequired(child.createdAt);
  if (child.boundPlanRevisionId !== undefined)
    textRequired(child.boundPlanRevisionId);
  if (child.boundResultReviewRevisionId !== undefined)
    textRequired(child.boundResultReviewRevisionId);
  if (child.boundActionProgress !== undefined)
    boundedArray(child.boundActionProgress).forEach(validateProgress);
}
function validateDisposition(child: Record<string, unknown>): void {
  exactKeys(
    child,
    [
      "dispositionRevisionId",
      "revision",
      "resultSequence",
      "materialFingerprint",
      "runtimeOwnedOpen",
      "disposition",
      "summary",
      "actionUpdates",
      "remainingActions",
      "evidenceRefs",
      "evidenceSnapshot",
      "followups",
      "originTurnId",
      "createdAt",
    ],
    ["nextCondition"],
  );
  positiveRevision(child.revision);
  nonnegative(child.resultSequence);
  digestValue(child.materialFingerprint);
  if (
    typeof child.runtimeOwnedOpen !== "boolean" ||
    !["completed", "open", "blocked"].includes(String(child.disposition))
  )
    invalid();
  textRequired(child.summary);
  boundedArray(child.actionUpdates).forEach(validateTerminalProgress);
  stringArray(child.remainingActions);
  stringArray(child.evidenceRefs);
  stringArray(child.evidenceSnapshot);
  stringArray(child.followups);
  if (child.nextCondition !== undefined) textRequired(child.nextCondition);
  textRequired(child.originTurnId);
  isoRequired(child.createdAt);
}
function validateResult(child: Record<string, unknown>): void {
  exactKeys(
    child,
    [
      "resultRef",
      "sequence",
      "toolCallId",
      "toolName",
      "status",
      "originTurnId",
      "attachedAt",
    ],
    ["resultSha256", "errorCode"],
  );
  positiveRevision(child.sequence);
  textRequired(child.toolCallId);
  textRequired(child.toolName);
  if (child.status !== "completed" || child.errorCode !== undefined) invalid();
  digestValue(child.resultSha256);
  textRequired(child.originTurnId);
  isoRequired(child.attachedAt);
}
function validateBinding(child: Record<string, unknown>): void {
  exactKeys(child, [
    "bindingRevisionId",
    "turnId",
    "sessionId",
    "revision",
    "boundAt",
  ]);
  textRequired(child.turnId);
  textRequired(child.sessionId);
  positiveRevision(child.revision);
  isoRequired(child.boundAt);
}
function validateProgress(value: unknown): void {
  const item = object(value);
  exactKeys(item, ["actionKey", "status"], ["note"]);
  textRequired(item.actionKey);
  if (
    !["pending", "active", "done", "blocked", "skipped"].includes(
      String(item.status),
    )
  )
    invalid();
  if (item.note !== undefined) textValue(item.note);
}
function validateTerminalProgress(value: unknown): void {
  const item = object(value);
  exactKeys(item, ["actionKey", "status"], ["note"]);
  textRequired(item.actionKey);
  if (!["done", "skipped", "blocked"].includes(String(item.status))) invalid();
  if (item.note !== undefined) textValue(item.note);
}
