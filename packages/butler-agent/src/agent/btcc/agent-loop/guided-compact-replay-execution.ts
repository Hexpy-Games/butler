import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import {
  READ_OPERATION_RESULTS_TOOL_NAME,
  REPLACE_PHASE_CONTINUITY_TOOL_NAME,
} from "../../tools/m1-compact-replay.ts";
import { parseCompactReplayPhaseContinuity } from
  "../compact-replay/index.ts";
import { isDurableWorkTool } from "../work/index.ts";
import type {
  DurableWorkService,
  WorkTurnScope,
} from "../work/index.ts";
import type {
  BtccCompactReplayIdentity,
  BtccCompactReplayMetadata,
} from "./compact-replay-messages.ts";
import { executeCompactReplayControlTool } from
  "./guided-compact-replay-control.ts";
import type { GuidedCompactReplayRuntime } from
  "./guided-compact-replay-runtime.ts";
import { safeBoundWork } from "./guided-work-runtime.ts";
import { createBtccToolExecutionEnvelope } from "./tool-execution.ts";
import { guidedOperationStructuralFacts } from
  "./guided-tool-context-projection.ts";
import {
  compactReplayExactReadIdentity,
  projectCompactReplayWorkState,
} from
  "./compact-replay-work-state.ts";
import {
  isSuccessfulGuidedReferenceRead,
  readCompactReplayCorrectionRejection,
} from "./compact-replay-correction-recovery.ts";

type CompactReplayExecutionInput = {
  durableWork: DurableWorkService;
  toolJournal: SqliteGuidedToolJournal;
  workScope: WorkTurnScope;
  compactReplayRuntime: GuidedCompactReplayRuntime;
};

export async function rehydrateGuidedCompactReplayResult(
  input: CompactReplayExecutionInput,
  toolName: string,
  record: NonNullable<ReturnType<SqliteGuidedToolJournal["find"]>>,
): Promise<unknown> {
  if (toolName !== READ_OPERATION_RESULTS_TOOL_NAME) return record.result;
  if (!isSuccessfulGuidedReferenceRead(record.result)) {
    return operationRejectedResult(errorCode(record.result));
  }
  const replay = await executeCompactReplayControlTool({
    name: toolName,
    args: record.arguments,
    durableWork: input.durableWork,
    toolJournal: input.toolJournal,
    workScope: input.workScope,
    runtime: input.compactReplayRuntime,
    replayed: true,
  });
  if (!replay.handled) throw new Error("compact_replay_read_rehydrate_failed");
  return replay.result;
}

export function journalGuidedCompactReplayResult(
  toolName: string,
  result: unknown,
): unknown {
  if (toolName !== READ_OPERATION_RESULTS_TOOL_NAME) return result;
  const value = asRecord(result);
  const reads = Array.isArray(value?.results) ? value.results : [];
  return {
    ok: value?.ok === true,
    reference_only: true,
    read_count: reads.length,
    result_refs: reads.flatMap((item) => {
      const identity = asRecord(asRecord(item)?.identity);
      return typeof identity?.result_ref === "string"
        ? [identity.result_ref]
        : [];
    }),
  };
}

export function journalGuidedCompactReplayFailure(
  toolName: string,
  error: unknown,
): unknown {
  if (toolName !== READ_OPERATION_RESULTS_TOOL_NAME) return undefined;
  return {
    ok: false,
    reference_only: true,
    read_count: 0,
    result_refs: [],
    error_code: boundedErrorCode(error),
  };
}

export function guidedCompactReplayFailureResult(
  toolName: string,
  error: unknown,
): unknown {
  return toolName === READ_OPERATION_RESULTS_TOOL_NAME
    ? operationRejectedResult(boundedErrorCode(error))
    : undefined;
}

export async function envelopeGuidedCompactReplayResult(
  input: CompactReplayExecutionInput,
  toolName: string,
  callId: string,
  result: unknown,
  replayed: boolean,
): Promise<unknown> {
  if (!input.compactReplayRuntime.enabled) return result;
  const metadata = await compactReplayMetadata(
    input,
    toolName,
    callId,
    result,
    replayed,
  );
  return metadata
    ? createBtccToolExecutionEnvelope(result, metadata)
    : result;
}

