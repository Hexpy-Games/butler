import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../../../test-support/harness/transcripts.ts";
import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import {
  satisfiedCompletionObligationsForToolResult,
} from "../../../tools/butler-tools.ts";
import { sanitizePublicText } from "../../../events/turn-events.ts";
import type { PublicWorkDecision, ToolProgressSummary } from "../output/tool-types.ts";
import {
  evidenceCapabilityReceiptsFromResult,
  evidenceReceiptsFromResult,
} from "../../../output/evidence/receipts.ts";
import {
  evidenceTranscriptErrorMessage,
  evidenceTranscriptToolCallArgumentsProjection,
  evidenceTranscriptToolResultProjection,
} from "../../../output/evidence/transcript-result.ts";
import {
  activeTodoWorkBlockFromArgs,
  runtimeSemanticTodoItems,
} from "../progress/runtime-semantic-progress.ts";
import { emitTodoProgressBestEffort } from "../progress/turn-delivery-events.ts";
import type {
  NativeAuditedToolExecutorInput,
  NativeToolCall,
} from "./audited-executor-types.ts";

export interface InternalProgressToolRunner {
  run(call: NativeToolCall, source: "model" | "runtime"): Promise<unknown>;
  runtimeUpdate(input: {
    decision: PublicWorkDecision;
    progress: ToolProgressSummary;
    state: "execution" | "review";
  }): Promise<void>;
  semanticProgressEstablished(): boolean;
  currentSemanticWorkBlock(): { id: string; label: string } | null;
}

export function createInternalProgressToolRunner(input: {
  executorInput: NativeAuditedToolExecutorInput;
  throwIfAborted(): void;
  discardPendingPublicDecisionForTool(toolName: string): void;
}): InternalProgressToolRunner {
  let semanticProgressEstablished = false;
  let currentSemanticWorkBlock: { id: string; label: string } | null = null;
  const run = async (call: NativeToolCall, source: "model" | "runtime") => {
    input.throwIfAborted();
    const startedAt = Date.now();
    const cleanArgs = { ...call.args };
    input.discardPendingPublicDecisionForTool(call.name);
    appendInternalProgressToolCall(input.executorInput, call.name, cleanArgs, source);
    try {
      const result = await input.executorInput.executor(call);
      input.throwIfAborted();
      recordInternalProgressMetric(input.executorInput, call.name, startedAt, "ok");
      input.executorInput.audit.push({
        name: call.name,
        args: cleanArgs,
        ok: true,
        result,
        satisfiedCompletionObligations: satisfiedCompletionObligationsForToolResult(call.name, result),
        evidenceReceipts: evidenceReceiptsFromResult(result),
        evidenceCapabilityReceipts: evidenceCapabilityReceiptsFromResult(result),
      });
      if (call.name === "update_todo_list") {
        semanticProgressEstablished = true;
        currentSemanticWorkBlock = activeTodoWorkBlockFromArgs(cleanArgs);
        input.executorInput.semanticProgressSafetyNet.source = source;
        input.executorInput.semanticProgressSafetyNet.listId = progressListId(cleanArgs);
        input.executorInput.semanticProgressSafetyNet.title =
          progressTitle(cleanArgs) ?? input.executorInput.semanticProgressSafetyNet.title;
        await emitTodoProgressBestEffort({
          turnInput: input.executorInput.turnInput,
          args: cleanArgs,
        });
      }
      appendInternalProgressToolResult(input.executorInput, call.name, result, source);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordInternalProgressMetric(input.executorInput, call.name, startedAt, "error", error);
      input.executorInput.audit.push({
        name: call.name,
        args: cleanArgs,
        ok: false,
        error: message,
      });
      appendInternalProgressToolError(input.executorInput, call.name, message, source);
      if (
        input.executorInput.turnInput.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      return { ok: false, error: message };
    }
  };

  return {
    run,
    async runtimeUpdate(update) {
      const title = runtimeProgressTitle(input.executorInput, update);
      const executionLabel = runtimeExecutionLabel(update, title);
      input.executorInput.semanticProgressSafetyNet.title = title;
      input.executorInput.semanticProgressSafetyNet.lastExecutionLabel = executionLabel;
      const args = {
        list_id: input.executorInput.semanticProgressSafetyNet.listId,
        title,
        todos: runtimeSemanticTodoItems({
          language: input.executorInput.messageLanguage,
          executionLabel,
          state: update.state,
        }),
      };
      await run({
        name: "update_todo_list",
        args,
        rawArguments: JSON.stringify(args),
      }, "runtime");
    },
    semanticProgressEstablished: () => semanticProgressEstablished,
    currentSemanticWorkBlock: () => currentSemanticWorkBlock,
  };
}

function appendInternalProgressToolCall(
  input: NativeAuditedToolExecutorInput,
  toolName: string,
  args: Record<string, unknown>,
  source: "model" | "runtime",
): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.sessionId,
    kind: "tool_call",
    payload: {
      name: toolName,
      arguments: evidenceTranscriptToolCallArgumentsProjection(args),
    },
    metadata: {
      source: source === "runtime"
        ? "runtime/native-tool-loop.ts#semantic-progress-safety-net"
        : "runtime/native-tool-loop.ts",
    },
  }));
}

