import type { evaluateWorkingContextBudget } from "./budget.ts";
import type { compactionWindow } from "./compaction-message-window.ts";
import type { CompactionSnapshot } from "./compaction-records.ts";

export function createCompactionSnapshot(input: {
  canonicalSessionId: string;
  trigger: CompactionSnapshot["trigger"];
  modelRef?: string | null;
  now: string;
  preTokens: number;
  postTokens: number;
  sourceHash: string | null;
  summary: string;
  window: ReturnType<typeof compactionWindow>;
  diagnostics: string[];
  contextWindowTokens: number;
  workingBudget: ReturnType<typeof evaluateWorkingContextBudget>;
}): CompactionSnapshot {
  return {
    schema: "butler.context.compaction.v1",
    snapshot_id: `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    session_id: input.canonicalSessionId,
    trigger: input.trigger,
    status: input.summary.trim() || input.window.toSummarize.length === 0 ? "ok" : "failed",
    created_at: input.now,
    model_ref: input.modelRef ?? null,
    model_context_window_tokens: input.contextWindowTokens,
    pre_estimated_tokens: input.preTokens,
    post_estimated_tokens: input.postTokens,
    summarized_event_range: {
      first_event_id: input.window.toSummarize[0]?.source_ref ?? input.window.toSummarize[0]?.id ?? null,
      last_event_id: input.window.toSummarize.at(-1)?.source_ref ?? input.window.toSummarize.at(-1)?.id ?? null,
      event_count: input.window.toSummarize.length,
    },
    preserved_suffix_event_ids: input.window.preserved.map((message) => message.source_ref ?? message.id),
    summarized_message_range: {
      first_message_id: input.window.toSummarize[0]?.id ?? null,
      last_message_id: input.window.toSummarize.at(-1)?.id ?? null,
      from_seq: input.window.toSummarize[0]?.seq ?? null,
      to_seq: input.window.toSummarize.at(-1)?.seq ?? null,
      message_count: input.window.toSummarize.length,
    },
    preserved_suffix_message_ids: input.window.preserved.map((message) => message.id),
    source_hash: input.sourceHash,
    summary: input.summary.trim(),
    provenance: input.window.toSummarize.slice(0, 20).map((message) => message.id),
    diagnostics: input.diagnostics,
    region_tokens: {
      working_context_tokens: input.preTokens,
      available_working_context_tokens: input.workingBudget.availableWorkingContextTokens,
      used_working_ratio: input.workingBudget.usedWorkingRatio,
      static_context_tokens: input.workingBudget.staticContextTokens,
      live_configuration_tokens: input.workingBudget.liveConfigurationTokens,
      runtime_state_tokens: input.workingBudget.runtimeStateTokens,
      compaction_prompt_reserve_tokens: input.workingBudget.compactionPromptReserveTokens,
    },
    known_gaps: [],
  };
}
