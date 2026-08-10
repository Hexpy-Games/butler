import type {
  GuidedToolJournalRecord,
  SqliteGuidedToolJournal,
} from "../../adapters/index.ts";
import type { DurableWorkContext } from "../work/index.ts";
import { digest, stableJson } from "../identity/index.ts";
import {
  projectGuidedToolContextForReplay,
  type GuidedToolContextReplayProjection,
} from "./guided-tool-replay-projection.ts";
import {
  isM1CompactReplayControlTool,
  READ_OPERATION_RESULTS_TOOL_NAME,
  type PhaseContinuity,
} from "../../tools/m1-compact-replay.ts";
import type { GuidedCompactReplayBudget } from "./guided-compact-replay-budget.ts";
import { readGuidedOperationResultViews } from
  "./guided-operation-result-read.ts";
import type {
  BtccCompactReplayIdentity,
  BtccCompactReplayInitialProjection,
} from "./compact-replay-messages.ts";
export type GuidedCompactReplayContext = {
  toolResults: GuidedToolContextReplayProjection;
  workResults: GuidedToolContextReplayProjection | null;
  projectionRevision: string;
  exactRead: boolean | null;
  duplicateEffect: boolean | null;
  resultRef: string | null;
  anchorCount: number;
  replayCount: number;
  exactReadAttempts: number;
  exactReadSuccesses: number;
  exactReadFailures: number;
  phaseContinuity: PhaseContinuity | null;
  initialProjection: BtccCompactReplayInitialProjection;
};

export async function createGuidedCompactReplayContext(input: {
  toolJournal: SqliteGuidedToolJournal;
  turnId: string;
  sessionId: string;
  projectRef?: string;
  work: DurableWorkContext | null;
  budget: GuidedCompactReplayBudget;
}): Promise<GuidedCompactReplayContext> {
  const turnRecords = input.toolJournal.listForCompactReplay(input.turnId);
  const workCallIds = new Set(
    (input.work?.work.resultRefs ?? []).map((result) => result.toolCallId),
  );
  const turnNewestBatchId = turnRecords.findLast((record) =>
    !isM1CompactReplayControlTool(record.toolName) &&
    record.status !== "started" && Boolean(record.operationBatchId))
    ?.operationBatchId;
  const workRead = await readWorkResults({
    ...input,
    preferredNewestBatchId: turnNewestBatchId,
  });
  const newestBatchId = turnNewestBatchId ?? workRead?.newestBatchId;
  const directRead = readDirectResults({
    toolJournal: input.toolJournal,
    sessionId: input.sessionId,
    records: turnRecords.filter((record) =>
      !isM1CompactReplayControlTool(record.toolName) &&
      !workCallIds.has(record.callId)),
    newestBatchId,
  });
  const toolResults = projectGuidedToolContextForReplay(directRead.records, {
    maxRecordBytes: input.budget.newestRecordBytes,
    maxTotalBytes: input.budget.newestBatchBytes,
    ...(newestBatchId ? { newestBatchId } : {}),
  });
  const workResults = workRead
    ? projectGuidedToolContextForReplay(workRead.records, {
        sequenceByResultRef: workRead.sequenceByResultRef,
        workId: input.work?.work.workId,
        maxRecordBytes: input.budget.newestRecordBytes,
        maxTotalBytes: input.budget.newestBatchBytes,
        ...(newestBatchId ? { newestBatchId } : {}),
      })
    : null;
  const restoredViews = restoreSelectedViews({
    toolJournal: input.toolJournal,
    records: turnRecords,
    sessionId: input.sessionId,
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    workId: input.work?.work.workId ?? null,
    maxOutputTokens: input.budget.selectedViewTokens,
  });
  const initialProjection = createInitialProjection({
    toolResults,
    workResults,
    selectedViews: restoredViews.views,
  });
  const phaseContinuity = input.toolJournal.readLatestPhaseContinuity({
    turnId: input.turnId,
    workId: input.work?.work.workId ?? null,
  });
  const projectionRevision = digest(stableJson({
    tool: toolResults.projectionRevision,
    work: workResults?.projectionRevision ?? null,
    phaseContinuity,
    selectedViews: restoredViews.views.map((view) => ({
      resultRef: view.identity.result_ref,
      selector: view.selector,
    })),
  }));
  const latestRef = workResults?.newest.find((record) =>
    typeof record.result_ref === "string")?.result_ref ??
    toolResults.newest.find((record) => typeof record.result_ref === "string")
      ?.result_ref ?? null;
  const exactRead = directRead.exactRead === true || workRead?.exactRead === true ||
      restoredViews.attempts > 0
    ? true
    : null;
  const sourceExactReads = Number(directRead.exactRead === true) +
    Number(workRead?.exactRead === true);
  return {
    toolResults,
    workResults,
    projectionRevision,
    exactRead,
    // A successful exact rehydration is read-only. A missing attempt or failed
    // read cannot make a duplicate-effect assertion.
    duplicateEffect: exactRead === true ? false : null,
    resultRef: typeof latestRef === "string" ? latestRef : null,
    anchorCount: toolResults.anchorCount + (workResults?.anchorCount ?? 0),
    replayCount: restoredViews.attempts,
    exactReadAttempts: sourceExactReads + restoredViews.attempts,
    exactReadSuccesses: sourceExactReads + restoredViews.attempts,
    exactReadFailures: 0,
    phaseContinuity,
    initialProjection,
  };
}