function appendInternalProgressToolResult(
  input: NativeAuditedToolExecutorInput,
  toolName: string,
  result: unknown,
  source: "model" | "runtime",
): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.sessionId,
    kind: "tool_result",
    payload: {
      name: toolName,
      ok: true,
      result: evidenceTranscriptToolResultProjection(result),
    },
    metadata: {
      source: source === "runtime"
        ? "runtime/native-tool-loop.ts#semantic-progress-safety-net"
        : "runtime/native-tool-loop.ts",
    },
  }));
}

function appendInternalProgressToolError(
  input: NativeAuditedToolExecutorInput,
  toolName: string,
  message: string,
  source: "model" | "runtime",
): void {
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.sessionId,
    kind: "tool_result",
    payload: {
      name: toolName,
      ok: false,
      error: evidenceTranscriptErrorMessage(message),
    },
    metadata: {
      source: source === "runtime"
        ? "runtime/native-tool-loop.ts#semantic-progress-safety-net"
        : "runtime/native-tool-loop.ts",
    },
  }));
}

function recordInternalProgressMetric(
  input: NativeAuditedToolExecutorInput,
  toolName: string,
  startedAt: number,
  status: "ok" | "error",
  error?: unknown,
): void {
  recordOperationalMetric({
    category: "tool",
    name: toolName,
    status,
    durationMs: Date.now() - startedAt,
    dimensions: {
      sessionRole: input.turnInput.handle.role,
      toolName,
      ...(error ? { errorName: error instanceof Error ? error.name : "UnknownError" } : {}),
    },
  }, { butlerData: input.butlerData });
}

function progressListId(args: Record<string, unknown>): string {
  return typeof args.list_id === "string" && args.list_id.trim()
    ? args.list_id.trim()
    : "main";
}

function progressTitle(args: Record<string, unknown>): string | null {
  return typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
}

function runtimeProgressTitle(
  input: NativeAuditedToolExecutorInput,
  update: { decision: PublicWorkDecision },
): string {
  const fallback = input.messageLanguage === "ko" ? "진행 중인 작업" : "Current work";
  return sanitizePublicText(update.decision.summary, fallback).slice(0, 120) || fallback;
}

function runtimeExecutionLabel(
  update: { decision: PublicWorkDecision; progress: ToolProgressSummary },
  title: string,
): string {
  return sanitizePublicText(
    update.progress.workBlockLabel || update.progress.safeLabel || update.decision.summary,
    title,
  ).slice(0, 180) || title;
}
