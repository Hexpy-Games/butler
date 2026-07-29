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
import {
  assertExactStrings,
  readGoalFields,
  readRequiredOutcomeRefs,
  requireArray,
  requiredTaskRecord,
  taskByRef,
  taskMap,
  uniqueRefs,
  uniqueStrings,
} from "./lifecycle-record-rules.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

type PromotionSelector = PlanningCandidate["artifactLifecycle"]["promotionSelectors"][number];

export function materializePromotionSelectors(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
  carriedTaskIds: ReadonlySet<string> = new Set(),
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
      rejectPlanningProposal("promotion_implementation_missing",
        "Promotion selector requires implementation Tasks");
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
    assertDependencyClosure(requiredPredecessors, promotionTask, tasks, carriedTaskIds);
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
  assertSinglePromotionEpoch(tasks, new Set(promotionIds));
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
    if (task.effectClass === "none") {
      rejectPlanningProposal("effect_boundary_missing",
        "EffectIntent names an effect-free Task");
    }
    const actionKind = requireString(draft.actionKind, "effect.actionKind");
    if (actionKind === "repository_promotion" && task.effectClass !== "repository_promotion") {
      rejectPlanningProposal("promotion_effect_boundary_mismatch",
        "Repository promotion EffectIntent requires a repository_promotion Task");
    }
    if (actionKind === "external_target_mutation" && task.effectClass !== "external_effect") {
      rejectPlanningProposal("external_effect_boundary_mismatch",
        "External target mutation requires a separate external_effect Task");
    }
    const action = actionKind === "repository_promotion"
      ? repositoryPromotionAction(task, selectors)
      : actionKind === "external_target_mutation"
        ? externalTargetMutationAction(task, requireString(draft.action, "effect.action"))
        : invalidAction();
    const normalizedPayload = requireString(draft.payload, "effect.payload");
    const desiredOutcome = requireString(draft.desiredOutcome, "effect.desiredOutcome");
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
      normalizedPayload,
      desiredOutcome,
      normalizedPayloadSha256: contentRef("effect-payload", normalizedPayload).sha256,
      desiredOutcomeSha256: contentRef("effect-desired-outcome", desiredOutcome).sha256,
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
    if (!selector) {
      rejectPlanningProposal("integration_selector_missing",
        "IntegrationCriterion has no matching promotion selector");
    }
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
      rejectPlanningProposal("selector_integration_criterion_missing",
        "Promotion selector has no IntegrationCriterion");
    }
  }
  if (selectors.length === 0 && criteria.length !== 0) {
    rejectPlanningProposal("integration_selector_required",
      "IntegrationCriterion requires a promotion selector");
  }
  return criteria;
}

function validateTaskEffects(task: ManagedTask, effects: ManagedEffectIntent[]): void {
  const owned = effects.filter((effect) =>
    effect.owningTaskKey.taskLogicalId === task.taskLogicalId);
  if (task.effectClass === "external_effect" && owned.length === 0) {
    rejectPlanningProposal("effect_intent_missing",
      `External-effect Task has no EffectIntent: ${task.taskLogicalId}`);
  }
  if (task.effectClass === "repository_promotion" && owned.length !== 1) {
    rejectPlanningProposal("promotion_effect_intent_count",
      `Promotion Task requires exactly one EffectIntent: ${task.taskLogicalId}`);
  }
  if (task.effectClass === "none" && owned.length !== 0) {
    rejectPlanningProposal("unexpected_effect_intent",
      `Effect-free Task has EffectIntents: ${task.taskLogicalId}`);
  }
}

function requiredTask(
  tasks: Map<string, ManagedTask>, logicalId: string, role: string,
  policyKind: ManagedTask["artifactPolicy"]["kind"],
): ContentRef {
  const task = requiredTaskRecord(tasks, logicalId);
  if (task.artifactPolicy.kind !== policyKind) {
    rejectPlanningProposal("promotion_task_policy_incompatible",
      `Promotion selector ${role} Task has incompatible artifact policy`);
  }
  return task.ref;
}

function effectTarget(task: ManagedTask): string {
  if (task.artifactPolicy.kind === "repository_promotion") {
    return task.artifactPolicy.targetScopeRef;
  }
  const workspaceScope = task.artifactPolicy.kind === "workspace_artifact"
    ? task.artifactPolicy.workspaceScopeRef
    : null;
  const targets = task.targetScopeRefs.filter((scopeRef) => scopeRef !== workspaceScope);
  if (targets.length !== 1 || targets[0]!.startsWith("workspace:")) {
    rejectPlanningProposal("external_effect_target_invalid",
      "External EffectIntent requires one exact non-workspace target");
  }
  return targets[0]!;
}

