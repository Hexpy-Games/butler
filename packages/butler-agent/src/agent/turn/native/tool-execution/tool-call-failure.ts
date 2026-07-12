import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../../../test-support/harness/transcripts.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import {
  bridgeToolAuditEvent,
  redactedBridgeToolAuditArgs,
} from "../../../tools/tool-bridge/audit.ts";
import { annotateToolResultWithDecisionContext, publicWorkDecisionPayload } from "../../../output/public-work/decisions.ts";
import {
  evidenceTranscriptErrorMessage,
} from "../../../output/evidence/transcript-result.ts";
import {
  evidenceCapabilityReceiptsFromResult,
  evidenceReceiptsFromResult,
} from "../../../output/evidence/receipts.ts";
import {
  ToolObservationError,
  toolObservationForFailure,
  toolObservationResult,
} from "./tool-observations.ts";
import {
  emitDecisionProgressBestEffort,
  emitTurnEventBestEffort,
} from "../progress/turn-delivery-events.ts";
import type { BridgedToolCallAuditContext } from "../../bridge-tool-executor.ts";
import type {
  NativeAuditedToolExecutorInput,
  NativeToolCall,
} from "./audited-executor-types.ts";
import type { PublicWorkDecision, ToolProgressSummary } from "../output/tool-types.ts";
import { markWorkBlockTerminal } from "../progress/work-block-lifecycle.ts";

export async function handleAuditedToolFailure(input: {
  executorInput: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
  bridgedFrom?: BridgedToolCallAuditContext;
  error: unknown;
  startedAt: number;
  toolCallId: string;
  workBlockId: string;
  workBlockLabel: string;
  progress: ToolProgressSummary;
  decision: PublicWorkDecision;
  usesSemanticWorkBlock: boolean;
  semanticProgressEstablished: boolean;
  isWorkerStartTool: boolean;
}): Promise<unknown> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const observation = toolObservationForFailure({
    turnId: input.executorInput.turnId,
    call: input.call,
    error: input.error,
    toolCallId: input.toolCallId,
  });
  recordOperationalMetric({
    category: "tool",
    name: input.call.name,
    status: "error",
    durationMs: Date.now() - input.startedAt,
    dimensions: {
      sessionRole: input.executorInput.turnInput.handle.role,
      toolName: input.call.name,
      errorName: input.error instanceof Error ? input.error.name : "UnknownError",
    },
  }, { butlerData: input.executorInput.butlerData });
  const bridgeAudit = input.bridgedFrom
    ? bridgeToolAuditEvent("tool_call", input.bridgedFrom.args, {
      ok: false,
      error: {
        code: "underlying_tool_error",
        recoverable: false,
      },
      bridge_invocation: input.bridgedFrom.invocation,
    })
    : bridgeToolAuditEvent(input.call.name, input.cleanArgs, {
      ok: false,
      error: {
        code: "underlying_tool_error",
        recoverable: false,
      },
    });
  input.executorInput.audit.push({
    name: input.call.name,
    args: bridgeAudit && !input.bridgedFrom
      ? redactedBridgeToolAuditArgs(input.call.name, input.cleanArgs)
      : input.cleanArgs,
    ok: false,
    error: message,
    observation,
    publicDecision: input.decision,
    evidenceReceipts: evidenceReceiptsFromFailure(input.error),
    evidenceCapabilityReceipts: evidenceCapabilityReceiptsFromFailure(input.error),
    bridgeAudit: bridgeAudit ?? undefined,
  });
  await emitTurnEventBestEffort(input.executorInput.turnInput, {
    kind: "tool.failed",
    payload: {
      toolCallId: input.toolCallId,
      workBlockId: input.workBlockId,
      workBlockLabel: input.workBlockLabel,
      activityKind: input.progress.kind,
      toolName: input.progress.toolName,
      inputLabel: input.progress.inputLabel,
      safeLabel: input.progress.safeLabel,
      ...publicWorkDecisionPayload(input.decision),
      durationMs: Date.now() - input.startedAt,
    },
  });
  await emitTurnEventBestEffort(input.executorInput.turnInput, {
    kind: "tool_result.failed",
    visibility: "internal",
    payload: {
      toolCallId: input.toolCallId,
      toolName: input.call.name,
      inputLabel: input.progress.inputLabel,
      safeLabel: input.progress.safeLabel,
      workBlockId: input.workBlockId,
      workBlockLabel: input.workBlockLabel,
      ok: false,
      safeError: evidenceTranscriptErrorMessage(message),
      safeObservation: observation,
    },
  });
  if (
    !input.semanticProgressEstablished &&
    !input.isWorkerStartTool &&
    input.decision.source !== "runtime-derived" &&
    isLastDecisionTool(input.decision)
  ) {
    await emitDecisionProgressBestEffort({
      turnInput: input.executorInput.turnInput,
      decision: input.decision,
      state: "failed",
    });
  }
  if (isLastDecisionTool(input.decision)) {
    await emitTurnEventBestEffort(input.executorInput.turnInput, {
      kind: "work.block.completed",
      payload: {
        workBlockId: input.workBlockId,
        label: input.workBlockLabel,
        status: "failed",
        ...publicWorkDecisionPayload(input.decision),
        durationMs: Date.now() - input.startedAt,
      },
    });
    markWorkBlockTerminal({
      decisions: input.executorInput.publicDecisionContext,
      workBlockId: input.workBlockId,
      status: "failed",
    });
  }
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.executorInput.sessionId,
    kind: "tool_result",
    payload: {
      name: input.call.name,
      ok: false,
      error: evidenceTranscriptErrorMessage(message),
      observation,
      publicDecision: publicWorkDecisionPayload(input.decision),
    },
    metadata: {
      source: "runtime/native-tool-loop.ts",
      bridge_audit: bridgeAudit ?? undefined,
    },
  }));
  if (
    input.executorInput.turnInput.signal?.aborted ||
    (input.error instanceof Error && input.error.name === "AbortError")
  ) {
    throw input.error;
  }
  return annotateToolResultWithDecisionContext({
    result: toolObservationResult(observation),
    decision: input.decision,
    decisions: input.executorInput.publicDecisionContext,
  });
}

function isLastDecisionTool(decision: PublicWorkDecision): boolean {
  const size = Math.max(1, decision.toolBatchSize ?? 1);
  return (decision.toolCallIndex ?? 0) >= size - 1;
}

function evidenceReceiptsFromFailure(error: unknown) {
  if (!(error instanceof ToolObservationError)) return [];
  return evidenceReceiptsFromResult(error.toolResult);
}

function evidenceCapabilityReceiptsFromFailure(error: unknown) {
  if (!(error instanceof ToolObservationError)) return [];
  return evidenceCapabilityReceiptsFromResult(error.toolResult);
}
