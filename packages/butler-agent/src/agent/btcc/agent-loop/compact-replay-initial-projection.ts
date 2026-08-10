import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import {
  durableWorkReviewRevisionId,
  isDurableWorkTool,
  type DurableWorkContext,
  type DurableWorkReview,
} from "../work/index.ts";
import type {
  BtccCompactReplayIdentity,
  BtccCompactReplayInitialProjection,
} from "./compact-replay-messages.ts";
import {
  compactReplayExactReadIdentity,
  projectCompactReplayWorkState,
  type BtccCompactReplayWorkRecoverySources,
} from
  "./compact-replay-work-state.ts";
import type { GuidedToolContextReplayProjection } from
  "./guided-tool-replay-projection.ts";
import { guidedOperationStructuralFacts } from
  "./guided-tool-context-projection.ts";

export function createCompactReplayInitialProjection(input: {
  toolResults: GuidedToolContextReplayProjection;
  workResults: GuidedToolContextReplayProjection | null;
  selectedViews: BtccCompactReplayInitialProjection["selectedViews"];
  work: DurableWorkContext | null;
  records: readonly GuidedToolJournalRecord[];
  turnId: string;
}): BtccCompactReplayInitialProjection {
  const projections = [input.toolResults, input.workResults]
    .filter((value): value is GuidedToolContextReplayProjection => Boolean(value));
  const newest = projections.flatMap((projection) => projection.newest);
  return {
    workState: input.work
      ? projectCompactReplayWorkState(
          input.work.work,
          workRecoverySources(input.work, input.records, input.turnId),
        )
      : null,
    workControlReceipt: latestWorkControlReceipt(input.records),
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

function workRecoverySources(
  context: DurableWorkContext,
  records: readonly GuidedToolJournalRecord[],
  turnId: string,
): BtccCompactReplayWorkRecoverySources {
  const latestReview = [
    context.work.latestPlanReview,
    context.work.latestResultReview,
    context.work.latestCompletionValidation,
  ].filter((review): review is DurableWorkReview => Boolean(review))
    .sort((left, right) => left.revision - right.revision)
    .at(-1);
  const actionRecord = latestRecordByBatchOrdinal(records, (record) =>
    isDurableWorkTool(record.toolName) && record.status !== "started");
  const reviewRecord = latestReview?.originTurnId === turnId &&
      latestReview.corrections.length > 0
    ? records.find((record) =>
        record.toolName === "record_work_review" &&
        record.status !== "started" &&
        guidedOperationStructuralFacts(record).outcome === "succeeded" &&
        durableWorkReviewRevisionId(record.callId) ===
          latestReview.reviewRevisionId,
      ) ?? null
    : null;
  const actionStates = actionRecord
    ? compactReplayExactReadIdentity(actionRecord)
    : null;
  const reviewCorrection = reviewRecord
    ? compactReplayExactReadIdentity(reviewRecord)
    : null;
  return {
    ...(actionStates ? { actionStates } : {}),
    ...(reviewCorrection ? { reviewCorrection } : {}),
  };
}

function latestWorkControlReceipt(
  records: readonly GuidedToolJournalRecord[],
): BtccCompactReplayInitialProjection["workControlReceipt"] {
  const record = latestRecordByBatchOrdinal(records, (candidate) =>
    isDurableWorkTool(candidate.toolName) && candidate.status !== "started");
  if (!record || !isDurableWorkTool(record.toolName)) return null;
  return {
    operation: record.toolName,
    accepted: guidedOperationStructuralFacts(record).outcome === "succeeded",
    result_identity: compactReplayExactReadIdentity(record),
  };
}

function latestRecordByBatchOrdinal(
  records: readonly GuidedToolJournalRecord[],
  predicate: (record: GuidedToolJournalRecord) => boolean,
): GuidedToolJournalRecord | null {
  const candidates = records.filter(predicate);
  const latest = candidates.at(-1);
  if (!latest?.operationBatchId) return latest ?? null;
  return candidates.filter((record) =>
    record.operationBatchId === latest.operationBatchId)
    .sort((left, right) =>
      (left.operationBatchOrdinal ?? -1) -
        (right.operationBatchOrdinal ?? -1))
    .at(-1) ?? latest;
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
