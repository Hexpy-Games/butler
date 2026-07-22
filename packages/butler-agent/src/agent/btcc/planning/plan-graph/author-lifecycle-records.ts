import {
  contentRef,
  requireRecord,
  requireString,
  requireStringArray,
  type ContentRef,
} from "../../core/index.ts";
import type {
  ManagedEffectIntent,
  ManagedIntegrationCriterion,
  ManagedTask,
  PlanningCandidate,
} from "../contracts.ts";

type PromotionSelector = PlanningCandidate["artifactLifecycle"]["promotionSelectors"][number];

export function materializePromotionSelectors(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
): PromotionSelector[] {
  const drafts = requireArray(submission.promotionSelectors ?? [], "promotionSelectors");
  const byId = taskMap(tasks);
  const selectors = drafts.map((item, index) => {
    const draft = requireRecord(item, `promotionSelectors[${index}]`);
    const implementationTaskRefs = uniqueStrings(
      requireStringArray(draft.implementationTaskIds, "implementationTaskIds"),
      "Promotion implementation Task",
    ).map((id) => requiredTask(byId, id, "implementation", "workspace_artifact"));
    if (implementationTaskRefs.length === 0) {
      throw new Error("Promotion selector requires implementation Tasks");
    }
    const integrationTaskRef = requiredTask(
      byId, requireString(draft.integrationTaskId, "integrationTaskId"),
      "integration", "workspace_artifact",
    );
    const promotionTaskRef = requiredTask(
      byId, requireString(draft.promotionTaskId, "promotionTaskId"),
      "promotion", "repository_promotion",
    );
    const promotionTask = taskByRef(tasks, promotionTaskRef);
    const requiredPredecessors = uniqueRefs([...implementationTaskRefs, integrationTaskRef]);
    assertDirectDependency(integrationTaskRef, promotionTask.dependencyTaskRefs);
    assertDependencyClosure(requiredPredecessors, promotionTask, tasks);
    const targetScopeRef = promotionTarget(promotionTask);
    assertArtifactTarget(tasks, requiredPredecessors, targetScopeRef);
    const body = {
      targetScopeRef,
      implementationTaskRefs,
      integrationTaskRef,
      promotionTaskRef,
      baselinePolicy: "capture_at_workspace_provision" as const,
      promotionProtocol: "journaled_complete_target_exchange_v1" as const,
    };
    return { ref: contentRef("promotion-selector", body), ...body };
  });
  const promotionIds = selectors.map((selector) => selector.promotionTaskRef.id);
  uniqueStrings(promotionIds, "Promotion selector Task");
  const plannedPromotionIds = tasks
    .filter((task) => task.artifactPolicy.kind === "repository_promotion")
    .map((task) => task.ref.id);
  assertExactStrings(promotionIds, plannedPromotionIds, "Promotion selector set");
  return selectors;
}

export function materializeEffectIntents(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
  selectors: PromotionSelector[],
  authority: { programId: string; requiredOutcomeId: string; authorityRef: ContentRef },
): ManagedEffectIntent[] {
  const drafts = requireArray(submission.effectIntents, "effectIntents");
  const byId = taskMap(tasks);
  const effects = drafts.map((item, index) => {
    const draft = requireRecord(item, `effectIntents[${index}]`);
    const task = requiredTaskRecord(byId, requireString(draft.taskId, "effect.taskId"));
    if (task.effectClass !== "external_effect") {
      throw new Error("EffectIntent names a Task without an external-effect boundary");
    }
    const actionKind = requireString(draft.actionKind, "effect.actionKind");
    const action = actionKind === "repository_promotion"
      ? repositoryPromotionAction(task, selectors)
      : actionKind === "external_operation"
        ? externalOperationAction(task, requireString(draft.action, "effect.action"))
        : invalidAction();
    const body = {
      programId: authority.programId,
      occurrenceKey: requireString(draft.occurrenceKey, "effect.occurrenceKey"),
      owningTaskKey: { programId: authority.programId, taskLogicalId: task.taskLogicalId },
      sourceGoalFieldIds: readGoalFields(draft.sourceGoalFieldIds),
      sourceRequiredOutcomeRefs: readRequiredOutcomeRefs(
        draft.sourceRequiredOutcomeRefs,
        authority.requiredOutcomeId,
      ),
      targetScopeRef: effectTarget(task),
      action,
      normalizedPayloadSha256: contentRef(
        "effect-payload", requireString(draft.payload, "effect.payload"),
      ).sha256,
      desiredOutcomeSha256: contentRef(
        "effect-desired-outcome", requireString(draft.desiredOutcome, "effect.desiredOutcome"),
      ).sha256,
      authorityRef: authority.authorityRef,
    };
    return { ref: contentRef("effect-intent", body), ...body };
  });
  uniqueStrings(effects.map((effect) => effect.occurrenceKey), "Effect occurrence key");
  for (const task of tasks) validateTaskEffects(task, effects);
  return effects;
}

