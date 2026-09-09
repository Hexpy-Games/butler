import type { DurableWorkView } from "../../../btcc/work/index.ts";
import { projectWorkRecordId, requestDigest } from "./project-work-json.ts";
import { manifestForView, mutableWorkUpdate } from "./project-work-mapping.ts";
import { proveProjectWorkOperationReceipt } from "./project-work-operation-receipt-proof.ts";
import { requireObservedProjectWorkReceipt } from "./project-work-receipt.ts";
import {
  readCanonicalProjectWorkBinding,
  readCanonicalProjectWorkRelation,
} from "./project-work-relation-snapshot.ts";
import { requireCurrentProjectWork } from "./project-work-snapshot.ts";
import {
  workRevisions,
  type ProjectWorkWriteContext,
} from "./project-work-write-context.ts";

export async function abandonProjectWork(
  context: ProjectWorkWriteContext,
  turnId: string,
): Promise<DurableWorkView | null> {
  const candidate = await readCanonicalProjectWorkBinding({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    turnId,
  });
  if (!candidate) return null;
  const relation = await readCanonicalProjectWorkRelation({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    sessionId: candidate.view.sessionId,
    turnId,
  });
  const current = relation.binding;
  if (!current || current.view.workId !== candidate.view.workId)
    invalid("project_work_turn_binding_stale");
  if (!current.manifest.bindingRefs.some((item) => item.turnId === turnId))
    invalid("project_work_abandonment_binding_missing");
  if (current.view.status === "completed") return current.view;
  if (current.view.status === "abandoned") {
    await requireObservedProjectWorkReceipt({
      context,
      identity: current.manifest.operationIdentity,
      expectedTarget: {
        id: current.view.workId,
        kind: "work",
        parentId: null,
      },
    });
    return current.view;
  }
  return recordAbandonment(context, current, turnId);
}

async function recordAbandonment(
  context: ProjectWorkWriteContext,
  current: NonNullable<
    Awaited<ReturnType<typeof readCanonicalProjectWorkBinding>>
  >,
  turnId: string,
): Promise<DurableWorkView> {
  const revision = current.manifest.bindingRefs.find(
    (item) => item.turnId === turnId,
  )!.revision;
  const identity = {
    kind: "abandonment" as const,
    id: projectWorkRecordId(
      "abandonment",
      `${turnId}\0${current.view.workId}\0${revision}`,
    ),
    requestSha256: requestDigest({ turnId, workId: current.view.workId, revision }),
  };
  const outcome = await context.publish(identity, async () => {
    const fresh = await requireCurrentProjectWork({
      butlerData: context.input.butlerData,
      scope: context.input.scope,
      workId: current.view.workId,
    });
    if (!isOpen(fresh.view)) invalid("project_work_not_open");
    const view: DurableWorkView = {
      ...fresh.view,
      status: "abandoned",
      updatedAt: await context.recordedAt(identity),
    };
    return [
      mutableWorkUpdate(
        manifestForView({
          prior: fresh.manifest,
          view,
          scope: context.input.scope,
          operationIdentity: identity,
          bindingRefs: fresh.manifest.bindingRefs,
          material: await context.captureMaterial(fresh.view, view, identity),
          revisions: workRevisions(fresh.manifest),
        }),
        false,
      ),
    ];
  });
  const abandoned = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId: current.view.workId,
  });
  proveProjectWorkOperationReceipt(outcome, abandoned.view.workId, []);
  return context.afterMutation(abandoned);
}

function isOpen(view: DurableWorkView): boolean {
  return view.status === "open" || view.status === "blocked";
}
function invalid(message: string): never {
  throw new Error(message);
}
