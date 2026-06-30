import type {
  ProviderStreamProjectionChunk,
  ProviderStreamTextTarget,
} from "../../../../integrations/providers/provider.ts";
import type { RuntimeTurnEventInput } from "../../../../test-support/harness/contracts.ts";
import {
  sanitizePublicText,
  type AgentTurnEventVisibility,
  type ProviderStreamEventKind,
} from "../../../events/turn-events.ts";

export interface ProviderStreamTurnEventProjector {
  project(chunk: ProviderStreamProjectionChunk): Promise<void>;
  completeOpenStreams(status: "completed" | "failed" | "aborted"): Promise<void>;
}

export function createProviderStreamTurnEventProjector(input: {
  turnId: string;
  defaultStreamId: string;
  defaultTextTarget?: ProviderStreamTextTarget;
  emitTurnEvent?: (event: RuntimeTurnEventInput) => Promise<void> | void;
}): ProviderStreamTurnEventProjector {
  const seen = new Set<string>();
  const openStreams = new Set<string>();
  const sequenceCounters = new Map<string, number>();

  const nextSequence = (key: string): number => {
    const next = (sequenceCounters.get(key) ?? 0) + 1;
    sequenceCounters.set(key, next);
    return next;
  };

  const emit = async (
    kind: ProviderStreamEventKind,
    visibility: AgentTurnEventVisibility,
    streamId: string,
    payload: Record<string, unknown>,
    sequence?: number,
    callIndex?: number,
  ): Promise<void> => {
    const dedupeKey = [
      input.turnId,
      streamId,
      kind,
      callIndex ?? "",
      sequence ?? "",
    ].join("\u0000");
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    openStreams.add(streamId);
    await input.emitTurnEvent?.({
      kind,
      visibility,
      payload,
    });
  };

  return {
    async project(chunk): Promise<void> {
      const streamId = safeStreamId(chunk.streamId, input.defaultStreamId);
      if (chunk.type === "text_delta") {
        const textDelta = sanitizePublicText(chunk.textDelta, "");
        if (!textDelta) return;
        const sequence = safeSequence(
          chunk.sequence,
          () => nextSequence(`${streamId}:model.stream.text_delta`),
        );
        await emit(
          "model.stream.text_delta",
          "public",
          streamId,
          {
            streamId,
            textDelta,
            target: chunk.target ?? input.defaultTextTarget ?? "final_candidate",
            sequence,
          },
          sequence,
        );
        return;
      }

      if (chunk.type === "reasoning_delta") {
        const charCount = safeCharCount(chunk.charCount, chunk.textDelta);
        if (charCount <= 0) return;
        const sequence = safeSequence(
          chunk.sequence,
          () => nextSequence(`${streamId}:model.stream.reasoning_delta`),
        );
        await emit(
          "model.stream.reasoning_delta",
          "internal",
          streamId,
          {
            streamId,
            charCount,
            sequence,
          },
          sequence,
        );
        return;
      }

      if (chunk.type === "tool_call_delta") {
        const callIndex = Math.max(0, Math.trunc(chunk.callIndex));
        const sequence = safeSequence(
          chunk.sequence,
          () => nextSequence(`${streamId}:model.stream.tool_call_delta:${callIndex}`),
        );
        const rawArgumentsDelta = typeof chunk.argumentsDelta === "string"
          ? chunk.argumentsDelta
          : undefined;
        const argumentCharCount = safeCharCount(chunk.argumentCharCount, rawArgumentsDelta);
        await emit(
          "model.stream.tool_call_delta",
          "internal",
          streamId,
          {
            streamId,
            callIndex,
            sequence,
            ...optionalTrimmedString("toolCallId", chunk.toolCallId),
            ...optionalSafeToolName(chunk.toolName),
            argumentCharCount,
            ...(rawArgumentsDelta === undefined ? {} : { rawArgumentsDelta }),
            publicState: chunk.publicState ?? "generating",
          },
          sequence,
          callIndex,
        );
        return;
      }

      if (chunk.type === "completed") {
        await emit(
          "model.stream.completed",
          "internal",
          streamId,
          {
            streamId,
            status: chunk.status,
          },
        );
      }
    },

    async completeOpenStreams(status): Promise<void> {
      for (const streamId of [...openStreams]) {
        await emit(
          "model.stream.completed",
          "internal",
          streamId,
          {
            streamId,
            status,
          },
        );
      }
    },
  };
}

function safeStreamId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function safeSequence(value: number | undefined, next: () => number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : next();
}

function safeCharCount(value: number | undefined, text: string | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return typeof text === "string" ? text.length : 0;
}

function optionalTrimmedString(key: string, value: string | undefined): Record<string, string> {
  const trimmed = value?.trim();
  return trimmed ? { [key]: trimmed } : {};
}

function optionalSafeToolName(value: string | undefined): Record<string, string> {
  const safeToolName = sanitizePublicText(value, "");
  return safeToolName ? { safeToolName } : {};
}