export function materializeIntegrationCriteria(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
  selectors: PromotionSelector[],
  authority: { programId: string; requiredOutcomeId: string },
): ManagedIntegrationCriterion[] {
  const drafts = requireArray(submission.integrationCriteria, "integrationCriteria");
  const byId = taskMap(tasks);
  const criteria = drafts.map((item, index) => {
    const draft = requireRecord(item, `integrationCriteria[${index}]`);
    const integrationTask = requiredTaskRecord(
      byId, requireString(draft.integrationTaskId, "integrationCriterion.integrationTaskId"),
    );
    const promotionTask = requiredTaskRecord(
      byId, requireString(draft.promotionTaskId, "integrationCriterion.promotionTaskId"),
    );
    const selector = selectors.find((candidate) =>
      candidate.integrationTaskRef.id === integrationTask.ref.id &&
      candidate.promotionTaskRef.id === promotionTask.ref.id);
    if (!selector) throw new Error("IntegrationCriterion has no matching promotion selector");
    const participatingTaskRefs = uniqueStrings(
      requireStringArray(draft.participatingTaskIds, "participatingTaskIds"),
      "Integration participating Task",
    ).map((id) => requiredTaskRecord(byId, id).ref);
    assertExactStrings(
      participatingTaskRefs.map((ref) => ref.id),
      uniqueRefs([...selector.implementationTaskRefs, selector.integrationTaskRef])
        .map((ref) => ref.id),
      "Integration participating Task set",
    );
    const body = {
      logicalId: requireString(draft.logicalId, "integrationCriterion.logicalId"),
      programId: authority.programId,
      statement: requireString(draft.statement, "integrationCriterion.statement"),
      sourceGoalFieldIds: readGoalFields(draft.sourceGoalFieldIds),
      sourceRequiredOutcomeRefs: readRequiredOutcomeRefs(
        draft.sourceRequiredOutcomeRefs,
        authority.requiredOutcomeId,
      ),
      participatingTaskRefs,
      integrationTaskRef: integrationTask.ref,
      promotionTaskRef: promotionTask.ref,
      targetScopeRefs: [selector.targetScopeRef],
      observableCompatibility: requireString(
        draft.observableCompatibility, "integrationCriterion.observableCompatibility",
      ),
    };
    return { ref: contentRef("integration-criterion", body), ...body };
  });
  uniqueStrings(criteria.map((criterion) => criterion.logicalId), "Integration criterion id");
  for (const selector of selectors) {
    if (!criteria.some((criterion) =>
      criterion.integrationTaskRef.id === selector.integrationTaskRef.id &&
      criterion.promotionTaskRef.id === selector.promotionTaskRef.id)) {
      throw new Error("Promotion selector has no IntegrationCriterion");
    }
  }
  if (selectors.length === 0 && criteria.length !== 0) {
    throw new Error("IntegrationCriterion requires a promotion selector");
  }
  return criteria;
}

function validateTaskEffects(task: ManagedTask, effects: ManagedEffectIntent[]): void {
  const owned = effects.filter((effect) =>
    effect.owningTaskKey.taskLogicalId === task.taskLogicalId);
  if (task.effectClass === "external_effect" && owned.length === 0) {
    throw new Error(`External-effect Task has no EffectIntent: ${task.taskLogicalId}`);
  }
  if (task.effectClass === "none" && owned.length !== 0) {
    throw new Error(`Effect-free Task has EffectIntents: ${task.taskLogicalId}`);
  }
  if (task.artifactPolicy.kind === "repository_promotion" && owned.length !== 1) {
    throw new Error(`Promotion Task requires exactly one EffectIntent: ${task.taskLogicalId}`);
  }
}

function taskMap(tasks: ManagedTask[]): Map<string, ManagedTask> {
  return new Map(tasks.map((task) => [task.taskLogicalId, task]));
}

function requiredTaskRecord(tasks: Map<string, ManagedTask>, logicalId: string): ManagedTask {
  const task = tasks.get(logicalId);
  if (!task) throw new Error(`Planning reference has no Task: ${logicalId}`);
  return task;
}

function requiredTask(
  tasks: Map<string, ManagedTask>, logicalId: string, role: string,
  policyKind: ManagedTask["artifactPolicy"]["kind"],
): ContentRef {
  const task = requiredTaskRecord(tasks, logicalId);
  if (task.artifactPolicy.kind !== policyKind) {
    throw new Error(`Promotion selector ${role} Task has incompatible artifact policy`);
  }
  return task.ref;
}

