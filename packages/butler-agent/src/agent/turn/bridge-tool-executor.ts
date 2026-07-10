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
import {
  evidenceTranscriptToolCallArgumentsProjection,
  evidenceTranscriptToolResultProjection,
} from "../output/evidence/transcript-result.ts";
import {
  safeOptionalPublicText,
  safePublicText,
} from "../output/evidence/transcript-sanitizers.ts";
import type { RuntimeMessageLanguage } from "../output/messages.ts";
import { isRuntimeFaultFailure } from "./runtime-delivery-state.ts";
import type { ObservationKind, TurnObservation } from "./turn-kernel.ts";
import type { ToolAuditEntry } from "./native/output/tool-types.ts";
import { toolObservationResult } from "./native/tool-execution/tool-observations.ts";

export type BridgeToolCall = Parameters<FunctionToolPromptOptions["executeTool"]>[0];

export type BridgedToolCallAuditContext = {
  args: Record<string, unknown>;
  invocation: Record<string, unknown>;
};

const MODEL_VISIBLE_BRIDGE_OBSERVATION_LIMIT = 2_400;
const BRIDGE_FAILURE_FALLBACK = "Tool bridge failed with redacted private details.";
const BRIDGE_ARGUMENT_ERROR_CODES = new Set([
  "invalid_tool_arguments",
  "invalid_tool_catalog_id",
]);
const BRIDGE_UNAVAILABLE_ERROR_CODES = new Set([
  "disabled_tool",
  "missing_tool_surface",
  "plugin_invoker_unavailable",
  "tool_not_described",
  "tool_unavailable",
  "unknown_tool",
  "unknown_tool_catalog_id",
  "unsupported_tool_affordance",
  "forbidden_bridge_target",
  "invalid_mcp_affordance",
]);

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
  turnId: string;
  audit: ToolAuditEntry[];
  turnInput: RuntimeTurnInput;
  messageLanguage: RuntimeMessageLanguage;
  executor: FunctionToolPromptOptions["executeTool"];
  buildIntermediateAction: BuildIntermediateAction;
  emitIntermediateBestEffort: EmitIntermediateBestEffort;
  emitTurnEventBestEffort: EmitTurnEventBestEffort;
  throwIfAborted: () => void;
  bindResolvedTargetDecision?: (input: {
    wrapperToolName: string;
    targetToolName: string;
  }) => void;
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
        const result = bridgeFailureResult(resolved.result ?? resolved);
        const bridgeAudit = bridgeToolAuditEvent("tool_call", call.args, result);
        const observation = bridgeFailureObservation({
          turnId: input.turnId,
          call,
          result,
          fallbackCode: bridgeAudit?.error?.code ?? "tool_call_bridge_resolution_failed",
          fallbackMessage: "tool_call could not resolve a target tool.",
        });
        const observationResult = toolObservationResult(observation);
        input.audit.push({
          name: "tool_call",
          args: redactedBridgeToolAuditArgs("tool_call", call.args),
          ok: false,
          result: redactedBridgeToolAuditResult("tool_call", result),
          error: bridgeAudit?.error?.code ?? "tool_call_bridge_resolution_failed",
          observation,
          bridgeAudit: bridgeAudit ?? undefined,
        });
        await finishBridgeProgress(observationResult, bridgeAudit, false);
        return observationResult;
      }
      const auditStartIndex = input.audit.length;
      input.bindResolvedTargetDecision?.({
        wrapperToolName: call.name,
        targetToolName: resolved.targetCall.name,
      });
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
      if (isBridgeAbortFailure(error, input.turnInput.signal)) {
        throw error;
      }
      if (isRuntimeFaultFailure(error)) {
        throw error;
      }
      const failureResult = {
        ok: false,
        error: {
          code: "underlying_tool_error",
          recoverable: false,
        },
      };
      const bridgeAudit = bridgeToolAuditEvent("tool_call", call.args, failureResult);
      const message = error instanceof Error ? error.message : String(error);
      const observation = bridgeFailureObservation({
        turnId: input.turnId,
        call,
        result: failureResult,
        fallbackCode: bridgeAudit?.error?.code ?? "tool_call_bridge_exception",
        fallbackMessage: message,
      });
      const observationResult = toolObservationResult(observation);
      input.audit.push({
        name: "tool_call",
        args: redactedBridgeToolAuditArgs("tool_call", call.args),
        ok: false,
        result: redactedBridgeToolAuditResult("tool_call", failureResult),
        error: bridgeAudit?.error?.code ?? "tool_call_bridge_exception",
        observation,
        bridgeAudit: bridgeAudit ?? undefined,
      });
      await finishBridgeProgress(observationResult, bridgeAudit, false);
      return observationResult;
    }
  };
  return executeWithBridge;
}

function isBridgeAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

function bridgeFailureObservation(input: {
  turnId: string;
  call: BridgeToolCall;
  result: unknown;
  fallbackCode: string;
  fallbackMessage: string;
}): TurnObservation {
  const code = bridgeErrorCode(input.result) ?? input.fallbackCode;
  const message = bridgeErrorMessage(input.result) ?? input.fallbackMessage;
  const safeMessage = safePublicText(message, BRIDGE_FAILURE_FALLBACK);
  const catalogId = safeOptionalPublicText(stringArg(input.call.args.id) ?? "");
  const nextAction = safeOptionalPublicText(bridgeNextAction(input.result) ?? "");
  const parts = [
    "Tool: tool_call",
    `Bridge error code: ${safePublicText(code, "tool_call_bridge_error")}`,
    ...(catalogId ? [`Catalog id: ${catalogId}`] : []),
    `Observation: ${safeMessage}`,
    ...(nextAction ? [`Next action: ${nextAction}`] : []),
    "Use this observation to repair the catalog id, describe the tool first, adjust arguments, choose a different enabled tool, or continue with a bounded limitation.",
  ];
  return {
    observationId: `obs-${randomUUID().slice(0, 8)}`,
    turnId: input.turnId,
    kind: bridgeObservationKind(code),
    visibility: "model",
    summary: `tool_call bridge ${safePublicText(code, "tool_call_bridge_error")}: ${safeMessage}`,
    modelVisibleContent: limitBridgeObservationContent(parts.join("\n")),
    ...(catalogId ? { refs: [{ kind: "tool_catalog_id", id: catalogId }] } : {}),
    createdAt: new Date().toISOString(),
  };
}

function bridgeFailureResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const record = objectRecord(current);
    if (!record) return current;
    if (objectRecord(record.error)) return current;
    const nested = objectRecord(record.result);
    if (record.ok === false && nested) {
      current = nested;
      continue;
    }
    return current;
  }
  return current;
}

function bridgeObservationKind(code: string): ObservationKind {
  if (BRIDGE_ARGUMENT_ERROR_CODES.has(code)) return "tool_invalid_arguments";
  if (BRIDGE_UNAVAILABLE_ERROR_CODES.has(code)) return "tool_unavailable";
  return "validation_failed";
}

function bridgeErrorCode(result: unknown): string | null {
  const error = objectRecord(objectRecord(result)?.error);
  const code = error?.code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function bridgeErrorMessage(result: unknown): string | null {
  const error = objectRecord(objectRecord(result)?.error);
  const message = error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function bridgeNextAction(result: unknown): string | null {
  const error = objectRecord(objectRecord(result)?.error);
  const nextAction = error?.next_action;
  return typeof nextAction === "string" && nextAction.trim() ? nextAction.trim() : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArg(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function limitBridgeObservationContent(value: string): string {
  if (value.length <= MODEL_VISIBLE_BRIDGE_OBSERVATION_LIMIT) return value;
  return `${value.slice(0, MODEL_VISIBLE_BRIDGE_OBSERVATION_LIMIT)}\n...[observation truncated]`;
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
  const cleanArgs = { ...input.call.args };
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
