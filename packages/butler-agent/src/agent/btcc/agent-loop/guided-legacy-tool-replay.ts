import type { ButlerToolExecutor } from "../../tools/butler-tools.ts";
import type {
  GuidedToolJournalRecord,
  GuidedToolJournal,
} from "../ports/index.ts";
import { parseToolCatalogId } from "../../tools/progressive-catalog.ts";
import {
  ordinaryToolError,
} from "./guided-tool-progress.ts";
import {
  isReplaySafeTool,
  priorToolFailure,
  uncertainPriorMutation,
} from "./guided-turn-policy.ts";

type LegacyReplayRuntime = { toolJournal: GuidedToolJournal };
type GuidedToolCall = Parameters<ButlerToolExecutor>[0];
const LEGACY_REPLAY_SUMMARY =
  "재개: 기존 명령";

type LegacyReplayExecutionInput = {
  record: GuidedToolJournalRecord;
  call: GuidedToolCall;
  callId: string;
  effectiveToolName: string;
  signal: AbortSignal;
  runtime: LegacyReplayRuntime;
  executeFresh: (call: GuidedToolCall) => Promise<unknown>;
};

type LegacyToolReplayResult = {
  handled: true;
  result: unknown;
};

export function findLegacyToolRecord(
  journal: Pick<GuidedToolJournal, "find">,
  callIds: readonly string[] | undefined,
): GuidedToolJournalRecord | undefined {
  for (const callId of callIds ?? []) {
    const record = journal.find(callId);
    if (record) return record;
  }
  return undefined;
}

export async function replaySummarylessLegacyCall(
  input: Omit<LegacyReplayExecutionInput, "record"> & {
    record?: GuidedToolJournalRecord;
    callName: string;
    callArgs: Record<string, unknown>;
    visible: boolean;
    authorized: boolean;
  },
): Promise<LegacyToolReplayResult | null> {
  if (
    !input.record || !input.visible || !input.authorized ||
    !isSummarylessRunCommandCall(input.callName, input.callArgs, input.effectiveToolName)
  ) return null;
  return replaySummarylessLegacyRecord({ ...input, record: input.record });
}

async function replaySummarylessLegacyRecord(
  input: LegacyReplayExecutionInput,
): Promise<LegacyToolReplayResult> {
  const { record } = input;
  if (record.status === "completed") {
    return { handled: true, result: record.result };
  }
  if (record.status === "failed" || record.status === "cancelled") {
    return {
      handled: true,
      result: priorToolFailure(record.status, input.effectiveToolName),
    };
  }
  if (!isReplaySafeTool(input.effectiveToolName)) {
    return {
      handled: true,
      result: uncertainPriorMutation(input.effectiveToolName),
    };
  }
  try {
    const result = await input.executeFresh(
      legacyReplayExecutionCall(input.call),
    );
    input.runtime.toolJournal.finish({
      callId: input.callId,
      status: "completed",
      result,
    });
    return { handled: true, result };
  } catch (error) {
    if (input.signal.aborted) {
      input.runtime.toolJournal.finish({
        callId: input.callId,
        status: "cancelled",
        errorCode: "cancelled",
      });
      throw error;
    }
    const result = ordinaryToolError(input.effectiveToolName, error);
    input.runtime.toolJournal.finish({
      callId: input.callId,
      status: "completed",
      result,
    });
    return { handled: true, result };
  }
}

function legacyReplayExecutionCall(call: GuidedToolCall): GuidedToolCall {
  if (call.name === "run_command") {
    const args = {
      ...call.args,
      summary: LEGACY_REPLAY_SUMMARY,
    };
    return {
      ...call,
      args,
    };
  }

  if (call.name !== "tool_call") return call;
  const catalogId = typeof call.args.id === "string"
    ? parseToolCatalogId(call.args.id)
    : null;
  const nested = call.args.arguments;
  if (
    catalogId?.provider !== "native" ||
    catalogId.namespace !== null ||
    catalogId.name !== "run_command" ||
    !nested || typeof nested !== "object" || Array.isArray(nested) ||
    Object.hasOwn(nested, "summary")
  ) return call;

  const args = {
    ...call.args,
    arguments: {
      ...nested as Record<string, unknown>,
      summary: LEGACY_REPLAY_SUMMARY,
    },
  };
  return {
    ...call,
    args,
  };
}

function isSummarylessRunCommandCall(
  callName: string,
  callArgs: Record<string, unknown>,
  effectiveToolName: string,
): boolean {
  if (callName === "run_command" && effectiveToolName === "run_command") {
    return !Object.hasOwn(callArgs, "summary");
  }
  if (callName !== "tool_call" || effectiveToolName !== "run_command") {
    return false;
  }
  const catalogId = typeof callArgs.id === "string"
    ? parseToolCatalogId(callArgs.id)
    : null;
  const nested = callArgs.arguments;
  return Boolean(
    catalogId?.provider === "native" &&
      catalogId.namespace === null &&
      catalogId.name === "run_command" &&
      nested && typeof nested === "object" && !Array.isArray(nested) &&
      !Object.hasOwn(nested, "summary"),
  );
}
