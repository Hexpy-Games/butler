import { Buffer } from "node:buffer";
import { digest, stableJson } from "../identity/index.ts";
import type {
  ModelRoundMessage,
  ModelRoundResult,
  OperationResultReferenceCarrier,
} from "../ports/model-round.ts";
import { OPERATION_RESULT_EXACT_READ_MAX_BYTES } from
  "../../tools/monitoring/read_operation_results/index.ts";
import type {
  GuidedOperationResultReader,
  GuidedToolJournal,
  GuidedToolJournalRecord,
} from "../ports/guided-tool-journal.ts";

export const OPERATION_RESULT_REFERENCE_SCHEMA =
  "butler.operation-result-reference.v1" as const;
export const OPERATION_RESULT_REPLAY_MIN_BYTES = 8 * 1024;
const TRUE_FLAG_VALUES = new Set(["1", "true", "on", "yes"]);

export function operationResultReplayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUE_FLAG_VALUES.has(
    (env.BUTLER_M1_V2_EXACT_ONCE_REPLAY ?? "").trim().toLowerCase(),
  );
}

export type OperationResultReference = OperationResultReferenceCarrier;

export type OperationResultReplay = {
  prepareMessages(messages: readonly ModelRoundMessage[], roundId: string): ModelRoundMessage[];
  accepted(roundId: string, response: ModelRoundResult): void;
  failed(roundId: string): void;
  referenceFor(record: GuidedToolJournalRecord): OperationResultReference;
  readExact(input: ExactReadArguments): unknown;
};

export function createOperationResultReplay(input: {
  turnId: string;
  turnRevision: number;
  journal: GuidedToolJournal;
  exactReader: GuidedOperationResultReader;
  exactReadCapability: boolean;
  sessionId?: string;
  projectRef?: string;
}): OperationResultReplay {
  assertReplayDependencies(input.journal, input.exactReader);
  const referenceFor = (record: GuidedToolJournalRecord): OperationResultReference => {
    if (!record.resultSha256 || record.result === undefined) {
      throw new Error("operation_result_reference_unavailable");
    }
    const identity = input.exactReader.resolveResultReference({
      turnId: input.turnId, callId: record.callId,
    });
    return {
      version: OPERATION_RESULT_REFERENCE_SCHEMA,
      kind: "operation_result",
      identity: {
        kind: identity.kind,
        result_ref: boundedIdentifier(identity.resultRef, "operation_result_reference_invalid"),
        tool_name: boundedIdentifier(record.toolName, "operation_result_tool_name_invalid"),
        ...(identity.workId
          ? { work_id: boundedIdentifier(identity.workId, "operation_result_work_id_invalid") }
          : {}),
      },
      integrity: { sha256: record.resultSha256, revision: identity.revision },
      outcome: {
        status: "completed",
        success: resultSucceeded(record.result),
        verification: "stored_exact_available",
        ...(boundedErrorCode(record.errorCode)
          ? { error_code: boundedErrorCode(record.errorCode)! }
          : {}),
      },
      availability: {
        status: input.exactReadCapability ? "exact_read_available" : "reference_only",
        capability: "read_operation_results",
        scope: identity.kind === "work" ? "work_scope" : "same_turn",
      },
    };
  };

  return {
    prepareMessages(messages, roundId) {
      return messages.map((message) => {
        if (message.role !== "tool" || !message.toolCallId) return message;
        let record = input.journal.findForTurn(
          input.turnId,
          message.operationResultCallId ?? message.toolCallId,
        );
        if (!record || !isReplayableLargeResult(record)) return message;
        if (!record.deliveryState) {
          input.journal.admitResultDelivery({
            turnId: input.turnId,
            callId: record.callId,
          });
          record = input.journal.findForTurn(input.turnId, record.callId)!;
        }
        if (record.deliveryState === "pending_delivery") {
          input.journal.beginResultDelivery({
            turnId: input.turnId,
            callId: record.callId,
            roundId,
          });
          return message;
        }
        if (record.deliveryState === "in_flight") {
          if (record.deliveryRoundId !== roundId) {
            throw new Error("operation_result_delivery_in_flight_mismatch");
          }
          return message;
        }
        if (record.deliveryState === "acknowledged") {
          input.journal.promoteAcknowledgedResult({
            turnId: input.turnId,
            callId: record.callId,
          });
        }
        const reference = referenceFor(record);
        return {
          ...message,
          content: stableJson(reference),
          imageAttachments: undefined,
          requestSegmentKind: "older_tool_result_projection",
          operationResultReference: reference,
        };
      });
    },
    accepted(roundId, response) {
      if (response.acceptedCheckpoint?.roundId !== roundId) {
        throw new Error("operation_result_route_acceptance_missing");
      }
      input.journal.acknowledgeResultDeliveries({
        turnId: input.turnId,
        roundId,
        responseSha256: digest(stableJson({
          text: response.text ?? "",
          calls: response.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            rawArguments: call.rawArguments,
          })),
        })),
      });
    },
    failed(roundId) {
      input.journal.releaseResultDeliveries({ turnId: input.turnId, roundId });
    },
    referenceFor,
    readExact(read) {
      if (!input.exactReadCapability) {
        throw new Error("operation_result_exact_read_unavailable");
      }
      const direct = input.journal.findForTurn(input.turnId, read.result_ref);
      if (direct && read.revision !== null) {
        throw new Error("operation_result_revision_mismatch");
      }
      return input.exactReader.readExactResultRange({
        turnId: input.turnId, resultRef: read.result_ref,
        resultSha256: read.sha256,
        revision: direct ? null : read.revision,
        sessionId: input.sessionId, projectRef: input.projectRef,
        workId: read.work_id ?? undefined, offset: read.offset, length: read.length,
      });
    },
  };
}

