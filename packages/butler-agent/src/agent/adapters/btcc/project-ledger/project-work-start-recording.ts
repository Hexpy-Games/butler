import {
  allowedNextWorkStages,
  type DurableWorkView,
  type StartWorkCommand,
} from "../../../btcc/work/index.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import { projectWorkRecordId } from "./project-work-json.ts";
import {
  bindingChild,
  childItem,
  manifestForView,
  mutableWorkUpdate,
} from "./project-work-mapping.ts";
import { immutableChildUpdate } from "./project-work-record-updates.ts";
import { proveProjectWorkRelationOutcome } from "./project-work-operation-receipt-proof.ts";
import {
  readCurrentProjectWork,
  requireCurrentProjectWork,
} from "./project-work-snapshot.ts";
import {
  mutationIdentity,
  noResultBackfill,
  workRevisions,
  type ProjectWorkWriteContext,
} from "./project-work-write-context.ts";

export async function startProjectWork(
  context: ProjectWorkWriteContext,
  command: StartWorkCommand,
): Promise<DurableWorkView> {
  context.assertScope(command);
  noResultBackfill(command.backfillToolCallIds);
  const identity = mutationIdentity(command);
  const workId = projectWorkRecordId("work", command.mutationCallId);
  let abandonedId: string | undefined;
  const outcome = await context.publish(identity, async () => {
    const relation = await context.relation(command);
    if (relation.binding) invalid("project_work_turn_already_bound");
    if (
      await readCurrentProjectWork({
        butlerData: context.input.butlerData,
        scope: context.input.scope,
        workId,
      })
    )
      invalid("project_work_occurrence_receipt_missing");
    const prior = relation.sessionHead;
    const at = await context.recordedAt(identity);
    const original =
      await context.input.runtimeProjection.loadOriginalRequest(command);
    if (original.turnId !== command.turnId)
      invalid("project_work_origin_turn_mismatch");
    const binding = bindingChild(command, workId, 1, identity, at);
    const view = openingView(context, command, workId, original.messageId, at);
    const updates: ProjectLedgerRecordUpdate[] = [];
    if (prior) {
      abandonedId = prior.view.workId;
      const priorView = {
        ...prior.view,
        status: isOpen(prior.view) ? ("abandoned" as const) : prior.view.status,
        updatedAt: at,
      };
      updates.push(
        mutableWorkUpdate(
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
        ),
      );
    }
    updates.push(
      mutableWorkUpdate(
        manifestForView({
          view,
          scope: context.input.scope,
          operationIdentity: identity,
          material: await context.captureMaterial(null, view, identity),
          sessionHead: true,
          bindingRefs: [
            {
              bindingRevisionId: binding.binding.bindingRevisionId,
              turnId: command.turnId,
              revision: 1,
            },
          ],
          revisions: {
            planRevision: 0,
            checkpointRevision: 0,
            checkpointResultSequence: 0,
            reviewRevision: 0,
            dispositionRevision: 0,
          },
        }),
        true,
      ),
    );
    const update = await immutableChildUpdate({
      scope: context.input.scope,
      workId,
      ...childItem(binding),
      child: binding,
    });
    if (update) updates.push(update);
    return updates;
  });
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId,
  });
  proveProjectWorkRelationOutcome({ outcome, current, identity });
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

function openingView(
  context: ProjectWorkWriteContext,
  command: StartWorkCommand,
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
function isOpen(view: DurableWorkView) {
  return view.status === "open" || view.status === "blocked";
}
function invalid(message: string): never {
  throw new Error(message);
}