function repositoryPromotionAction(task: ManagedTask, selectors: PromotionSelector[]) {
  if (task.artifactPolicy.kind !== "repository_promotion") {
    rejectPlanningProposal("promotion_effect_task_invalid",
      "Repository promotion EffectIntent names a non-promotion Task");
  }
  const selector = selectors.find((candidate) => candidate.promotionTaskRef.id === task.ref.id);
  if (!selector) {
    rejectPlanningProposal("promotion_effect_selector_missing",
      "Repository promotion EffectIntent has no selector");
  }
  return {
    kind: "repository_promotion" as const,
    selectorRef: selector.ref,
    promotionProtocol: "journaled_complete_target_exchange_v1" as const,
  };
}

function externalTargetMutationAction(task: ManagedTask, action: string) {
  if (task.artifactPolicy.kind === "repository_promotion" ||
    (task.artifactPolicy.kind === "workspace_artifact" &&
      task.artifactPolicy.mutationScope.kind !== "read_only")) {
    rejectPlanningProposal("external_target_mutation_policy_incompatible",
      "External-target mutation EffectIntent has incompatible artifact policy");
  }
  return { kind: "external_target_mutation" as const, action };
}

function promotionTarget(task: ManagedTask): string {
  if (task.artifactPolicy.kind !== "repository_promotion") {
    rejectPlanningProposal("promotion_policy_invalid", "Promotion Task policy is invalid");
  }
  return task.artifactPolicy.targetScopeRef;
}

function assertArtifactTarget(tasks: ManagedTask[], refs: ContentRef[], targetScopeRef: string): void {
  for (const ref of refs) {
    const task = taskByRef(tasks, ref);
    if (
      task.artifactPolicy.kind !== "workspace_artifact" ||
      task.artifactPolicy.workspaceScopeRef !== targetScopeRef
    ) {
      rejectPlanningProposal("promotion_target_mismatch",
        "Promotion selector Tasks do not share the exact artifact target");
    }
  }
}

function assertDirectDependency(required: ContentRef, actual: ContentRef[]): void {
  if (!actual.some((ref) => ref.id === required.id)) {
    rejectPlanningProposal("promotion_direct_dependency_missing",
      "Promotion Task must directly depend on its integration Task");
  }
}

function assertDependencyClosure(
  required: ContentRef[],
  successor: ManagedTask,
  tasks: ManagedTask[],
  carriedTaskIds: ReadonlySet<string>,
): void {
  const byRef = new Map(tasks.map((task) => [task.ref.id, task]));
  const reachable = new Set(carriedTaskIds);
  const frontier = [...successor.dependencyTaskRefs];
  while (frontier.length > 0) {
    const ref = frontier.pop()!;
    if (reachable.has(ref.id)) continue;
    reachable.add(ref.id);
    const task = byRef.get(ref.id);
    if (!task) {
      rejectPlanningProposal("promotion_dependency_unknown",
        `Promotion dependency has no Task: ${ref.id}`);
    }
    frontier.push(...task.dependencyTaskRefs);
  }
  if (required.some((ref) => !reachable.has(ref.id))) {
    rejectPlanningProposal("promotion_dependency_closure_missing",
      "Promotion dependency closure is missing");
  }
}

function assertSinglePromotionEpoch(tasks: ManagedTask[], promotionIds: Set<string>): void {
  const byRef = new Map(tasks.map((task) => [task.ref.id, task]));
  for (const promotionId of promotionIds) {
    const promotion = byRef.get(promotionId)!;
    const frontier = [...promotion.dependencyTaskRefs];
    const visited = new Set<string>();
    while (frontier.length > 0) {
      const ref = frontier.pop()!;
      if (visited.has(ref.id)) continue;
      visited.add(ref.id);
      if (promotionIds.has(ref.id)) {
        rejectPlanningProposal(
          "promotion_epoch_nested",
          "Repository promotion Tasks must belong to one dependency-ready promotion epoch",
        );
      }
      frontier.push(...(byRef.get(ref.id)?.dependencyTaskRefs ?? []));
    }
  }
}

function invalidAction(): never {
  rejectPlanningProposal("effect_action_invalid", "EffectIntent action kind is invalid");
}
