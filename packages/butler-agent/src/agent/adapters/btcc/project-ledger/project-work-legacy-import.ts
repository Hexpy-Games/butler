import type {
  DurableWorkView,
  LegacyOpenWorkImportResult,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import { captureMaterialSnapshot } from "./project-work-material-snapshot.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import type { ProjectWorkLegacySnapshot } from "./project-work-contracts.ts";
import {
  immutableChildUpdate,
} from "./project-work-record-updates.ts";
import {
  childItem,
  manifestForView,
  mutableWorkUpdate,
} from "./project-work-mapping.ts";
import { projectWorkRecordId, requestDigest } from "./project-work-json.ts";
import { canonicalJson } from "./project-work-json.ts";
import { digest } from "../../../btcc/identity/index.ts";
import {
  readCurrentProjectWork,
  requireCurrentProjectWork,
} from "./project-work-snapshot.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import type { ProjectWorkWriteContext } from "./project-work-write-context.ts";
import { requireObservedProjectWorkReceipt } from "./project-work-receipt.ts";

export async function importLegacyProjectWork(
  context: ProjectWorkWriteContext,
  scope: WorkTurnScope,
): Promise<LegacyOpenWorkImportResult | null> {
  context.assertScope(scope);
  const runtime = context.input.legacyRuntime;
  if (!runtime) throw new Error("project_work_legacy_import_required");
  const observed = runtime.readImportObservation({
    scope,
    resolvedScope: context.input.scope,
  });
  if (observed) {
    const sourceIdentity = observed.sourceProgramId.startsWith("current-r3:")
      ? `current-r3:${observed.workId}`
      : `r2:${observed.sourceProgramId}:${observed.workId}`;
    const identity = legacyIdentity(
      context.input.scope.ledgerProjectId,
      sourceIdentity,
      observed.sourceSha256,
    );
    await requireObservedProjectWorkReceipt({
      context,
      identity,
      expectedTarget: { id: observed.workId, kind: "work", parentId: null },
      recoverProjection: false,
    });
    const current = await requireCurrentProjectWork({
      butlerData: context.input.butlerData,
      scope: context.input.scope,
      workId: observed.workId,
    });
    return {
      sourceProgramId: observed.sourceProgramId,
      imported: false,
      work: current.view,
    };
  }
  const snapshot = await runtime.captureStableSnapshot({
    scope,
    resolvedScope: context.input.scope,
  });
  if (!snapshot) return null;
  const identity = legacyIdentity(
    context.input.scope.ledgerProjectId,
    snapshot.sourceIdentity,
    snapshot.sourceSha256,
  );
  verifyLegacyResults(context, snapshot);
  const material = await context.captureMaterial(null, snapshot.work, identity);
  const outcome = await context.publish(identity, async () => {
    const relation = await context.relation(scope);
    if (relation.sessionHead || relation.binding)
      throw new Error("project_work_legacy_target_conflict");
    if (await readCurrentProjectWork({
      butlerData: context.input.butlerData,
      scope: context.input.scope,
      workId: snapshot.work.workId,
    })) throw new Error("project_work_legacy_target_conflict");
    const children = legacyChildren(context.input.scope, snapshot, identity);
    const revisions = legacyRevisions(snapshot);
    const manifest = manifestForView({
      view: snapshot.work,
      scope: context.input.scope,
      operationIdentity: identity,
      bindingRefs: snapshot.bindings.map((binding) => ({
        bindingRevisionId: binding.bindingRevisionId,
        turnId: binding.turnId,
        revision: binding.revision,
      })),
      material,
      revisions,
    });
    const updates = [mutableWorkUpdate(manifest, true)];
    for (const child of children) {
      const update = await immutableChildUpdate({
        scope: context.input.scope,
        workId: snapshot.work.workId,
        ...childItem(child),
        child,
      });
      if (update) updates.push(update);
    }
    return updates;
  });
  if (outcome.skipped) throw new Error("project_work_legacy_publication_missing");
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId: snapshot.work.workId,
  });
  verifyLegacyResults(context, snapshot, current.view);
  await runtime.revalidateBeforeObservation({
    scope,
    resolvedScope: context.input.scope,
    snapshot,
  });
  const head = await observeProjectLedgerHead(context.input.scope.ledgerRoot);
  runtime.observeImported({
    scope,
    resolvedScope: context.input.scope,
    snapshot,
    canonicalHeadSha256: head.sourceSha256,
    verifyResults: () => verifyLegacyResults(context, snapshot, current.view),
  });
  return {
    sourceProgramId: snapshot.sourceProgramId,
    imported: !outcome.replayed,
    work: current.view,
  };
}

