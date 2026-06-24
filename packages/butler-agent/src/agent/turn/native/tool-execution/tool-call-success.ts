import { randomUUID } from "crypto";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../../../test-support/harness/transcripts.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import {
  satisfiedCompletionObligationsForToolResult,
} from "../../../tools/butler-tools.ts";
import {
  bridgeToolAuditEvent,
  redactedBridgeToolAuditArgs,
  redactedBridgeToolAuditResult,
  type BridgeToolAuditEvent,
} from "../../../tools/tool-bridge/audit.ts";
import { buildTaskOriginContext } from "../../../work/task-origin.ts";
import { TaskStore } from "../../../work/task-store.ts";
import { annotateToolResultWithDecisionContext, publicWorkDecisionPayload } from "../../../output/public-work/decisions.ts";
import { evidenceReceiptsFromResult } from "../../../output/evidence/receipts.ts";
import {
  evidenceTranscriptToolResultProjection,
} from "../../../output/evidence/transcript-result.ts";
import {
  buildIntermediateAction,
  emitDecisionProgressBestEffort,
  emitIntermediateBestEffort,
  emitTurnEventBestEffort,
} from "../progress/turn-delivery-events.ts";
import { completedToolProgressSummary } from "./completed-tool-progress.ts";
import { taskIdFromToolResult } from "../output/tool-result-text.ts";
import {
  withBridgeInvocationForAudit,
  type BridgedToolCallAuditContext,
} from "../../bridge-tool-executor.ts";
import type { InboundEnvelope } from "../../../../gateways/core/contracts.ts";
import type { NativeAuditedToolExecutorInput, NativeToolCall } from "./audited-executor-types.ts";
import type { PublicWorkDecision, ToolProgressSummary } from "../output/tool-types.ts";

export async function handleAuditedToolSuccess(input: {
  executorInput: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
  bridgedFrom?: BridgedToolCallAuditContext;
  result: unknown;
  startedAt: number;
  toolCallId: string;
  workBlockId: string;
  workBlockLabel: string;
  progress: ToolProgressSummary;
  decision: PublicWorkDecision;
  usesSemanticWorkBlock: boolean;
  semanticProgressEstablished: boolean;
  isWorkerStartTool: boolean;
  taskSummary: string;
  inboundEnvelope: InboundEnvelope | null;
  updateRuntimeSemanticProgress(input: {
    decision: PublicWorkDecision;
    progress: ToolProgressSummary;
    state: "review";
  }): Promise<void>;
}): Promise<unknown> {
  recordSuccessfulToolMetric(input);
  writeWorkerTaskOrigin(input);
  const bridgeAudit = bridgeAuditForSuccess(input);
  input.executorInput.audit.push({
    name: input.call.name,
    args: bridgeAudit && !input.bridgedFrom
      ? redactedBridgeToolAuditArgs(input.call.name, input.cleanArgs)
      : input.cleanArgs,
    ok: true,
    result: bridgeAudit && !input.bridgedFrom
      ? redactedBridgeToolAuditResult(input.call.name, input.result)
      : input.result,
    publicDecision: input.decision,
    satisfiedCompletionObligations: satisfiedCompletionObligationsForToolResult(input.call.name, input.result),
    evidenceReceipts: evidenceReceiptsFromResult(input.result),
    bridgeAudit: bridgeAudit ?? undefined,
  });

  const completedProgress = completedToolProgressSummary(input.progress, input.result);
  await emitCompletedToolProgress(input, completedProgress);
  if (input.executorInput.semanticProgressSafetyNet.source === "runtime" && !input.isWorkerStartTool) {
    await input.updateRuntimeSemanticProgress({
      decision: input.decision,
      progress: completedProgress,
      state: "review",
    });
  }
  if (!input.semanticProgressEstablished && !input.isWorkerStartTool) {
    await emitDecisionProgressBestEffort({
      turnInput: input.executorInput.turnInput,
      decision: input.decision,
      state: "delivered",
    });
  }
  if (!input.usesSemanticWorkBlock) {
    await emitTurnEventBestEffort(input.executorInput.turnInput, {
      kind: "work.block.completed",
      payload: {
        workBlockId: input.workBlockId,
        label: input.workBlockLabel,
        status: "completed",
        ...publicWorkDecisionPayload(input.decision),
        durationMs: Date.now() - input.startedAt,
      },
    });
  }
  appendSuccessTranscript(input, bridgeAudit);
  return annotateToolResultWithDecisionContext({
    result: input.result,
    decision: input.decision,
    decisions: input.executorInput.publicDecisionContext,
  });
}

