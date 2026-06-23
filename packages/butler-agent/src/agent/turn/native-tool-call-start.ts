import { randomUUID } from "crypto";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../test-support/harness/transcripts.ts";
import {
  publicWorkDecisionPayload,
} from "../output/public-work-decisions.ts";
import {
  evidenceTranscriptToolCallArgumentsProjection,
} from "../output/evidence-transcript-result.ts";
import {
  buildIntermediateAction,
  emitDecisionProgressBestEffort,
  emitIntermediateBestEffort,
  emitTurnEventBestEffort,
} from "./native-turn-delivery-events.ts";
import type {
  NativeAuditedToolExecutorInput,
  NativeToolCall,
} from "./native-audited-executor-types.ts";
import type { PublicWorkDecision, ToolProgressSummary } from "./native-tool-types.ts";

export function appendPublicDecisionTranscript(
  input: NativeAuditedToolExecutorInput,
  decision: PublicWorkDecision,
): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.sessionId,
    kind: "system",
    payload: {
      category: "public_work_decision",
      decision: publicWorkDecisionPayload(decision),
    },
    metadata: {
      source: "runtime/native-tool-loop.ts",
    },
  }));
}

export async function emitStartedProgress(input: {
  input: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
  progress: ToolProgressSummary;
  decision: PublicWorkDecision;
  toolCallId: string;
  workBlockId: string;
  workBlockLabel: string;
  isWorkerStartTool: boolean;
  semanticProgressEstablished: boolean;
}): Promise<void> {
  if (!input.semanticProgressEstablished && !input.isWorkerStartTool) {
    await emitDecisionProgressBestEffort({
      turnInput: input.input.turnInput,
      decision: input.decision,
      state: "running",
    });
  }
  await emitTurnEventBestEffort(input.input.turnInput, {
    kind: "work.block.started",
    payload: {
      workBlockId: input.workBlockId,
      label: input.workBlockLabel,
      activityKind: input.progress.kind,
      ...publicWorkDecisionPayload(input.decision),
    },
  });
  await emitTurnEventBestEffort(input.input.turnInput, {
    kind: "tool.started",
    payload: {
      toolCallId: input.toolCallId,
      workBlockId: input.workBlockId,
      workBlockLabel: input.workBlockLabel,
      activityKind: input.progress.kind,
      toolName: input.progress.toolName,
      inputLabel: input.progress.inputLabel,
      safeLabel: input.progress.safeLabel,
      ...publicWorkDecisionPayload(input.decision),
      detailRows: input.progress.detailRows,
    },
  });
  await emitStartedIntermediateProgress(input);
  appendToolCallTranscript(input);
}

export function taskSummaryForTool(
  toolName: string,
  cleanArgs: Record<string, unknown>,
): string {
  if (typeof cleanArgs.task === "string" && cleanArgs.task.trim()) {
    return cleanArgs.task.trim();
  }
  return toolName === "resume_worker"
    ? "Continue the most recent recoverable background task."
    : "";
}

async function emitStartedIntermediateProgress(input: {
  input: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  progress: ToolProgressSummary;
  decision: PublicWorkDecision;
  toolCallId: string;
  workBlockId: string;
  workBlockLabel: string;
}): Promise<void> {
  const inboundEnvelope = "eventId" in input.input.turnInput.input
    ? input.input.turnInput.input
    : null;
  if (!inboundEnvelope || !input.input.turnInput.emitIntermediateDelivery) return;
  await emitIntermediateBestEffort(
    input.input.turnInput,
    buildIntermediateAction({
      envelope: inboundEnvelope,
      suffix: `${input.call.name}-${randomUUID().slice(0, 8)}-progress`,
      text: "",
      metadata: {
        kind: "tool_progress",
        activityKind: input.progress.kind,
        toolCallId: input.toolCallId,
        toolName: input.progress.toolName,
        safeLabel: input.progress.safeLabel,
        inputLabel: input.progress.inputLabel,
        workBlockId: input.workBlockId,
        workBlockLabel: input.workBlockLabel,
        ...publicWorkDecisionPayload(input.decision),
        detailRows: input.progress.detailRows,
      },
    }),
    {
      source: "runtime/native-tool-loop.ts#tool-progress",
      kind: "tool_progress",
      tool: input.call.name,
    },
  );
}

function appendToolCallTranscript(input: {
  input: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
}): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.input.sessionId,
    kind: "tool_call",
    payload: {
      name: input.call.name,
      arguments: evidenceTranscriptToolCallArgumentsProjection(input.cleanArgs),
    },
    metadata: {
      source: "runtime/native-tool-loop.ts",
    },
  }));
}
