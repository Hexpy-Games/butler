import { randomUUID } from "crypto";
import type {
  InboundEnvelope,
  OutboundAction,
  RuntimeTurnInput,
} from "../../test-support/harness/contracts.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../test-support/harness/transcripts.ts";
import type { FunctionToolPromptOptions } from "../../integrations/providers/provider.ts";
import {
  bridgeToolAuditEvent,
  redactedBridgeToolAuditArgs,
  redactedBridgeToolAuditResult,
} from "../tools/tool-bridge/audit.ts";
import { summarizeToolProgress } from "../output/tool-progress.ts";
import {
  evidenceTranscriptToolCallArgumentsProjection,
  evidenceTranscriptToolResultProjection,
} from "../output/evidence-transcript-result.ts";
import type { RuntimeMessageLanguage } from "../output/messages.ts";
import type { ToolAuditEntry } from "./native/output/tool-types.ts";

export type BridgeToolCall = Parameters<FunctionToolPromptOptions["executeTool"]>[0];

export type BridgedToolCallAuditContext = {
  args: Record<string, unknown>;
  invocation: Record<string, unknown>;
};

type BuildIntermediateAction = (input: {
  envelope: InboundEnvelope;
  suffix: string;
  text: string;
  metadata?: Record<string, unknown>;
}) => OutboundAction;

type EmitIntermediateBestEffort = (
  input: RuntimeTurnInput,
  action: OutboundAction,
  metadata: Record<string, unknown>,
) => Promise<void>;

type EmitTurnEventBestEffort = (
  input: RuntimeTurnInput,
  event: Parameters<NonNullable<RuntimeTurnInput["emitTurnEvent"]>>[0],
) => Promise<void>;

export function withBridgeInvocationForAudit(
  result: unknown,
  bridgeInvocation: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result as Record<string, unknown>,
      bridge_invocation: bridgeInvocation,
    };
  }
  return {
    ok: true,
    result,
    bridge_invocation: bridgeInvocation,
  };
}

export function createAuditedBridgeToolExecutor(input: {
  sessionId: string;
  audit: ToolAuditEntry[];
  turnInput: RuntimeTurnInput;
  messageLanguage: RuntimeMessageLanguage;
  executor: FunctionToolPromptOptions["executeTool"];
  buildIntermediateAction: BuildIntermediateAction;
  emitIntermediateBestEffort: EmitIntermediateBestEffort;
  emitTurnEventBestEffort: EmitTurnEventBestEffort;
  throwIfAborted: () => void;
  executeTarget: (
    call: BridgeToolCall,
    bridgedFrom?: BridgedToolCallAuditContext,
  ) => Promise<unknown>;
}): FunctionToolPromptOptions["executeTool"] {
  const executeWithBridge = async (
    call: BridgeToolCall,
    bridgedFrom?: BridgedToolCallAuditContext,
  ): Promise<unknown> => {
    input.throwIfAborted();
    if (call.name !== "tool_call" || call.args.__bridge_resolve_only === true) {
      return await input.executeTarget(call, bridgedFrom);
    }

    const finishBridgeProgress = await startBridgeToolCallProgress({ ...input, call });
    try {
      const resolved = await input.executor({
        ...call,
        args: { ...call.args, __bridge_resolve_only: true },
        rawArguments: JSON.stringify({ ...call.args, __bridge_resolve_only: true }),
      }) as {
        ok?: boolean;
        result?: unknown;
        targetCall?: BridgeToolCall;
        bridgeInvocation?: Record<string, unknown>;
      };
      if (resolved.ok !== true || !resolved.targetCall) {
        const result = resolved.result ?? resolved;
        const bridgeAudit = bridgeToolAuditEvent("tool_call", call.args, result);
        input.audit.push({
          name: "tool_call",
          args: redactedBridgeToolAuditArgs("tool_call", call.args),
          ok: false,
          result: redactedBridgeToolAuditResult("tool_call", result),
          error: bridgeAudit?.error?.code ?? "tool_call_bridge_resolution_failed",
          bridgeAudit: bridgeAudit ?? undefined,
        });
        await finishBridgeProgress(result, bridgeAudit, false);
        return result;
      }
      const auditStartIndex = input.audit.length;
      const result = await executeWithBridge(resolved.targetCall, {
        args: call.args,
        invocation: resolved.bridgeInvocation ?? {},
      });
      const bridgedResult = withBridgeInvocationForAudit(result, resolved.bridgeInvocation);
      const bridgeAudit = bridgeToolAuditEvent("tool_call", call.args, bridgedResult);
      const targetAudit = [...input.audit.slice(auditStartIndex)].reverse()
        .find((entry) => entry.name === resolved.targetCall?.name);
      if (targetAudit && bridgeAudit) targetAudit.bridgeAudit = bridgeAudit;
      input.audit.push({
        name: "tool_call",
        args: redactedBridgeToolAuditArgs("tool_call", call.args),
        ok: true,
        result: redactedBridgeToolAuditResult("tool_call", bridgedResult),
        bridgeAudit: bridgeAudit ?? undefined,
      });
      await finishBridgeProgress(bridgedResult, bridgeAudit, true);
      return bridgedResult;
    } catch (error) {
      const failureResult = {
        ok: false,
        error: {
          code: "underlying_tool_error",
          recoverable: false,
        },
      };
      const bridgeAudit = bridgeToolAuditEvent("tool_call", call.args, failureResult);
      input.audit.push({
        name: "tool_call",
        args: redactedBridgeToolAuditArgs("tool_call", call.args),
        ok: false,
        result: redactedBridgeToolAuditResult("tool_call", failureResult),
        error: bridgeAudit?.error?.code ?? "tool_call_bridge_exception",
        bridgeAudit: bridgeAudit ?? undefined,
      });
      await finishBridgeProgress(failureResult, bridgeAudit, false);
      throw error;
    }
  };
  return executeWithBridge;
}

