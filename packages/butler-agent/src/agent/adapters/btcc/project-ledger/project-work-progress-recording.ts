import {
  allowedNextWorkStages,
  type DurableWorkView,
  type RecordWorkCheckpointCommand,
  type ReplaceWorkPlanCommand,
} from "../../../btcc/work/index.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import { projectWorkRecordId } from "./project-work-json.ts";
import {
  bindingChild,
  checkpointChild,
  manifestForView,
  mutableWorkUpdate,
  statusForProgress,
} from "./project-work-mapping.ts";
import { projectWorkViewUpdates } from "./project-work-record-updates.ts";
import {
  requireCurrentProjectWork,
  type CurrentProjectWorkSnapshot,
} from "./project-work-snapshot.ts";
import {
  mutationIdentity,
  publishedWorkId,
  workRevisions,
  type ProjectWorkWriteContext,
} from "./project-work-write-context.ts";
export async function replaceProjectWorkPlan(
  context: ProjectWorkWriteContext,
  command: ReplaceWorkPlanCommand,
): Promise<DurableWorkView> {
  context.assertScope(command);
  const identity = mutationIdentity(command);
  const targetWorkId =
    command.expectedWorkId ??
    projectWorkRecordId("work", command.mutationCallId);
  let abandonedId: string | undefined;
  await context.publish(identity, async () => {
    const relation = await context.relation(command);
    if (command.startNew && relation.binding)
      invalid("project_work_turn_already_bound");
    let current = command.startNew
      ? null
      : await context.currentForScope(command);
    let createWork = false;
    let openingBinding:
      | Extract<
          ProjectWorkChild,
          { schema: "butler.btcc-project-work-binding.v1" }
        >
      | undefined;
    let priorUpdate: ProjectLedgerRecordUpdate | undefined;
    const at = await context.recordedAt(identity);
    if (command.startNew || !current) {
      const workId = projectWorkRecordId("work", command.mutationCallId);
      const prior = relation.sessionHead;
      const original =
        await context.input.runtimeProjection.loadOriginalRequest(command);
      if (original.turnId !== command.turnId)
        invalid("project_work_origin_turn_mismatch");
      openingBinding = bindingChild(command, workId, 1, identity, at);
      const view = openingView(
        context,
        command,
        workId,
        original.messageId,
        at,
      );
      current = {
        view,
        children: [],
        manifest: manifestForView({
          view,
          scope: context.input.scope,
          operationIdentity: identity,
          material: await context.captureMaterial(null, view, identity),
          bindingRefs: [
            {
              bindingRevisionId: openingBinding.binding.bindingRevisionId,
              turnId: command.turnId,
              revision: 1,
            },
          ],
          revisions: emptyRevisions(),
        }),
      };
      createWork = true;
      if (prior) {
        abandonedId = prior.view.workId;
        const priorView = {
          ...prior.view,
          status: ["open", "blocked"].includes(prior.view.status)
            ? ("abandoned" as const)
            : prior.view.status,
          updatedAt: at,
        };
        priorUpdate = mutableWorkUpdate(
          manifestForView({
            prior: prior.manifest,
            view: priorView,
            scope: context.input.scope,
            operationIdentity: identity,
            bindingRefs: prior.manifest.bindingRefs,
            sessionHead: false,
            material: await context.captureMaterial(
              prior.view,
              priorView,
              identity,
            ),
            revisions: workRevisions(prior.manifest),
          }),
          false,
        );
      }
    }
    if (!current) invalid("project_work_record_missing");
    return preparePlanUpdates(
      context,
      current,
      command,
      identity,
      at,
      openingBinding,
      createWork,
      priorUpdate,
    );
  });
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId: targetWorkId,
  });
  const abandoned = abandonedId
    ? [
        await requireCurrentProjectWork({
          butlerData: context.input.butlerData,
          scope: context.input.scope,
          workId: abandonedId,
        }),
      ]
    : [];
  return context.afterMutation(current, abandoned);
}