function restoreSelectedViews(input: {
  toolJournal: SqliteGuidedToolJournal;
  records: readonly GuidedToolJournalRecord[];
  sessionId: string;
  projectRef?: string;
  workId: string | null;
  maxOutputTokens: number;
}) {
  const reads = input.records.filter((record) =>
    record.toolName === READ_OPERATION_RESULTS_TOOL_NAME &&
    record.status === "completed" && successfulReferenceRead(record.result));
  return {
    attempts: reads.length,
    views: reads.flatMap((record) => readGuidedOperationResultViews({
      args: record.arguments,
      toolJournal: input.toolJournal,
      boundWorkId: input.workId,
      scope: {
        sessionId: input.sessionId,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        ...(input.workId ? { workId: input.workId } : {}),
      },
      maxOutputTokens: input.maxOutputTokens,
    }).views),
  };
}

function successfulReferenceRead(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ok === true && record.reference_only === true &&
    Number.isSafeInteger(record.read_count) && Number(record.read_count) > 0 &&
    Array.isArray(record.result_refs) &&
    record.result_refs.length === Number(record.read_count) &&
    record.result_refs.every((ref) => typeof ref === "string" && ref.length > 0);
}

function createInitialProjection(input: {
  toolResults: GuidedToolContextReplayProjection;
  workResults: GuidedToolContextReplayProjection | null;
  selectedViews: BtccCompactReplayInitialProjection["selectedViews"];
}): BtccCompactReplayInitialProjection {
  const projections = [input.toolResults, input.workResults]
    .filter((value): value is GuidedToolContextReplayProjection => Boolean(value));
  const newest = projections.flatMap((projection) => projection.newest);
  return {
    openAnchors: newest.filter((record) => record.status === "started"),
    newestBatch: newest.flatMap((payload) => {
      const identity = projectedIdentity(payload);
      return identity ? [{ identity, payload }] : [];
    }),
    selectedViews: input.selectedViews,
    older: projections.flatMap((projection) =>
      projection.older.flatMap((identity) => {
        const projected = projectedIdentity(identity);
        return projected ? [projected] : [];
      })),
  };
}

function projectedIdentity(
  value: Record<string, unknown>,
): BtccCompactReplayIdentity | null {
  if ((value.kind !== "work" && value.kind !== "direct") ||
    typeof value.result_ref !== "string" ||
    typeof value.tool_name !== "string" ||
    !["completed", "failed", "cancelled"].includes(String(value.status)) ||
    !["succeeded", "failed", "cancelled"].includes(String(value.outcome)) ||
    !["complete", "incomplete"].includes(String(value.completeness)) ||
    (value.revision !== null && !Number.isInteger(value.revision)) ||
    (value.result_sha256 !== null &&
      typeof value.result_sha256 !== "string")) {
    return null;
  }
  if (value.kind === "work" && typeof value.work_id !== "string") return null;
  return {
    kind: value.kind,
    result_ref: value.result_ref,
    ...(value.kind === "work" ? { work_id: value.work_id as string } : {}),
    revision: value.revision as number | null,
    tool_name: value.tool_name,
    status: value.status as BtccCompactReplayIdentity["status"],
    result_sha256: value.result_sha256 as string | null,
    outcome: value.outcome as BtccCompactReplayIdentity["outcome"],
    completeness: value.completeness as BtccCompactReplayIdentity["completeness"],
    ...(value.command_execution_summary
      ? {
          command_execution_summary: value.command_execution_summary as
            NonNullable<BtccCompactReplayIdentity["command_execution_summary"]>,
        }
      : {}),
  };
}