async function startBridgeToolCallProgress(input: {
  sessionId: string;
  turnInput: RuntimeTurnInput;
  messageLanguage: RuntimeMessageLanguage;
  call: BridgeToolCall;
  buildIntermediateAction: BuildIntermediateAction;
  emitIntermediateBestEffort: EmitIntermediateBestEffort;
  emitTurnEventBestEffort: EmitTurnEventBestEffort;
}): Promise<(result: unknown, bridgeAudit: ReturnType<typeof bridgeToolAuditEvent>, ok: boolean) => Promise<void>> {
  const startedAt = Date.now();
  const toolCallId = `tool-${randomUUID().slice(0, 8)}`;
  const workBlockId = `work-${toolCallId}`;
  const cleanArgs = { ...input.call.args };
  const progress = summarizeToolProgress(input.call.name, cleanArgs, input.messageLanguage);
  const workBlockLabel = progress.workBlockLabel || progress.safeLabel;
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  await input.emitTurnEventBestEffort(input.turnInput, {
    kind: "work.block.started",
    payload: {
      workBlockId,
      label: workBlockLabel,
      activityKind: progress.kind,
    },
  });
  await input.emitTurnEventBestEffort(input.turnInput, {
    kind: "tool.started",
    payload: {
      toolCallId,
      workBlockId,
      workBlockLabel,
      bridgePhase: "invoke",
      activityKind: progress.kind,
      toolName: progress.toolName,
      inputLabel: progress.inputLabel,
      safeLabel: progress.safeLabel,
      detailRows: progress.detailRows,
    },
  });
  if (inboundEnvelope && input.turnInput.emitIntermediateDelivery) {
    await input.emitIntermediateBestEffort(
      input.turnInput,
      input.buildIntermediateAction({
        envelope: inboundEnvelope,
        suffix: `${input.call.name}-${randomUUID().slice(0, 8)}-bridge-progress`,
        text: "",
        metadata: {
          kind: "tool_progress",
          activityKind: progress.kind,
          toolCallId,
          toolName: progress.toolName,
          safeLabel: progress.safeLabel,
          inputLabel: progress.inputLabel,
          bridgePhase: "invoke",
          workBlockId,
          workBlockLabel,
          detailRows: progress.detailRows,
        },
      }),
      {
        source: "runtime/native-tool-loop.ts#bridge-tool-progress",
        kind: "tool_progress",
        tool: input.call.name,
      },
    );
  }
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.sessionId,
    kind: "tool_call",
    payload: {
      name: input.call.name,
      arguments: evidenceTranscriptToolCallArgumentsProjection(cleanArgs),
    },
    metadata: {
      source: "runtime/native-tool-loop.ts#bridge-tool-progress",
      tool_surface_transition: "invoke",
    },
  }));
  return async (result: unknown, bridgeAudit: ReturnType<typeof bridgeToolAuditEvent>, ok: boolean) => {
    await input.emitTurnEventBestEffort(input.turnInput, {
      kind: ok ? "tool.completed" : "tool.failed",
      payload: {
        toolCallId,
        workBlockId,
        workBlockLabel,
        bridgePhase: ok ? "invoked" : "denied",
        activityKind: progress.kind,
        toolName: progress.toolName,
        inputLabel: progress.inputLabel,
        safeLabel: progress.safeLabel,
        detailRows: progress.detailRows,
        durationMs: Date.now() - startedAt,
      },
    });
    await input.emitTurnEventBestEffort(input.turnInput, {
      kind: "work.block.completed",
      payload: {
        workBlockId,
        label: workBlockLabel,
        status: ok ? "completed" : "failed",
        durationMs: Date.now() - startedAt,
      },
    });
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "tool_result",
      payload: {
        name: input.call.name,
        ok,
        result: evidenceTranscriptToolResultProjection(redactedBridgeToolAuditResult("tool_call", result)),
      },
      metadata: {
        source: "runtime/native-tool-loop.ts#bridge-tool-progress",
        bridge_audit: bridgeAudit ?? undefined,
        tool_surface_transition: ok ? "invoked" : "denied",
      },
    }));
  };
}
