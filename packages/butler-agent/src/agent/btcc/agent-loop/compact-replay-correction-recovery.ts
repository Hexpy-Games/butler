import type {
  GuidedToolJournalRecord,
  SqliteGuidedToolJournal,
} from "../../adapters/index.ts";
import { READ_OPERATION_RESULTS_TOOL_NAME } from
  "../../tools/m1-compact-replay.ts";
import {
  durableWorkReviewRevisionId,
  type DurableWorkView,
} from "../work/index.ts";
import {
  compactReplayExactReadIdentity,
  type BtccCompactReplayExactReadIdentity,
} from "./compact-replay-work-state.ts";

const CORRECTION_POINTER = "/request/corrections" as const;
const CORRECTION_RECOVERY_REQUIRED =
  "guided_work_review_correction_recovery_required";
const CORRECTION_IDENTITY_UNAVAILABLE =
  "guided_work_review_correction_identity_unavailable";

export type BtccCompactReplayCorrectionRecovery = {
  operation: "read_operation_results";
  review_revision: number;
  identity: BtccCompactReplayExactReadIdentity;
  selector: {
    kind: "json_pointer";
    pointer: "/request/corrections";
  };
};

/** Rejects a result Review mutation until its exact predecessor was selected. */
export function rejectUnrecoveredCompactReplayWorkReview(input: {
  work: DurableWorkView;
  toolJournal: SqliteGuidedToolJournal;
  turnId: string;
  args: Record<string, unknown>;
}): Record<string, unknown> | null {
  if (input.args.subject !== "result") return null;
  const review = input.work.latestResultReview;
  if (review?.verdict !== "revise" || review.corrections.length === 0) {
    return null;
  }
  const reviewRecord = input.toolJournal
    .listForCompactReplay(review.originTurnId)
    .find((record) =>
      record.toolName === "record_work_review" &&
      record.status === "completed" &&
      durableWorkReviewRevisionId(record.callId) === review.reviewRevisionId,
    );
  const identity = reviewRecord
    ? compactReplayExactReadIdentity(reviewRecord)
    : null;
  if (identity && input.toolJournal.listForCompactReplay(input.turnId)
    .some((record) => successfulCorrectionRead(record, identity.result_ref))) {
    return null;
  }
  return {
    ok: false,
    observation_kind: "operation_rejected",
    error: {
      code: identity
        ? CORRECTION_RECOVERY_REQUIRED
        : CORRECTION_IDENTITY_UNAVAILABLE,
    },
    ...(identity
      ? { recovery: correctionRecovery(review.revision, identity) }
      : {
          recovery: {
            operation: READ_OPERATION_RESULTS_TOOL_NAME,
            review_revision: review.revision,
            selector: { kind: "json_pointer", pointer: CORRECTION_POINTER },
          },
        }),
  };
}

export function isSuccessfulGuidedReferenceRead(value: unknown): boolean {
  const record = asRecord(value);
  return record?.ok === true && record.reference_only === true &&
    Number.isSafeInteger(record.read_count) && Number(record.read_count) > 0 &&
    Array.isArray(record.result_refs) &&
    record.result_refs.length === Number(record.read_count) &&
    record.result_refs.every((ref) => typeof ref === "string" && ref.length > 0);
}

export function readCompactReplayCorrectionRejection(
  value: Record<string, unknown> | null,
): { code: string; recovery: BtccCompactReplayCorrectionRecovery | null } | null {
  if (value?.ok !== false || value.observation_kind !== "operation_rejected") {
    return null;
  }
  const code = asRecord(value.error)?.code;
  if (code !== CORRECTION_RECOVERY_REQUIRED &&
    code !== CORRECTION_IDENTITY_UNAVAILABLE) return null;
  const recovery = asRecord(value.recovery);
  const identity = asRecord(recovery?.identity);
  return {
    code,
    recovery: recovery?.operation === READ_OPERATION_RESULTS_TOOL_NAME &&
        Number.isSafeInteger(recovery.review_revision) &&
        identity?.kind === "direct" &&
        typeof identity.result_ref === "string" &&
        identity.revision === null &&
        (identity.result_sha256 === null ||
          typeof identity.result_sha256 === "string") &&
        asRecord(recovery.selector)?.kind === "json_pointer" &&
        asRecord(recovery.selector)?.pointer === CORRECTION_POINTER
      ? recovery as BtccCompactReplayCorrectionRecovery
      : null,
  };
}

function successfulCorrectionRead(
  record: GuidedToolJournalRecord,
  resultRef: string,
): boolean {
  if (record.toolName !== READ_OPERATION_RESULTS_TOOL_NAME ||
    record.status !== "completed" ||
    !isSuccessfulGuidedReferenceRead(record.result)) return false;
  const successfulResultRefs = asRecord(record.result)?.result_refs;
  if (!Array.isArray(successfulResultRefs) ||
    !successfulResultRefs.includes(resultRef)) return false;
  const reads = Array.isArray(record.arguments.reads)
    ? record.arguments.reads
    : [];
  return reads.some((value) => {
    const read = asRecord(value);
    const selector = asRecord(read?.selector);
    return read?.result_ref === resultRef &&
      selector?.kind === "json_pointer" &&
      selector.pointer === CORRECTION_POINTER;
  });
}

function correctionRecovery(
  reviewRevision: number,
  identity: BtccCompactReplayExactReadIdentity,
): BtccCompactReplayCorrectionRecovery {
  return {
    operation: READ_OPERATION_RESULTS_TOOL_NAME,
    review_revision: reviewRevision,
    identity,
    selector: { kind: "json_pointer", pointer: CORRECTION_POINTER },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