function taskByRef(tasks: ManagedTask[], ref: ContentRef): ManagedTask {
  const task = tasks.find((candidate) => candidate.ref.id === ref.id);
  if (!task) throw new Error(`Planning reference has no Task: ${ref.id}`);
  return task;
}

function effectTarget(task: ManagedTask): string {
  if (task.artifactPolicy.kind === "repository_promotion") {
    return task.artifactPolicy.targetScopeRef;
  }
  if (task.artifactPolicy.kind !== "non_artifact" || task.artifactPolicy.targetScopeRefs.length !== 1) {
    throw new Error("External EffectIntent requires one exact non-workspace target");
  }
  return task.artifactPolicy.targetScopeRefs[0]!;
}

function repositoryPromotionAction(task: ManagedTask, selectors: PromotionSelector[]) {
  if (task.artifactPolicy.kind !== "repository_promotion") {
    throw new Error("Repository promotion EffectIntent names a non-promotion Task");
  }
  const selector = selectors.find((candidate) => candidate.promotionTaskRef.id === task.ref.id);
  if (!selector) throw new Error("Repository promotion EffectIntent has no selector");
  return {
    kind: "repository_promotion" as const,
    selectorRef: selector.ref,
    promotionProtocol: "journaled_complete_target_exchange_v1" as const,
  };
}

function externalOperationAction(task: ManagedTask, action: string) {
  if (task.artifactPolicy.kind !== "non_artifact") {
    throw new Error("External operation EffectIntent has incompatible artifact policy");
  }
  return { kind: "external_operation" as const, action };
}

function promotionTarget(task: ManagedTask): string {
  if (task.artifactPolicy.kind !== "repository_promotion") {
    throw new Error("Promotion Task policy is invalid");
  }
  return task.artifactPolicy.targetScopeRef;
}

function assertArtifactTarget(tasks: ManagedTask[], refs: ContentRef[], targetScopeRef: string): void {
  for (const ref of refs) {
    const task = taskByRef(tasks, ref);
    if (
      task.artifactPolicy.kind !== "workspace_artifact" ||
      task.artifactPolicy.targetScopeRef !== targetScopeRef
    ) {
      throw new Error("Promotion selector Tasks do not share the exact artifact target");
    }
  }
}

function readGoalFields(value: unknown): Array<"request" | "intended_result"> {
  const fields = uniqueStrings(requireStringArray(value, "sourceGoalFieldIds"), "Goal field");
  if (fields.length === 0 || fields.some((field) => field !== "request" && field !== "intended_result")) {
    throw new Error("Planning record references an unknown or empty Goal field set");
  }
  return fields as Array<"request" | "intended_result">;
}

function readRequiredOutcomeRefs(value: unknown, requiredOutcomeId: string): string[] {
  const refs = uniqueStrings(requireStringArray(value, "sourceRequiredOutcomeRefs"), "Outcome ref");
  if (refs.length !== 1 || refs[0] !== requiredOutcomeId) {
    throw new Error("Planning record does not bind the accepted required outcome");
  }
  return refs;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function uniqueStrings(values: string[], label: string): string[] {
  if (new Set(values).size !== values.length) throw new Error(`${label} is not unique`);
  return values;
}

function uniqueRefs(refs: ContentRef[]): ContentRef[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

function assertDirectDependency(required: ContentRef, actual: ContentRef[]): void {
  if (!actual.some((ref) => ref.id === required.id)) {
    throw new Error("Promotion Task must directly depend on its integration Task");
  }
}

function assertDependencyClosure(
  required: ContentRef[],
  successor: ManagedTask,
  tasks: ManagedTask[],
): void {
  const byRef = new Map(tasks.map((task) => [task.ref.id, task]));
  const reachable = new Set<string>();
  const frontier = [...successor.dependencyTaskRefs];
  while (frontier.length > 0) {
    const ref = frontier.pop()!;
    if (reachable.has(ref.id)) continue;
    reachable.add(ref.id);
    const task = byRef.get(ref.id);
    if (!task) throw new Error(`Promotion dependency has no Task: ${ref.id}`);
    frontier.push(...task.dependencyTaskRefs);
  }
  if (required.some((ref) => !reachable.has(ref.id))) {
    throw new Error("Promotion dependency closure is missing");
  }
}

function assertExactStrings(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || actual.some((id) => !expected.includes(id))) {
    throw new Error(`${label} does not match the planned graph`);
  }
}

function invalidAction(): never {
  throw new Error("EffectIntent action kind is invalid");
}