function recordSuccessfulToolMetric(input: {
  executorInput: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  startedAt: number;
}): void {
  recordOperationalMetric({
    category: "tool",
    name: input.call.name,
    status: "ok",
    durationMs: Date.now() - input.startedAt,
    dimensions: {
      sessionRole: input.executorInput.turnInput.handle.role,
      toolName: input.call.name,
    },
  }, { butlerData: input.executorInput.butlerData });
}

function writeWorkerTaskOrigin(input: {
  executorInput: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
  result: unknown;
  isWorkerStartTool: boolean;
  taskSummary: string;
  inboundEnvelope: InboundEnvelope | null;
}): void {
  if (!input.isWorkerStartTool) return;
  const taskId = taskIdFromToolResult(input.result);
  const project = typeof input.cleanArgs.project_path === "string"
    ? input.cleanArgs.project_path.trim()
    : null;
  if (!taskId || !input.taskSummary) return;
  new TaskStore(input.executorInput.butlerData).writeOrigin(taskId, buildTaskOriginContext({
    sessionId: input.executorInput.sessionId,
    taskSummary: input.taskSummary,
    project,
    inbound: input.inboundEnvelope,
  }));
}

function bridgeAuditForSuccess(input: {
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
  bridgedFrom?: BridgedToolCallAuditContext;
  result: unknown;
}): BridgeToolAuditEvent | null {
  const bridgeAuditName = input.bridgedFrom ? "tool_call" : input.call.name;
  const bridgeAuditArgs = input.bridgedFrom?.args ?? input.cleanArgs;
  const bridgeAuditResult = input.bridgedFrom
    ? withBridgeInvocationForAudit(input.result, input.bridgedFrom.invocation)
    : input.result;
  return bridgeToolAuditEvent(bridgeAuditName, bridgeAuditArgs, bridgeAuditResult);
}

async function emitCompletedToolProgress(
  input: {
    executorInput: NativeAuditedToolExecutorInput;
    call: NativeToolCall;
    startedAt: number;
    toolCallId: string;
    workBlockId: string;
    workBlockLabel: string;
    progress: ToolProgressSummary;
    decision: PublicWorkDecision;
    inboundEnvelope: InboundEnvelope | null;
  },
  completedProgress: ToolProgressSummary,
): Promise<void> {
  await emitTurnEventBestEffort(input.executorInput.turnInput, {
    kind: "tool.completed",
    payload: {
      toolCallId: input.toolCallId,
      workBlockId: input.workBlockId,
      workBlockLabel: input.workBlockLabel,
      activityKind: completedProgress.kind,
      toolName: completedProgress.toolName,
      inputLabel: completedProgress.inputLabel,
      safeLabel: completedProgress.safeLabel,
      ...publicWorkDecisionPayload(input.decision),
      detailRows: completedProgress.detailRows,
      durationMs: Date.now() - input.startedAt,
    },
  });
  if (
    input.inboundEnvelope &&
    input.executorInput.turnInput.emitIntermediateDelivery &&
    completedProgress !== input.progress
  ) {
    await emitIntermediateBestEffort(
      input.executorInput.turnInput,
      buildIntermediateAction({
        envelope: input.inboundEnvelope,
        suffix: `${input.call.name}-${randomUUID().slice(0, 8)}-completed-progress`,
        text: "",
        metadata: {
          kind: "tool_progress",
          activityKind: completedProgress.kind,
          toolCallId: input.toolCallId,
          toolName: completedProgress.toolName,
          safeLabel: completedProgress.safeLabel,
          inputLabel: completedProgress.inputLabel,
          workBlockId: input.workBlockId,
          workBlockLabel: input.workBlockLabel,
          ...publicWorkDecisionPayload(input.decision),
          detailRows: completedProgress.detailRows,
          state: "delivered",
        },
      }),
      {
        source: "runtime/native-tool-loop.ts#tool-progress",
        kind: "tool_progress",
        tool: input.call.name,
      },
    );
  }
}

function appendSuccessTranscript(
  input: {
    executorInput: NativeAuditedToolExecutorInput;
    call: NativeToolCall;
    result: unknown;
    decision: PublicWorkDecision;
  },
  bridgeAudit: BridgeToolAuditEvent | null,
): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.executorInput.sessionId,
    kind: "tool_result",
    payload: {
      name: input.call.name,
      ok: true,
      result: evidenceTranscriptToolResultProjection(input.result),
      publicDecision: publicWorkDecisionPayload(input.decision),
    },
    metadata: {
      source: "runtime/native-tool-loop.ts",
      bridge_audit: bridgeAudit ?? undefined,
    },
  }));
}
