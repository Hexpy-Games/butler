export interface ProgressDetailRow {
  id: string;
  kind?: string;
  safe_label: string;
  safe_value?: string;
  state?: string;
}

export interface ProgressSummaryRow {
  id: string;
  kind:
    | "explored"
    | "searched"
    | "read"
    | "ran_command"
    | "edited"
    | "dispatch"
    | "used_tool"
    | "context"
    | "model"
    | "thinking"
    | "worked_duration"
    | "message"
    | "turn"
    | "automation"
    | "worker"
    | "system"
    | string;
  safe_label: string;
  state: string;
  created_at: string;
  turn_event_sequence?: number;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  tool_result_id?: string;
  tool_result_byte_length?: number;
  bridge_phase?: string;
  receipt_kind?: string;
  public_decision_role?: string;
  public_decision_summary?: string;
  public_decision_rationale?: string;
  public_decision_next_step?: string;
  public_decision_source?: string;
  public_decision_model_call_id?: string;
  public_decision_latency_ms?: number;
  public_decision_evidence_refs?: string[];
  work_contract_id?: string;
  work_stream_id?: string;
  semantic_block_id?: string;
  activity_stage?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_block_phase?: "started" | "updated" | "completed";
  work_block_sequence?: number;
  work_decision_id?: string;
  work_decision_title?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  work_decision_source?: string;
  work_decision_evidence_refs?: string[];
  runtime_fault_id?: string;
  runtime_fault_kind?: string;
  runtime_fault_retryable?: boolean;
  runtime_fault_public_summary?: string;
  runtime_fault_safe_error_code?: string;
  runtime_fault_safe_cause?: string;
  safe_count?: number;
  safe_path_labels?: string[];
  safe_detail_rows?: ProgressDetailRow[];
  safe_order?: number;
}

export interface WorkerActivityWorkBlock {
  id: string;
  label: string;
  state: string;
  rows: ProgressSummaryRow[];
  decision_title?: string;
  decision_summary?: string;
  decision_rationale?: string;
  decision_next_step?: string;
  decision_source?: string;
  decision_evidence_refs?: string[];
  created_at?: string;
}