function assertReplayDependencies(
  journal: GuidedToolJournal,
  exactReader: GuidedOperationResultReader,
): void {
  const required = [
    "findForTurn", "admitResultDelivery", "beginResultDelivery",
    "releaseResultDeliveries", "acknowledgeResultDeliveries",
    "promoteAcknowledgedResult",
  ] as const;
  if (required.some((name) => typeof journal[name] !== "function") ||
    typeof exactReader.resolveResultReference !== "function" ||
    typeof exactReader.readExactResultRange !== "function") {
    throw new Error("operation_result_replay_dependency_missing");
  }
}

export type ExactReadArguments = {
  result_ref: string;
  sha256: string;
  revision: number | null;
  work_id: string | null;
  offset: number;
  length: number;
};

export function exactReadArguments(value: Record<string, unknown>): ExactReadArguments {
  const result_ref = typeof value.result_ref === "string" ? value.result_ref.trim() : "";
  const sha256 = typeof value.sha256 === "string" ? value.sha256.trim() : "";
  const revision = value.revision ?? null;
  const work_id = value.work_id ?? null;
  const offset = value.offset;
  const length = value.length;
  if (!result_ref || result_ref.length > 256) throw new Error("operation_result_reference_invalid");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("operation_result_hash_invalid");
  if (revision !== null && (!Number.isSafeInteger(revision) || (revision as number) < 0)) {
    throw new Error("operation_result_revision_invalid");
  }
  if (work_id !== null && (typeof work_id !== "string" || !work_id.trim() || work_id.length > 256)) {
    throw new Error("operation_result_work_id_invalid");
  }
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    throw new Error("operation_result_offset_invalid");
  }
  if (!Number.isSafeInteger(length) || (length as number) < 1 ||
    (length as number) > OPERATION_RESULT_EXACT_READ_MAX_BYTES) {
    throw new Error("operation_result_length_invalid");
  }
  return {
    result_ref, sha256, revision: revision as number | null,
    work_id: typeof work_id === "string" ? work_id.trim() : null,
    offset: offset as number, length: length as number,
  };
}

function boundedIdentifier(value: string, code: string): string {
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 256) throw new Error(code);
  return trimmed;
}

function boundedErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 64);
  return normalized || undefined;
}

function resultSucceeded(value: unknown): boolean {
  return !(value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).ok === false);
}

function isReplayableLargeResult(record: GuidedToolJournalRecord): boolean {
  if (record.status !== "completed" || record.result === undefined || !record.resultSha256) {
    return false;
  }
  return Buffer.byteLength(stableJson(record.result), "utf8") >=
    OPERATION_RESULT_REPLAY_MIN_BYTES;
}
