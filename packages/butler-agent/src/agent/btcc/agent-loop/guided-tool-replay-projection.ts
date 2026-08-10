import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import { digest, stableJson } from "../identity/index.ts";
import {
  fitGuidedToolContextRecord,
  guidedOperationStructuralFacts,
  projectGuidedToolContextRecord,
  type GuidedOperationStructuralFacts,
} from "./guided-tool-context-projection.ts";

export type GuidedToolContextReplayIdentity = {
  kind: "work" | "direct";
  result_ref: string;
  work_id?: string;
  revision: number | null;
  tool_name: string;
  status: GuidedToolJournalRecord["status"];
  result_sha256: string | null;
} & GuidedOperationStructuralFacts;

export type GuidedToolContextReplayProjection = {
  newest: Array<Record<string, unknown>>;
  older: GuidedToolContextReplayIdentity[];
  projectionRevision: string;
  projectionCount: number;
  anchorCount: number;
  replayCount: number;
};

/** Keeps open call/result groups whole and reduces only completed older rows. */
export function projectGuidedToolContextForReplay(
  records: readonly GuidedToolJournalRecord[],
  options: {
    maxRecordBytes: number;
    maxTotalBytes: number;
    sequenceByResultRef?: ReadonlyMap<string, number>;
    workId?: string;
    newestBatchId?: string;
  },
): GuidedToolContextReplayProjection {
  const maxRecordBytes = requiredPositive(options.maxRecordBytes);
  const maxTotalBytes = requiredPositive(options.maxTotalBytes);
  const open = records.filter((record) => record.status === "started");
  const completed = records.filter((record) => record.status !== "started");
  const inferredNewestBatchId = options.newestBatchId ??
    completed.findLast((record) => record.operationBatchId)?.operationBatchId;
  const newestCompleted = inferredNewestBatchId
    ? completed.filter((record) =>
        record.operationBatchId === inferredNewestBatchId)
    : [];
  const selected = [
    ...dedupeRecords(open)
      .sort((left, right) => records.indexOf(right) - records.indexOf(left)),
    ...dedupeRecords(newestCompleted)
      .sort((left, right) => records.indexOf(right) - records.indexOf(left)),
  ];
  const newestProjection = projectNewest(
    selected,
    maxRecordBytes,
    maxTotalBytes,
    {
      sequenceByResultRef: options.sequenceByResultRef,
      workId: options.workId,
    },
  );
  const newest = newestProjection.records;
  const selectedRefs = newestProjection.includedRefs;
  const older = records.flatMap((record) => {
    if (!record.resultRef || selectedRefs.has(record.resultRef)) return [];
    return [{
      kind: options.workId ? "work" as const : "direct" as const,
      result_ref: record.resultRef,
      ...(options.workId ? { work_id: options.workId } : {}),
      revision: options.workId
        ? options.sequenceByResultRef?.get(record.resultRef) ?? null
        : null,
      tool_name: record.toolName,
      status: record.status,
      result_sha256: record.resultSha256 ?? null,
      ...guidedOperationStructuralFacts(record),
    }];
  });
  return {
    newest,
    older,
    projectionRevision: digest(stableJson({
      newest: newest.map((record) => ({
        resultRef: record.result_ref ?? null,
        status: record.status ?? null,
        resultSha256: record.result_sha256 ?? null,
      })),
      older,
    })),
    projectionCount: newest.length,
    anchorCount: open.length + older.length,
    replayCount: 0,
  };
}

function projectNewest(
  records: readonly GuidedToolJournalRecord[],
  maxRecordBytes: number,
  maxTotalBytes: number,
  options: {
    sequenceByResultRef?: ReadonlyMap<string, number>;
    workId?: string;
  },
): {
  records: Array<Record<string, unknown>>;
  includedRefs: Set<string>;
} {
  const newest: Array<Record<string, unknown>> = [];
  const includedRefs = new Set<string>();
  let totalBytes = 2;
  for (const record of records) {
    const separatorBytes = newest.length > 0 ? 1 : 0;
    const available = Math.min(
      maxRecordBytes,
      maxTotalBytes - totalBytes - separatorBytes,
    );
    const value = compact({
      ...projectGuidedToolContextRecord(record),
      kind: options.workId ? "work" : "direct",
      result_ref: record.resultRef,
      ...(options.workId ? { work_id: options.workId } : {}),
      revision: options.workId && record.resultRef
        ? options.sequenceByResultRef?.get(record.resultRef) ?? null
        : null,
    });
    const bounded = available > 0
      ? fitGuidedToolContextRecord(value, available)
      : null;
    if (!bounded) {
      if (record.status === "started") {
        newest.push(identityFallback(record));
        if (record.resultRef) includedRefs.add(record.resultRef);
      }
      continue;
    }
    newest.push(bounded.value);
    if (record.resultRef) includedRefs.add(record.resultRef);
    totalBytes += separatorBytes + bounded.bytes;
  }
  return { records: newest, includedRefs };
}

function dedupeRecords(
  records: readonly GuidedToolJournalRecord[],
): GuidedToolJournalRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = record.resultRef ?? record.callId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function identityFallback(
  record: GuidedToolJournalRecord,
): Record<string, unknown> {
  return compact({
    tool_name: record.toolName,
    status: record.status,
    result_ref: record.resultRef,
    result_sha256: record.resultSha256,
    ...guidedOperationStructuralFacts(record),
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
}

function requiredPositive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("compact_replay_budget_invalid");
  }
  return Math.trunc(value);
}