async function compactReplayMetadata(
  input: CompactReplayExecutionInput,
  toolName: string,
  callId: string,
  result: unknown,
  replayed: boolean,
): Promise<BtccCompactReplayMetadata | null> {
  const value = asRecord(result);
  if (toolName === REPLACE_PHASE_CONTINUITY_TOOL_NAME) {
    const continuity = successfulPhaseContinuity(value);
    return continuity ? { kind: "phase_continuity", value: continuity } : null;
  }
  if (toolName === READ_OPERATION_RESULTS_TOOL_NAME) {
    if (value?.ok !== true) {
      return {
        kind: "operation_rejected",
        code: nestedErrorCode(value) ?? "guided_result_read_rejected",
      };
    }
    const views = Array.isArray(value?.results)
      ? value.results.flatMap((item) => {
          const view = asRecord(item);
          const identity = asCompactReplayIdentity(view?.identity);
          return identity
            ? [{ identity, selector: view?.selector, view: view?.view }]
            : [];
        })
      : [];
    return { kind: "selected_views", views, replayed };
  }
  if (isDurableWorkTool(toolName)) {
    const correctionRejection = readCompactReplayCorrectionRejection(value);
    if (correctionRejection) {
      return {
        kind: "operation_rejected",
        code: correctionRejection.code,
        toolName,
        ...(correctionRejection.recovery
          ? { recovery: correctionRejection.recovery }
          : {}),
      };
    }
    const work = await safeBoundWork(input.durableWork, input.workScope.turnId);
    const record = input.toolJournal.find(callId);
    const resultIdentity = record
      ? compactReplayExactReadIdentity(record)
      : null;
    const accepted = value?.ok === true;
    return {
      kind: "work_state",
      receipt: {
        operation: toolName,
        accepted,
        result_identity: resultIdentity,
      },
      state: work
        ? projectCompactReplayWorkState(work, {
            ...(resultIdentity
              ? { actionStates: resultIdentity }
              : {}),
            ...(accepted && toolName === "record_work_review" && resultIdentity
              ? { reviewCorrection: resultIdentity }
              : {}),
          })
        : null,
    };
  }
  const record = input.toolJournal.find(callId);
  if (!record?.resultRef || record.status === "started") return null;
  const work = await safeBoundWork(input.durableWork, input.workScope.turnId);
  const workRef = work?.resultRefs.find((candidate) =>
    candidate.toolCallId === callId && candidate.resultRef === record.resultRef);
  const identity: BtccCompactReplayIdentity = workRef
    ? {
        kind: "work",
        result_ref: record.resultRef,
        work_id: work!.workId,
        revision: workRef.sequence ?? null,
        tool_name: record.toolName,
        status: record.status,
        result_sha256: record.resultSha256 ?? null,
        ...guidedOperationStructuralFacts(record),
      }
    : {
        kind: "direct",
        result_ref: record.resultRef,
        revision: null,
        tool_name: record.toolName,
        status: record.status,
        result_sha256: record.resultSha256 ?? null,
        ...guidedOperationStructuralFacts(record),
      };
  return { kind: "source", identity };
}

function successfulPhaseContinuity(
  result: Record<string, unknown> | null,
): ReturnType<typeof parseCompactReplayPhaseContinuity> | null {
  if (result?.ok !== true) return null;
  const value = asRecord(result.phase_continuity);
  if (!value) return null;
  try {
    return parseCompactReplayPhaseContinuity({
      objective_state: value.objectiveState,
      integrated_decisions: value.integratedDecisions,
      unresolved_questions: value.unresolvedQuestions,
      next_batch_purpose: value.nextBatchPurpose,
      public_activity: value.publicActivity,
    });
  } catch {
    return null;
  }
}

function nestedErrorCode(value: Record<string, unknown> | null): string | null {
  const code = asRecord(value?.error)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,120}$/u.test(code)
    ? code
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorCode(value: unknown): string {
  const code = asRecord(value)?.error_code;
  return typeof code === "string" ? code : "guided_result_read_rejected";
}

function boundedErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_]{1,120}$/u.test(message)
    ? message
    : "guided_result_read_rejected";
}

function operationRejectedResult(code: string): Record<string, unknown> {
  return {
    ok: false,
    observation_kind: "operation_rejected",
    error: {
      code,
      message: `read_operation_results rejected: ${code}`,
    },
  };
}

function asCompactReplayIdentity(
  value: unknown,
): BtccCompactReplayIdentity | null {
  const identity = asRecord(value);
  if (!identity || (identity.kind !== "work" && identity.kind !== "direct") ||
    typeof identity.result_ref !== "string" ||
    typeof identity.tool_name !== "string" ||
    !["completed", "failed", "cancelled"].includes(String(identity.status))) {
    return null;
  }
  return identity as BtccCompactReplayIdentity;
}
