import type { Database } from "bun:sqlite";
import type {
  LegacyProjectWorkSnapshot,
  LegacyProjectWorkSource,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import {
  allowedNextWorkStages,
  type DurableWorkView,
} from "../../../btcc/work/index.ts";
import type {
  ProjectWorkLegacySnapshot,
  ResolvedProjectWorkScope,
} from "../project-ledger/index.ts";
import { projectLegacyOpenWork } from "./guided-work-legacy-projection.ts";
import { legacyImportId } from "./guided-work-legacy-writer.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { digest, stableJson } from "./identity.ts";
import { GuidedWorkLegacyProjectImporter } from "./guided-work-legacy-project-importer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

type RawTurn = {
  turn_id: string;
  session_id: string;
  original_message_id: string;
  original_message: string;
  semantic_state: string;
  execution_fence: number;
  managed_state_json: string | null;
};

/** Purely maps a stable raw R2 snapshot; it creates no intermediate R3 rows. */
export function captureRawR2ProjectWorkSnapshot(
  db: Database,
  input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
    source: LegacyProjectWorkSnapshot;
    sourceProgramIds: readonly string[];
  },
): ProjectWorkLegacySnapshot {
  if (!/^[a-f0-9]{64}$/u.test(input.source.sourceRevision))
    invalid("project_work_legacy_source_revision_invalid");
  const projection = projectLegacyOpenWork({
    goal: input.source.goalContract,
    plan: input.source.plan,
    works: input.source.works,
    tasks: input.source.tasks,
    readRecord: (recordId) => input.source.referencedRecords
      .find((record) => record.recordId === recordId)?.content ?? null,
  });
  const origin = locateOriginTurn(
    db,
    input.scope.sessionId,
    input.source.sourceProgramId,
    projection.originalMessageId,
  );
  if (!origin || origin.session_id !== input.scope.sessionId)
    invalid("project_work_legacy_turn_ownership_invalid");
  if (
    projection.originalMessageId &&
    origin.original_message_id !== projection.originalMessageId
  ) invalid("project_work_legacy_origin_message_invalid");
  const importId = legacyImportId(input.source.sourceProgramId, input.scope);
  assertRawImportIdentityAvailable(
    db,
    importId,
    input.source.sourceProgramId,
    input.scope.sessionId,
    input.resolvedScope.appProjectId,
  );
  const workId = guidedWorkRecordId("work", importId);
  const planId = projection.plan ? guidedWorkRecordId("plan", importId) : null;
  const checkpointId = projection.checkpoint
    ? guidedWorkRecordId("checkpoint", importId)
    : null;
  const recordedAt = "1970-01-01T00:00:00.000Z";
  const plan = projection.plan && planId
    ? {
        planRevisionId: planId,
        revision: 1,
        objective: projection.objective,
        governingRefs: [],
        actions: projection.plan.actions,
        checks: projection.plan.checks,
        originTurnId: origin.turn_id,
        createdAt: recordedAt,
      }
    : undefined;
  const checkpoint = projection.checkpoint && checkpointId && plan
    ? {
        checkpointRevisionId: checkpointId,
        revision: 1,
        planRevisionId: plan.planRevisionId,
        stage: projection.checkpoint.stage,
        actionProgress: projection.checkpoint.actionProgress,
        publicSummary: projection.checkpoint.publicSummary,
        nextStep: projection.checkpoint.nextStep,
        referencedResultRefs: [],
        originTurnId: origin.turn_id,
        createdAt: recordedAt,
      }
    : undefined;
  const work: DurableWorkView = {
    workId,
    sessionId: input.scope.sessionId,
    scope: { kind: "project", projectRef: input.resolvedScope.appProjectId },
    origin: {
      turnId: origin.turn_id,
      messageId: origin.original_message_id,
    },
    objective: projection.objective,
    status: "open",
    ...(checkpoint ? { currentStage: checkpoint.stage } : {}),
    allowedNextStages: allowedNextWorkStages(checkpoint?.stage),
    actionProgress: checkpoint?.actionProgress ?? plan?.actions.map((action) => ({
      actionKey: action.actionKey,
      status: "pending" as const,
    })) ?? [],
    ...(plan ? { currentPlan: plan } : {}),
    ...(checkpoint ? { latestCheckpoint: checkpoint } : {}),
    effectWatermark: digest(stableJson([])),
    resultRefs: [],
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
  const binding = {
    bindingRevisionId: guidedWorkRecordId(
      "binding",
      `${origin.turn_id}\0${1}\0${workId}`,
    ),
    turnId: origin.turn_id,
    revision: 1,
    boundAt: recordedAt,
    isCurrent: true,
  };
  const rawSource = {
    sourceProgramId: input.source.sourceProgramId,
    goalContract: input.source.goalContract,
    plan: input.source.plan,
    works: input.source.works,
    tasks: input.source.tasks,
    referencedRecords: input.source.referencedRecords,
  };
  const semantic = {
    sourceProgramId: input.source.sourceProgramId,
    sourceIdentity: `r2:${input.source.sourceProgramId}:${workId}`,
    rawSource,
    work,
    plans: plan ? [plan] : [],
    checkpoints: checkpoint
      ? [{ checkpoint, fromResultSequence: 0, toResultSequence: 0 }]
      : [],
    reviews: [],
    dispositions: [],
    bindings: [binding],
    turns: [{
      turnId: origin.turn_id,
      sessionId: origin.session_id,
      originalMessageId: origin.original_message_id,
      originalMessage: origin.original_message,
      semanticState: origin.semantic_state,
      executionFence: origin.execution_fence,
    }],
  };
  return {
    sourceKind: "raw_r2",
    sourceProgramIds: [...input.sourceProgramIds],
    sourceProgramId: semantic.sourceProgramId,
    sourceIdentity: semantic.sourceIdentity,
    sourceSha256: digest(stableJson(semantic)),
    work,
    plans: semantic.plans,
    checkpoints: semantic.checkpoints,
    reviews: [],
    dispositions: [],
    bindings: [binding],
    turns: semantic.turns,
  };
}

export async function revalidateRawR2ProjectWorkSource(input: {
  db: Database;
  reader: GuidedWorkViewReader;
  source: LegacyProjectWorkSource;
  scope: WorkTurnScope;
  resolvedScope: ResolvedProjectWorkScope;
  snapshot: ProjectWorkLegacySnapshot;
}): Promise<void> {
  const importer = new GuidedWorkLegacyProjectImporter(input.db, input.reader);
  const programIds = input.db.transaction(() =>
    importer.locateProgramIds(input.scope),
  ).immediate();
  if (
    stableIds(programIds) !== stableIds(input.snapshot.sourceProgramIds) ||
    !programIds.includes(input.snapshot.sourceProgramId)
  ) invalid("project_work_legacy_source_changed");
  const source = await input.source.loadOpenWork({
    projectRef: input.scope.projectRef ?? input.resolvedScope.appProjectId,
    programIds,
  });
  if (!source || source.sourceProgramId !== input.snapshot.sourceProgramId)
    invalid("project_work_legacy_source_changed");
  const reloaded = input.db.transaction(() =>
    captureRawR2ProjectWorkSnapshot(input.db, {
      scope: input.scope,
      resolvedScope: input.resolvedScope,
      source,
      sourceProgramIds: programIds,
    }),
  ).immediate();
  if (
    reloaded.sourceSha256 !== input.snapshot.sourceSha256 ||
    reloaded.work.workId !== input.snapshot.work.workId
  ) invalid("project_work_legacy_source_changed");
}

function locateOriginTurn(
  db: Database,
  sessionId: string,
  programId: string,
  originalMessageId?: string,
): RawTurn | null {
  const rows = db.query<RawTurn, [string]>(`
    SELECT turn_id, session_id, original_message_id, original_message,
      semantic_state, execution_fence, managed_state_json
    FROM btcc_turns WHERE session_id = ? ORDER BY rowid
  `).all(sessionId);
  const exact = originalMessageId
    ? rows.find((row) => row.original_message_id === originalMessageId)
    : undefined;
  return exact ?? rows.find((row) => readProgramId(row.managed_state_json) === programId) ?? null;
}

function assertRawImportIdentityAvailable(
  db: Database,
  importId: string,
  sourceProgramId: string,
  sessionId: string,
  scopeRef: string,
): void {
  const workId = guidedWorkRecordId("work", importId);
  const rows = db.query<{ work_id: string }, [string, string, string, string, string]>(`
    SELECT work_id FROM btcc_guided_work_legacy_imports
    WHERE import_id = ? OR work_id = ? OR (
      legacy_program_id = ? AND session_id = ?
      AND scope_kind = 'project' AND scope_ref = ?
    )
  `).all(importId, workId, sourceProgramId, sessionId, scopeRef);
  if (rows.length > 0) invalid("project_work_legacy_identity_conflict");
}

function readProgramId(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { programId?: unknown };
    return typeof parsed.programId === "string" ? parsed.programId : null;
  } catch {
    return null;
  }
}

function stableIds(ids: readonly string[]): string {
  return [...ids].sort().join("\0");
}

function invalid(code: string): never { throw new Error(code); }
