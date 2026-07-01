export interface ContextUsageCategory {
  id: string;
  label: string;
  used_tokens: number;
  budget_tokens: number;
  ratio: number;
  safe_description: string;
  source_kind:
    | "static_context"
    | "live_configuration"
    | "runtime_state"
    | "working_context"
    | "retrieved_context"
    | "current_input"
    | "references"
    | "output_reserve"
    | "tool_reserve"
    | "compaction_reserve";
}

export interface ContextDetailsView {
  session_id: string;
  model_ref?: string;
  provider_id?: string;
  model_id?: string;
  token_count_source?: string;
  used_tokens: number;
  budget_tokens: number;
  max_output_tokens?: number;
  available_working_context_tokens?: number;
  used_working_context_tokens?: number;
  usable_user_message_tokens?: number;
  auto_compact_at_tokens?: number;
  hard_pressure_at_tokens?: number;
  ratio: number;
  status: "low" | "medium" | "high";
  categories: ContextUsageCategory[];
  updated_at: string;
}