function legacyIdentity(
  ledgerProjectId: string,
  sourceIdentity: string,
  sourceSha256: string,
) {
  return {
    kind: "legacy_import" as const,
    id: digest(
      `btcc-project-work-legacy-import.v1\0${ledgerProjectId}` +
      `\0${sourceIdentity}\0${sourceSha256}`,
    ),
    requestSha256: requestDigest({
      ledgerProjectId,
      sourceIdentity,
      sourceSha256,
    }),
  };
}

function legacyChildren(
  scope: ProjectWorkWriteContext["input"]["scope"],
  snapshot: ProjectWorkLegacySnapshot,
  identity: Parameters<ProjectWorkWriteContext["publish"]>[0],
): ProjectWorkChild[] {
  const work = snapshot.work;
  const children: ProjectWorkChild[] = [];
  for (const plan of snapshot.plans) children.push({
    schema: "butler.btcc-project-work-plan.v1",
    workId: work.workId,
    operationIdentity: identity,
    plan,
  });
  for (const item of snapshot.checkpoints) {
    children.push({
      schema: "butler.btcc-project-work-checkpoint.v1",
      workId: work.workId,
      operationIdentity: identity,
      checkpointIdentity: item.checkpoint.checkpointRevisionId,
      resultWindow: {
        fromSequence: item.fromResultSequence,
        toSequence: item.toResultSequence,
      },
      checkpoint: item.checkpoint,
    });
  }
  for (const review of snapshot.reviews) children.push({
    schema: "butler.btcc-project-work-review.v1",
    workId: work.workId,
    operationIdentity: identity,
    review,
    boundResultSequence: review.boundResultRefs.length,
  });
  for (const item of snapshot.dispositions) {
    const disposition = item.disposition;
    children.push({
      schema: "butler.btcc-project-work-disposition.v1",
      workId: work.workId,
      operationIdentity: identity,
      disposition,
      materialSnapshot: captureMaterialSnapshot(
        item.historicalView,
        {
          effectWatermark: item.effectWatermark,
          effectBlockers: [],
        },
        disposition.materialFingerprint,
      ),
    });
  }
  work.resultRefs.forEach((result, index) => {
    children.push({
      schema: "butler.btcc-project-work-result-reference.v1",
      workId: work.workId,
      sessionId: work.sessionId,
      scope: {
        appProjectId: scope.appProjectId,
        ledgerProjectId: scope.ledgerProjectId,
      },
      operationIdentity: identity,
      result: { ...result, sequence: index + 1 },
    });
  });
  for (const binding of snapshot.bindings) children.push({
    schema: "butler.btcc-project-work-binding.v1",
    workId: work.workId,
    operationIdentity: identity,
    binding: {
      bindingRevisionId: binding.bindingRevisionId,
      turnId: binding.turnId,
      sessionId: work.sessionId,
      revision: binding.revision,
      boundAt: binding.boundAt,
    },
  });
  return children;
}

function legacyRevisions(snapshot: ProjectWorkLegacySnapshot) {
  return {
    planRevision: snapshot.plans.at(-1)?.revision ?? 0,
    checkpointRevision: snapshot.checkpoints.at(-1)?.checkpoint.revision ?? 0,
    checkpointResultSequence:
      snapshot.checkpoints.at(-1)?.toResultSequence ?? 0,
    reviewRevision: snapshot.reviews.at(-1)?.revision ?? 0,
    dispositionRevision:
      snapshot.dispositions.at(-1)?.disposition.revision ?? 0,
  };
}

function verifyLegacyResults(
  context: ProjectWorkWriteContext,
  snapshot: ProjectWorkLegacySnapshot,
  canonical?: DurableWorkView,
): void {
  if (
    canonical &&
    canonicalJson(canonical.resultRefs) !== canonicalJson(snapshot.work.resultRefs)
  ) throw new Error("project_work_legacy_result_reference_mismatch");
  for (const result of snapshot.work.resultRefs) {
    const evidence = context.input.resultRuntime.readCommittedResult({
      turnId: result.originTurnId,
      sessionId: snapshot.work.sessionId,
      toolCallId: result.toolCallId,
    });
    if (
      result.resultRef !== projectWorkRecordId("result", result.toolCallId) ||
      evidence.toolName !== result.toolName ||
      evidence.resultSha256 !== result.resultSha256
    ) throw new Error("project_work_legacy_result_invalid");
  }
}