type WorkResultRead = {
  records: GuidedToolJournalRecord[];
  sequenceByResultRef: ReadonlyMap<string, number>;
  exactRead: true | null;
  newestBatchId?: string;
};

async function readWorkResults(input: {
  toolJournal: SqliteGuidedToolJournal;
  sessionId: string;
  projectRef?: string;
  work: DurableWorkContext | null;
  preferredNewestBatchId?: string;
}): Promise<WorkResultRead | null> {
  const refs = input.work?.work.resultRefs ?? [];
  if (!input.work || refs.length === 0) return null;
  const selectors = refs.map((result) => {
    if (result.sequence === undefined) {
      throw new Error("guided_result_revision_required");
    }
    return {
      kind: "work" as const,
      resultRef: result.resultRef,
      workId: input.work!.work.workId,
      revision: result.sequence,
      resultSha256: result.resultSha256 ?? null,
    };
  });
  const readScope = {
    sessionId: input.sessionId,
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    workId: input.work.work.workId,
  };
  const batchFacts = input.toolJournal.readWorkResultBatchFacts({
    selectors,
    scope: readScope,
  });
  const newestBatchId = input.preferredNewestBatchId ??
    batchFacts.findLast((fact) => fact.operationBatchId)?.operationBatchId;
  const newestRefs = newestBatchId
    ? selectors.filter((selector, index) =>
        batchFacts[index]?.operationBatchId === newestBatchId)
    : [];
  const exact = newestRefs.map((result) => {
      return input.toolJournal.readExactResult({
        selector: result,
        scope: readScope,
      });
  });
  const exactByRef = new Map(exact.map((result) => [result.resultRef, result]));
  const sequenceByResultRef = new Map(
    refs.map((result, index) => [
      result.resultRef,
      result.sequence ?? index + 1,
    ] as const),
  );
  const records = refs.map((ref) => {
    const result = exactByRef.get(ref.resultRef);
    const batch = batchFacts.find((fact) => fact.resultRef === ref.resultRef);
    return {
      callId: ref.toolCallId,
      resultRef: ref.resultRef,
      toolName: ref.toolName,
      rawArguments: "",
      arguments: {},
      status: ref.status,
      ...(batch?.operationBatchId
        ? { operationBatchId: batch.operationBatchId }
        : {}),
      ...(batch?.operationBatchOrdinal !== undefined
        ? { operationBatchOrdinal: batch.operationBatchOrdinal }
        : {}),
      ...(result?.result !== undefined ? { result: result.result } : {}),
      ...(result?.structuralFacts ? { structuralFacts: result.structuralFacts } : {}),
      ...(ref.resultSha256 ? { resultSha256: ref.resultSha256 } : {}),
      ...(ref.errorCode ? { errorCode: ref.errorCode } : {}),
    } satisfies GuidedToolJournalRecord;
  });
  return {
    records,
    sequenceByResultRef,
    exactRead: exact.length > 0 ? true : null,
    ...(newestBatchId ? { newestBatchId } : {}),
  };
}

function readDirectResults(input: {
  toolJournal: SqliteGuidedToolJournal;
  sessionId: string;
  records: GuidedToolJournalRecord[];
  newestBatchId?: string;
}): { records: GuidedToolJournalRecord[]; exactRead: true | null } {
  const newest = input.records.filter((record) =>
    record.status !== "started" &&
    Boolean(input.newestBatchId) &&
    record.operationBatchId === input.newestBatchId);
  if (newest.length === 0) return { records: input.records, exactRead: null };
  const exact = newest.map((record) => input.toolJournal.readExactResult({
    selector: {
      kind: "direct" as const,
      resultRef: record.resultRef!,
      revision: null,
      resultSha256: record.resultSha256 ?? null,
    },
    scope: { sessionId: input.sessionId },
  }));
  const exactByRef = new Map(exact.map((result) => [result.resultRef, result]));
  return {
    records: input.records.map((record) => {
      if (record.status === "started") return record;
      const result = exactByRef.get(record.resultRef!);
      return {
        ...record,
        result: result?.result,
        ...(result?.structuralFacts ? { structuralFacts: result.structuralFacts } : {}),
      };
    }),
    exactRead: true,
  };
}