export async function recordProjectWorkCheckpoint(
  context: ProjectWorkWriteContext,
  command: RecordWorkCheckpointCommand,
): Promise<DurableWorkView> {
  const identity = mutationIdentity(command);
  let targetWorkId: string | undefined;
  const outcome = await context.publish(identity, async () => {
    const current = await context.requireBound(command);
    targetWorkId = current.view.workId;
    if (
      current.manifest.currentPlanRevisionId !==
        command.expectedPlanRevisionId ||
      current.manifest.checkpointRevision !== command.expectedProgressRevision
    )
      invalid("project_work_checkpoint_precondition_mismatch");
    const at = await context.recordedAt(identity);
    const revision = current.manifest.checkpointRevision + 1;
    const child = checkpointChild(
      current,
      command,
      identity,
      at,
      revision,
      command.stage,
      command.mutationCallId,
      command.expectedPlanRevisionId,
    );
    const view: DurableWorkView = {
      ...current.view,
      status: statusForProgress(command.actionProgress),
      currentStage: command.stage,
      allowedNextStages: allowedNextWorkStages(command.stage),
      actionProgress: command.actionProgress,
      latestCheckpoint: child.checkpoint,
      updatedAt: at,
    };
    return projectWorkViewUpdates({
      scope: context.input.scope,
      current,
      view,
      operationIdentity: identity,
      children: [child],
      material: await context.captureMaterial(current.view, view, identity),
      revisions: {
        ...workRevisions(current.manifest),
        checkpointRevision: revision,
        checkpointResultSequence: current.view.resultRefs.length,
      },
    });
  });
  const replayTarget = targetWorkId ?? publishedWorkId(outcome);
  if (!replayTarget) invalid("project_work_replay_target_missing");
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId: replayTarget,
  });
  return context.afterMutation(current);
}

async function preparePlanUpdates(
  context: ProjectWorkWriteContext,
  current: CurrentProjectWorkSnapshot,
  command: ReplaceWorkPlanCommand,
  identity: ReturnType<typeof mutationIdentity>,
  at: string,
  openingBinding:
    | Extract<
        ProjectWorkChild,
        { schema: "butler.btcc-project-work-binding.v1" }
      >
    | undefined,
  createWork: boolean,
  priorUpdate: ProjectLedgerRecordUpdate | undefined,
) {
  if (command.expectedWorkId && current.view.workId !== command.expectedWorkId)
    invalid("project_work_expected_work_mismatch");
  if (
    command.expectedProgressRevision !== undefined &&
    current.manifest.checkpointRevision !== command.expectedProgressRevision
  )
    invalid("project_work_progress_revision_mismatch");
  const planRevision = current.manifest.planRevision + 1;
  const planId = projectWorkRecordId("plan", command.mutationCallId);
  const plan = {
    planRevisionId: planId,
    revision: planRevision,
    objective: command.objective,
    governingRefs: command.governingRefs,
    actions: command.actions,
    checks: command.checks,
    originTurnId: command.turnId,
    createdAt: at,
  };
  const children: ProjectWorkChild[] = [
    {
      schema: "butler.btcc-project-work-plan.v1",
      workId: current.view.workId,
      operationIdentity: identity,
      plan,
    },
  ];
  let checkpointRevision = current.manifest.checkpointRevision;
  const checkpointInput = {
    ...command,
    publicSummary: command.objective,
    nextStep: command.actions[0]?.description ?? "",
  };
  if (command.openingPlan) {
    checkpointRevision += 1;
    children.push(
      checkpointChild(
        current,
        checkpointInput,
        identity,
        at,
        checkpointRevision,
        "conception",
        `${command.mutationCallId}\0conception`,
        planId,
      ),
    );
  }
  checkpointRevision += 1;
  const planning = checkpointChild(
    current,
    checkpointInput,
    identity,
    at,
    checkpointRevision,
    "planning",
    `${command.mutationCallId}\0plan`,
    planId,
  );
  children.push(planning);
  if (openingBinding) children.unshift(openingBinding);
  const view: DurableWorkView = {
    ...current.view,
    objective: command.objective,
    status: statusForProgress(command.actionProgress),
    currentStage: "planning",
    allowedNextStages: allowedNextWorkStages("planning"),
    actionProgress: command.actionProgress,
    currentPlan: plan,
    latestCheckpoint: planning.checkpoint,
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
      planRevision,
      checkpointRevision,
      checkpointResultSequence: current.view.resultRefs.length,
    },
    createWork,
    leadingUpdates: priorUpdate ? [priorUpdate] : [],
  });
}

function openingView(
  context: ProjectWorkWriteContext,
  command: ReplaceWorkPlanCommand,
  workId: string,
  messageId: string,
  at: string,
): DurableWorkView {
  return {
    workId,
    sessionId: command.sessionId,
    scope: { kind: "project", projectRef: context.input.scope.appProjectId },
    origin: { turnId: command.turnId, messageId },
    objective: command.objective,
    status: "open",
    allowedNextStages: allowedNextWorkStages(),
    actionProgress: [],
    resultRefs: [],
    createdAt: at,
    updatedAt: at,
  };
}
function emptyRevisions() {
  return {
    planRevision: 0,
    checkpointRevision: 0,
    checkpointResultSequence: 0,
    reviewRevision: 0,
    dispositionRevision: 0,
  };
}
function invalid(message: string): never {
  throw new Error(message);
}
