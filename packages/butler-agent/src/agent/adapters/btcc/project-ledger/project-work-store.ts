import type {
  DurableWorkStore,
  DurableWorkView,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type {
  CreateProjectWorkStoreInput,
  ProjectWorkOperationIdentity,
} from "./project-work-contracts.ts";
import {
  claimProjectWorkCloseoutCorrection,
  recordProjectWorkDisposition,
  recordProjectWorkReview,
} from "./project-work-closeout-recording.ts";
import {
  recordProjectWorkCheckpoint,
  replaceProjectWorkPlan,
} from "./project-work-progress-recording.ts";
import { abandonProjectWork } from "./project-work-abandonment-recording.ts";
import {
  bindOpenProjectWork,
  continueProjectWork,
} from "./project-work-relation-recording.ts";
import { startProjectWork } from "./project-work-start-recording.ts";
import { publishProjectWorkRecords } from "./project-work-publication.ts";
import {
  requireProjectWorkSessionHead,
  readCanonicalProjectWorkBinding,
  readCanonicalProjectWorkRelation,
} from "./project-work-relation-snapshot.ts";
import {
  requireCurrentProjectWork,
  type CurrentProjectWorkSnapshot,
} from "./project-work-snapshot.ts";
import type { ProjectWorkWriteContext } from "./project-work-write-context.ts";
import { assertMaterialSnapshotForView } from "./project-work-material-snapshot.ts";
import { probeProjectWorkServiceReplay } from "./project-work-service-replay.ts";
import { safeProjectWorkPublicOperation } from "./project-work-errors.ts";
import { attachProjectWorkToolResult } from "./project-work-result-attachment.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import { importLegacyProjectWork } from "./project-work-legacy-import.ts";

export function createProjectWorkStore(
  input: CreateProjectWorkStoreInput,
): DurableWorkStore {
  return new ProjectWorkStore(input);
}

class ProjectWorkStore implements DurableWorkStore, ProjectWorkWriteContext {
  private readonly emptyRelationCache = new Set<string>();

  constructor(readonly input: CreateProjectWorkStoreInput) {}

  loadContext(scope: WorkTurnScope) {
    return safeProjectWorkPublicOperation(() => this.loadContextUnsafe(scope));
  }
  private async loadContextUnsafe(scope: WorkTurnScope) {
    this.assertScope(scope);
    const replay = await probeProjectWorkServiceReplay({
      butlerData: this.input.butlerData,
      scope: this.input.scope,
      mutation: scope,
    });
    const current = replay ? null : await this.currentForScope(scope);
    const work = replay ?? current?.view;
    if (!work) return null;
    const originalRequest =
      await this.input.runtimeProjection.loadOriginalRequest({
        turnId: work.origin.turnId,
        sessionId: work.sessionId,
        projectRef: this.input.scope.appProjectId,
      });
    if (
      originalRequest.turnId !== work.origin.turnId ||
      originalRequest.messageId !== work.origin.messageId
    ) {
      invalid("project_work_runtime_origin_mismatch");
    }
    return {
      work,
      originalRequest,
      resultFacts: await this.input.runtimeProjection.loadResultFacts(
        work.workId,
      ),
    };
  }

  importOpenLegacyWork(scope: WorkTurnScope) {
    return safeProjectWorkPublicOperation(() =>
      importLegacyProjectWork(this, scope),
    );
  }

  bindOpenWork(scope: WorkTurnScope, expectedWorkId?: string) {
    return safeProjectWorkPublicOperation(() =>
      bindOpenProjectWork(this, scope, expectedWorkId),
    );
  }
  startWork(command: Parameters<DurableWorkStore["startWork"]>[0]) {
    return safeProjectWorkPublicOperation(() => startProjectWork(this, command));
  }
  continueWork(command: Parameters<DurableWorkStore["continueWork"]>[0]) {
    return safeProjectWorkPublicOperation(() =>
      continueProjectWork(this, command),
    );
  }
  replacePlan(command: Parameters<DurableWorkStore["replacePlan"]>[0]) {
    return safeProjectWorkPublicOperation(() =>
      replaceProjectWorkPlan(this, command),
    );
  }
  recordCheckpoint(
    command: Parameters<DurableWorkStore["recordCheckpoint"]>[0],
  ) {
    return safeProjectWorkPublicOperation(() =>
      recordProjectWorkCheckpoint(this, command),
    );
  }
  recordReview(command: Parameters<DurableWorkStore["recordReview"]>[0]) {
    return safeProjectWorkPublicOperation(() =>
      recordProjectWorkReview(this, command),
    );
  }
  recordDisposition(
    command: Parameters<DurableWorkStore["recordDisposition"]>[0],
  ) {
    return safeProjectWorkPublicOperation(() =>
      recordProjectWorkDisposition(this, command),
    );
  }
  claimCloseoutCorrection(
    command: Parameters<DurableWorkStore["claimCloseoutCorrection"]>[0],
  ) {
    return safeProjectWorkPublicOperation(() =>
      claimProjectWorkCloseoutCorrection(this, command),
    );
  }
  attachToolResult(
    command: Parameters<DurableWorkStore["attachToolResult"]>[0],
  ) {
    return safeProjectWorkPublicOperation(() =>
      attachProjectWorkToolResult(this, command),
    );
  }

  boundWorkForTurn(turnId: string) {
    return safeProjectWorkPublicOperation(() => this.boundWorkForTurnUnsafe(turnId));
  }
  private async boundWorkForTurnUnsafe(turnId: string) {
    const located = await this.input.runtimeProjection.locateCanonicalWorks({
      scope: this.input.scope,
      turnId,
    });
    const candidate = await readCanonicalProjectWorkBinding({
      butlerData: this.input.butlerData,
      scope: this.input.scope,
      turnId,
      ...(located.bindingWorkId
        ? { workIds: [located.bindingWorkId] }
        : {}),
    });
    if (!candidate) return null;
    const relation = await readCanonicalProjectWorkRelation({
      butlerData: this.input.butlerData,
      scope: this.input.scope,
      sessionId: candidate.view.sessionId,
      turnId,
    });
    if (relation.binding?.view.workId !== candidate.view.workId)
      invalid("project_work_turn_binding_stale");
    return relation.binding.view;
  }
  abandonBoundWorkForTurn(turnId: string) {
    return safeProjectWorkPublicOperation(() => abandonProjectWork(this, turnId));
  }

  async publish(
    identity: ProjectWorkOperationIdentity,
    prepareUpdates: Parameters<
      typeof publishProjectWorkRecords
    >[0]["prepareUpdates"],
    recoverProjection = true,
  ) {
    const outcome = await publishProjectWorkRecords({
      butlerData: this.input.butlerData,
      scope: this.input.scope,
      identity,
      prepareUpdates,
    });
    this.emptyRelationCache.clear();
    if (!outcome.skipped && recoverProjection)
      await this.recoverPublicationProjection(outcome.targets, identity);
    return outcome;
  }
  async afterMutation(
    current: CurrentProjectWorkSnapshot,
    _affected: CurrentProjectWorkSnapshot[] = [],
  ) {
    this.emptyRelationCache.clear();
    return current.view;
  }
  private async recoverPublicationProjection(
    targets: Array<{ id: string; kind: string; parentId: string | null }>,
    identity: ProjectWorkOperationIdentity,
  ) {
    const workIds = new Set(
      targets.flatMap((target) =>
        target.kind === "work"
          ? [target.id]
          : target.parentId
            ? [target.parentId]
            : [],
      ),
    );
    await this.observeStableRuntimeProjection([...workIds], identity);
  }
  private async observeStableRuntimeProjection(
    workIds: string[],
    identity: ProjectWorkOperationIdentity,
    attempt = 1,
  ): Promise<void> {
    const before = await observeProjectLedgerHead(this.input.scope.ledgerRoot);
    const affected = await Promise.all(workIds.map((workId) =>
      requireCurrentProjectWork({
        butlerData: this.input.butlerData,
        scope: this.input.scope,
        workId,
      }),
    ));
    const sessionIds = new Set(affected.map((item) => item.view.sessionId));
    const heads = new Map(
      await Promise.all([...sessionIds].map(async (sessionId) => [
        sessionId,
        await requireProjectWorkSessionHead({
          butlerData: this.input.butlerData,
          scope: this.input.scope,
          sessionId,
        }),
      ] as const)),
    );
    const after = await observeProjectLedgerHead(this.input.scope.ledgerRoot);
    if (before.sourceSha256 !== after.sourceSha256) {
      if (attempt >= 3) invalid("project_work_snapshot_unstable");
      return this.observeStableRuntimeProjection(workIds, identity, attempt + 1);
    }
    for (const sessionId of sessionIds) {
      const head = heads.get(sessionId)!;
      const snapshots = new Map(
        affected
          .filter((item) => item.view.sessionId === sessionId)
          .map((item) => [item.view.workId, item]),
      );
      snapshots.set(head.view.workId, head);
      await this.input.runtimeProjection.observeCanonicalWorks({
        works: [...snapshots.values()].map((snapshot) => ({
          work: snapshot.view,
          bindings: snapshot.children.flatMap((child) =>
            child.schema === "butler.btcc-project-work-binding.v1"
              ? [{
                  ...child.binding,
                  isCurrent: snapshot.manifest.bindingRefs.some(
                    (ref) => ref.bindingRevisionId ===
                      child.binding.bindingRevisionId,
                  ),
                }]
              : [],
          ),
        })),
        sessionHeadWorkId: head.view.workId,
        ledgerProjectId: this.input.scope.ledgerProjectId,
        canonicalHeadSha256: after.sourceSha256,
        ...(identity.kind === "legacy_import" && workIds.length === 1
          ? { legacyImportClaimWorkId: workIds[0] }
          : {}),
      });
    }
  }
  async requireBound(scope: WorkTurnScope, allowCompleted = false) {
    this.assertScope(scope);
    const relation = await this.relation(scope);
    const binding = relation.binding;
    if (!binding)
      invalid("project_work_turn_binding_missing");
    if (
      relation.sessionHead?.view.workId !== binding.view.workId ||
      !binding.manifest.bindingRefs.some((item) => item.turnId === scope.turnId)
    )
      invalid("project_work_turn_binding_stale");
    if (
      !isOpen(binding.view) &&
      !(allowCompleted && binding.view.status === "completed")
    ) {
      invalid("project_work_not_open");
    }
    return binding;
  }
  async currentForScope(scope: WorkTurnScope) {
    const relation = await this.relation(scope);
    if (relation.binding) return relation.binding;
    return relation.sessionHead && isOpen(relation.sessionHead.view)
      ? relation.sessionHead
      : null;
  }
  async relation(scope: WorkTurnScope) {
    const cacheKey = `${scope.sessionId}\0${scope.turnId}`;
    if (this.emptyRelationCache.has(cacheKey))
      return { sessionHead: null, binding: null };
    const located = await this.input.runtimeProjection.locateCanonicalWorks({
      scope: this.input.scope,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
    });
    const workIds = located.bindingWorkId
      ? [located.sessionHeadWorkId, located.bindingWorkId].filter(
          (workId): workId is string => Boolean(workId),
        )
      : [];
    const relation = await readCanonicalProjectWorkRelation({
      butlerData: this.input.butlerData,
      scope: this.input.scope,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      ...(workIds.length > 0 ? { workIds } : {}),
    });
    if (!relation.sessionHead && !relation.binding)
      this.emptyRelationCache.add(cacheKey);
    return relation;
  }
  assertScope(scope: WorkTurnScope) {
    if (scope.projectRef !== this.input.scope.appProjectId)
      invalid("project_work_scope_mismatch");
  }
  async recordedAt(identity: ProjectWorkOperationIdentity) {
    const value =
      await this.input.runtimeProjection.operationRecordedAt(identity);
    if (!value || Number.isNaN(Date.parse(value)))
      invalid("project_work_operation_time_invalid");
    return value;
  }
  async captureMaterial(
    current: DurableWorkView | null,
    candidate: DurableWorkView,
    operationIdentity: ProjectWorkOperationIdentity,
  ) {
    const material =
      await this.input.runtimeProjection.captureWorkMaterial({
        operationIdentity,
        current,
        candidate,
      });
    if (!/^[a-f0-9]{64}$/u.test(material.materialFingerprint))
      invalid("project_work_material_fingerprint_invalid");
    assertMaterialSnapshotForView(
      material.materialSnapshot,
      candidate,
      material.materialFingerprint,
    );
    return material;
  }
}

function isOpen(view: DurableWorkView) {
  return view.status === "open" || view.status === "blocked";
}
function invalid(message: string): never {
  throw new Error(message);
}
