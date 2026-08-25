import {
  type ContinueWorkCommand,
  type DurableWorkView,
  type WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import { projectWorkRecordId, requestDigest } from "./project-work-json.ts";
import {
  bindingChild,
  childItem,
  manifestForView,
  mutableWorkUpdate,
} from "./project-work-mapping.ts";
import { immutableChildUpdate } from "./project-work-record-updates.ts";
import { requireObservedProjectWorkReceipt } from "./project-work-receipt.ts";
import { proveProjectWorkRelationOutcome } from "./project-work-operation-receipt-proof.ts";
import {
  readManagedProjectWorkChild,
  requireCurrentProjectWork,
  type CurrentProjectWorkSnapshot,
} from "./project-work-snapshot.ts";
import {
  mutationIdentity,
  noResultBackfill,
  workRevisions,
  type ProjectWorkWriteContext,
} from "./project-work-write-context.ts";
import type { ProjectWorkOperationIdentity } from "./project-work-contracts.ts";

export async function bindOpenProjectWork(
  context: ProjectWorkWriteContext,
  scope: WorkTurnScope,
  expectedWorkId?: string,
): Promise<DurableWorkView | null> {
  context.assertScope(scope);
  const relation = await resolveRelation(context, scope);
  if (relation.binding) {
    const current = await requireBoundRelation(context, scope, relation);
    const callerIdentity = bindingIdentity(
      context,
      scope,
      expectedWorkId,
      current.view.workId,
    );
    const bindingRef = current.manifest.bindingRefs.find(
      (item) => item.turnId === scope.turnId,
    );
    if (!bindingRef) invalid("project_work_turn_binding_missing");
    const binding = await readManagedProjectWorkChild({
      butlerData: context.input.butlerData,
      scope: context.input.scope,
      workId: current.view.workId,
      id: bindingRef.bindingRevisionId,
      kind: "reference",
      schema: "butler.btcc-project-work-binding.v1",
    });
    await requireObservedProjectWorkReceipt({
      context,
      identity: callerIdentity,
      expectedTarget: {
        id: bindingRef.bindingRevisionId,
        kind: "reference",
        parentId: current.view.workId,
      },
    });
    if (
      binding.operationIdentity.kind !== callerIdentity.kind ||
      binding.operationIdentity.id !== callerIdentity.id ||
      binding.operationIdentity.requestSha256 !== callerIdentity.requestSha256
    )
      invalid("project_work_binding_identity_mismatch");
    if (relation.binding.view.sessionId !== scope.sessionId) return null;
    return isOpen(current.view) ? current.view : null;
  }
  const current = relation.sessionHead;
  if (
    !current ||
    (expectedWorkId && expectedWorkId !== current.view.workId)
  )
    return null;
  if (!isOpen(current.view) || current.view.sessionId !== scope.sessionId)
    return null;
  return bind(context, current, scope, expectedWorkId);
}

export async function continueProjectWork(
  context: ProjectWorkWriteContext,
  command: ContinueWorkCommand,
): Promise<DurableWorkView> {
  context.assertScope(command);
  noResultBackfill(command.backfillToolCallIds);
  const identity = mutationIdentity(command);
  const outcome = await context.publish(identity, async () => {
    const relation = await resolveRelation(context, command);
    if (relation.binding) {
      if (relation.binding.view.workId !== command.workId)
        invalid("project_work_turn_already_bound");
      await requireBoundRelation(context, command, relation);
      return [
        await heartbeatUpdate(
          await requireCurrentProjectWork({
            butlerData: context.input.butlerData,
            scope: context.input.scope,
            workId: command.workId,
          }),
          identity,
          await context.recordedAt(identity),
          context,
        ),
      ];
    }
    if (relation.sessionHead?.view.workId !== command.workId)
      invalid("project_work_continuation_target_invalid");
    const current = await requireCurrentProjectWork({
      butlerData: context.input.butlerData,
      scope: context.input.scope,
      workId: command.workId,
    });
    if (!isOpen(current.view) || current.view.sessionId !== command.sessionId)
      invalid("project_work_continuation_target_invalid");
    return bindingUpdates(context, current, command, identity);
  });
  const current = await requireCurrentProjectWork({
      butlerData: context.input.butlerData,
      scope: context.input.scope,
      workId: command.workId,
    });
  proveProjectWorkRelationOutcome({ outcome, current, identity });
  return context.afterMutation(current);
}

async function bind(
  context: ProjectWorkWriteContext,
  current: CurrentProjectWorkSnapshot,
  scope: WorkTurnScope,
  expectedWorkId: string | undefined,
): Promise<DurableWorkView> {
  const identity = bindingIdentity(
    context,
    scope,
    expectedWorkId,
    current.view.workId,
  );
  const outcome = await context.publish(identity, () =>
    bindingUpdates(context, current, scope, identity),
  );
  const bound = await requireCurrentProjectWork({
      butlerData: context.input.butlerData,
      scope: context.input.scope,
      workId: current.view.workId,
    });
  proveProjectWorkRelationOutcome({ outcome, current: bound, identity });
  return context.afterMutation(bound);
}

function bindingIdentity(
  context: ProjectWorkWriteContext,
  scope: WorkTurnScope,
  expectedWorkId: string | undefined,
  resolvedWorkId: string,
): ProjectWorkOperationIdentity {
  return {
    kind: "binding_revision",
    id: projectWorkRecordId(
      "binding",
      `${scope.turnId}\0${1}\0${resolvedWorkId}`,
    ),
    requestSha256: requestDigest({
      scope: context.input.scope,
      expectedWorkId: expectedWorkId ?? null,
      resolvedWorkId,
      priorBinding: null,
    }),
  };
}

async function bindingUpdates(
  context: ProjectWorkWriteContext,
  current: CurrentProjectWorkSnapshot,
  scope: WorkTurnScope,
  identity: ProjectWorkOperationIdentity,
): Promise<ProjectLedgerRecordUpdate[]> {
  const existing = current.manifest.bindingRefs.find(
    (item) => item.turnId === scope.turnId,
  );
  if (existing)
    return [
      await heartbeatUpdate(
        current,
        identity,
        await context.recordedAt(identity),
        context,
      ),
    ];
  const child = bindingChild(
    scope,
    current.view.workId,
    1,
    identity,
    await context.recordedAt(identity),
  );
  const view = { ...current.view, updatedAt: child.binding.boundAt };
  const manifest = manifestForView({
    prior: current.manifest,
    view,
    scope: context.input.scope,
    operationIdentity: identity,
    bindingRefs: [
      ...current.manifest.bindingRefs,
      {
        bindingRevisionId: child.binding.bindingRevisionId,
        turnId: scope.turnId,
        revision: 1,
      },
    ],
    material: await context.captureMaterial(current.view, view, identity),
    revisions: workRevisions(current.manifest),
  });
  const updates = [mutableWorkUpdate(manifest, false)];
  const update = await childUpdate(context, current.view.workId, child);
  if (update) updates.push(update);
  return updates;
}

async function heartbeatUpdate(
  current: CurrentProjectWorkSnapshot,
  identity: ProjectWorkOperationIdentity,
  at: string,
  context: ProjectWorkWriteContext,
) {
  const view = { ...current.view, updatedAt: at };
  return mutableWorkUpdate(
    manifestForView({
      prior: current.manifest,
      view,
      scope: context.input.scope,
      operationIdentity: identity,
      bindingRefs: current.manifest.bindingRefs,
      material: await context.captureMaterial(current.view, view, identity),
      revisions: workRevisions(current.manifest),
    }),
    false,
  );
}

async function childUpdate(
  context: ProjectWorkWriteContext,
  workId: string,
  child: Parameters<typeof childItem>[0],
) {
  return immutableChildUpdate({
    scope: context.input.scope,
    workId,
    ...childItem(child),
    child,
  });
}

async function resolveRelation(
  context: ProjectWorkWriteContext,
  scope: WorkTurnScope,
) {
  return context.relation(scope);
}

async function requireBoundRelation(
  context: ProjectWorkWriteContext,
  scope: WorkTurnScope,
  relation: Awaited<ReturnType<typeof resolveRelation>>,
) {
  const binding = relation.binding;
  if (
    !binding || relation.sessionHead?.view.workId !== binding.view.workId
  )
    invalid("project_work_turn_binding_stale");
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId: binding.view.workId,
  });
  if (
    !isOpen(current.view) ||
    current.view.sessionId !== scope.sessionId ||
    !current.manifest.bindingRefs.some((item) => item.turnId === scope.turnId)
  )
    invalid("project_work_turn_binding_stale");
  return current;
}

function isOpen(view: DurableWorkView) {
  return view.status === "open" || view.status === "blocked";
}
function invalid(message: string): never {
  throw new Error(message);
}
