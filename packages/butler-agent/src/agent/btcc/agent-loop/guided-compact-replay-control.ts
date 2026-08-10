import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import type { DurableWorkService, WorkTurnScope } from "../work/index.ts";
import {
  READ_OPERATION_RESULTS_TOOL_NAME,
  REPLACE_PHASE_CONTINUITY_TOOL_NAME,
} from "../../tools/m1-compact-replay.ts";
import { parseCompactReplayPhaseContinuity } from
  "../compact-replay/index.ts";
import type { GuidedCompactReplayRuntime } from
  "./guided-compact-replay-runtime.ts";
import type { GuidedActivityProjection } from "../projection/index.ts";
import { readGuidedOperationResultViews } from
  "./guided-operation-result-read.ts";

export function observeCompactReplayToolBatch(input: {
  text: string;
  calls: readonly { name: string; arguments: Record<string, unknown> }[];
  activity: GuidedActivityProjection;
}) {
  return input.activity.observeToolBatch({
    text: input.text,
    toolCalls: input.calls.map((call) => ({
      name: call.name,
      args: call.arguments,
    })),
  });
}

export async function executeCompactReplayControlTool(input: {
  name: string;
  args: Record<string, unknown>;
  durableWork: DurableWorkService;
  toolJournal: SqliteGuidedToolJournal;
  workScope: WorkTurnScope;
  runtime: GuidedCompactReplayRuntime;
  replayed?: boolean;
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!input.runtime.enabled) {
    if (input.name === READ_OPERATION_RESULTS_TOOL_NAME ||
      input.name === REPLACE_PHASE_CONTINUITY_TOOL_NAME) {
      throw new Error("compact_replay_control_disabled");
    }
    return { handled: false };
  }
  const boundWork = await input.durableWork.boundWorkForTurn(
    input.workScope.turnId,
  );
  if (input.name === REPLACE_PHASE_CONTINUITY_TOOL_NAME) {
    const continuity = parseCompactReplayPhaseContinuity(input.args);
    return {
      handled: true,
      result: {
        ok: true,
        work_id: boundWork?.workId ?? null,
        phase_continuity: continuity,
      },
    };
  }
  if (input.name !== READ_OPERATION_RESULTS_TOOL_NAME) {
    return { handled: false };
  }
  try {
    const selected = readGuidedOperationResultViews({
      args: input.args,
      toolJournal: input.toolJournal,
      boundWorkId: boundWork?.workId ?? null,
      scope: {
        sessionId: input.workScope.sessionId,
        ...(input.workScope.projectRef
          ? { projectRef: input.workScope.projectRef }
          : {}),
        ...(boundWork ? { workId: boundWork.workId } : {}),
      },
      maxOutputTokens: input.runtime.budget.selectedViewTokens,
    });
    input.runtime.observeExactRead({
      success: selected.views.length > 0,
      resultRef: selected.resultRef,
      replayed: input.replayed,
    });
    return { handled: true, result: { ok: true, results: selected.views } };
  } catch (error) {
    input.runtime.observeExactRead({
      success: false,
      replayed: input.replayed,
    });
    throw error;
  }
}
