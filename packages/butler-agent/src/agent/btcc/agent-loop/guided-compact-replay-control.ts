import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import type { DurableWorkService, WorkTurnScope } from "../work/index.ts";
import {
  READ_OPERATION_RESULTS_TOOL_NAME,
  REPLACE_PHASE_CONTINUITY_TOOL_NAME,
  type PhaseContinuity,
} from "../../tools/m1-compact-replay.ts";
import type { GuidedCompactReplayRuntime } from
  "./guided-compact-replay-runtime.ts";
import type { GuidedActivityProjection } from "../projection/index.ts";
import { readGuidedOperationResultViews } from
  "./guided-operation-result-read.ts";

export function validateCompactReplayToolBatch(input: {
  enabled: boolean;
  calls: readonly { name: string }[];
}): void {
  if (!input.enabled || input.calls.length === 0) return;
  const replacements = input.calls.filter((call) =>
    call.name === REPLACE_PHASE_CONTINUITY_TOOL_NAME);
  if (replacements.length !== 1 ||
    input.calls[0]?.name !== REPLACE_PHASE_CONTINUITY_TOOL_NAME) {
    throw new Error("compact_replay_phase_continuity_required_first");
  }
}

export function observeCompactReplayToolBatch(input: {
  enabled: boolean;
  text: string;
  calls: readonly { name: string; arguments: Record<string, unknown> }[];
  activity: GuidedActivityProjection;
}) {
  validateCompactReplayToolBatch({ enabled: input.enabled, calls: input.calls });
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
    const continuity = parsePhaseContinuity(input.args);
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

function parsePhaseContinuity(args: Record<string, unknown>): PhaseContinuity {
  return {
    objectiveState: requiredText(args.objective_state, "objective_state", 1_200),
    integratedDecisions: textArray(
      args.integrated_decisions,
      "integrated_decisions",
    ),
    unresolvedQuestions: textArray(
      args.unresolved_questions,
      "unresolved_questions",
    ),
    nextBatchPurpose: requiredText(
      args.next_batch_purpose,
      "next_batch_purpose",
      800,
    ),
    publicActivity: requiredText(args.public_activity, "public_activity", 500),
  };
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new Error(`compact_replay_${field}_invalid`);
  return text;
}

function textArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error(`compact_replay_${field}_invalid`);
  }
  return value.map((item) => requiredText(item, field, 500));
}
