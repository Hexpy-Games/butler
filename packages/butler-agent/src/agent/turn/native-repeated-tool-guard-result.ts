import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../test-support/harness/transcripts.ts";
import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import type { RepeatedToolFamilyGuard } from "./tool-loop-guards.ts";
import {
  evidenceTranscriptToolCallArgumentsProjection,
  evidenceTranscriptToolResultProjection,
} from "../output/evidence-transcript-result.ts";
import type {
  NativeAuditedToolExecutorInput,
  NativeToolCall,
} from "./native-audited-executor-types.ts";

export function maybeHandleRepeatedToolFamily(input: {
  executorInput: NativeAuditedToolExecutorInput;
  guard: RepeatedToolFamilyGuard;
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
  startedAt: number;
}): unknown | null {
  const repeatDecision = input.guard.record(input.call.name, input.cleanArgs);
  if (!repeatDecision?.blocked) return null;
  const result = repeatDecision.result;
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.executorInput.sessionId,
    kind: "tool_call",
    payload: {
      name: input.call.name,
      arguments: evidenceTranscriptToolCallArgumentsProjection(input.cleanArgs),
    },
    metadata: {
      source: "runtime/native-tool-loop.ts#repeated-tool-family-guard",
      repeat_family: repeatDecision.family,
    },
  }));
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.executorInput.sessionId,
    kind: "tool_result",
    payload: {
      name: input.call.name,
      ok: false,
      result: evidenceTranscriptToolResultProjection(result),
    },
    metadata: {
      source: "runtime/native-tool-loop.ts#repeated-tool-family-guard",
      repeat_family: repeatDecision.family,
    },
  }));
  recordOperationalMetric({
    category: "runtime",
    name: "repeated_tool_family_guard",
    status: "ok",
    durationMs: Date.now() - input.startedAt,
    dimensions: {
      sessionRole: input.executorInput.turnInput.handle.role,
      toolName: input.call.name,
      repeatFamily: repeatDecision.family,
      repeatCount: String(repeatDecision.count),
    },
  }, { butlerData: input.executorInput.butlerData });
  input.executorInput.audit.push({
    name: input.call.name,
    args: input.cleanArgs,
    ok: false,
    error: String(result.message),
  });
  return result;
}
