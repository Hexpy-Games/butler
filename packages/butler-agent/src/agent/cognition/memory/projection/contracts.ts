export const MEMORY_EXTRACTION_VERSION = "memory-extract-v2" as const;

export type MemoryNodeType =
  | "entity"
  | "project"
  | "preference"
  | "goal"
  | "constraint"
  | "decision"
  | "memory_atom";
export type MemoryBasis =
  | "user_statement"
  | "assistant_statement"
  | "reviewed_task"
  | "inference";
export type MemoryOriginKind =
  | "user_input"
  | "assistant_public"
  | "internal_control"
  | "unknown";

export type MemorySourceNotice =
  | {
      kind: "conversation_turn";
      session_id: string;
      turn_id: string;
      outcome_generation: number;
    }
  | {
      kind: "conversation_message";
      session_id: string;
      message_id: string;
      source_hash: string;
    }
  | {
      kind: "task_report";
      record_id: string;
      revision: string;
      operation_id: string;
    }
  | {
      kind: "explicit_record";
      record_kind: "rule" | "feedback";
      record_id: string;
      revision: string;
      operation_id: string;
    };

export type MemoryExecutionContext = {
  butlerData: string;
  target:
    | { kind: "active"; expected_generation: string }
    | { kind: "rebuild"; generation_id: string; canonical_snapshot_id: string };
  signal: AbortSignal;
  deadlineAt?: number;
  waitClass?: "interactive" | "background";
};

export type StageState =
  | { state: "pending"; blocked_by: string | null }
  | { state: "running"; attempt: number; owner_pid: number; started_at: string }
  | { state: "complete"; completed_units: number; total_units: number }
  | {
      state: "partial";
      completed_units: number;
      total_units: number;
      pending_units: number;
      failed_units: number;
    }
  | {
      state: "failed";
      code: string;
      retryable: boolean;
      next_attempt_at: string | null;
    }
  | {
      state: "not_configured";
      code: "model_not_configured" | "embedding_not_configured";
    };

export type MemoryJobProgress = {
  job_id: string;
  observed_completion_job_ids: string[];
  episode_id: string;
  revision: string;
  extraction_version: typeof MEMORY_EXTRACTION_VERSION;
  generation: string;
  source: StageState;
  semantic_graph: StageState;
  episode_vectors: StageState;
  node_vectors: StageState;
  hot_cache: StageState;
  outcome: "pending" | "partial" | "complete" | "superseded";
};

export type QuoteRef = { unit_ref: string; quote: string; occurrence: number };
export type NodeResolution =
  | { kind: "create"; provisional: boolean; identity_scope: "user" | "project" }
  | {
      kind: "reuse";
      node_ref: string;
      reason:
        | "bound_source"
        | "explicit_alias"
        | "named_context"
        | "deictic_reference";
      evidence: QuoteRef[];
    };

export type ExtractInput = {
  schema: "butler.memory-extract-input.v2";
  episode_ref: string;
  revision: string;
  window_ref: string;
  bound_project_id: string | null;
  source_units: Array<{
    ref: string;
    text: string;
    role: "user" | "assistant" | "task" | "explicit";
    observed_at: string;
    origin_kind: MemoryOriginKind;
  }>;
  context_units: Array<{
    ref: string;
    text: string;
    observed_at: string;
    basis: MemoryBasis;
  }>;
  candidates: Array<{
    ref: string;
    type: MemoryNodeType;
    label: string;
    aliases: string[];
    scope: "user" | "project";
    project_id: string | null;
    // Older pinned inputs omit this field and remain immutable.
    claim?: {
      subject_ref: string | null;
      object_ref: string | null;
      relation: ExtractOutput["relations"][number]["relation"] | null;
      polarity: "positive" | "negative" | "unspecified" | null;
      condition: string | null;
    } | null;
    evidence: Array<{
      ref: string;
      text: string;
      observed_at: string;
      basis: MemoryBasis;
    }>;
  }>;
};

export type ExtractOutput = {
  schema: "butler.memory-extract-output.v2";
  window_ref: string;
  disposition: "processed" | "unsupported";
  covered_unit_refs: string[];
  nodes: Array<{
    local_ref: string;
    type: "entity" | "project";
    label: string;
    resolution: NodeResolution;
    aliases: Array<{ text: string; evidence: QuoteRef[] }>;
    evidence: QuoteRef[];
  }>;
  claims: Array<{
    local_ref: string;
    type: "preference" | "goal" | "constraint" | "decision" | "memory_atom";
    resolution: NodeResolution;
    statement: string;
    subject_ref: string | null;
    object_ref: string | null;
    speech_act: "assertion" | "question" | "proposal";
    basis: MemoryBasis;
    polarity: "positive" | "negative" | "unspecified";
    condition: string | null;
    valid_from: string | null;
    valid_to: string | null;
    salience: "high" | "normal" | "unspecified";
    evidence: QuoteRef[];
  }>;
  relations: Array<{
    from_ref: string;
    to_ref: string;
    relation:
      | "likes"
      | "dislikes"
      | "decided"
      | "belongs_to"
      | "depends_on"
      | "related_to";
    claim_ref: string;
    evidence: QuoteRef[];
  }>;
  corrections: Array<{
    previous_claim_ref: string;
    replacement_claim_ref: string;
    relation: "supersedes" | "contradicts";
    effective_at: string | null;
    evidence: QuoteRef[];
  }>;
  summary: { text: string; evidence: QuoteRef[] } | null;
};

export type ResolvedMemorySource = {
  source_ref: string;
  text: string;
  excerpt: string;
  byte_start: number;
  byte_end: number;
  source_hash: string;
  source_kind: "conversation" | "task_report" | "explicit_record";
  conversation_session_id: string | null;
  conversation_message_id: string | null;
  project_id?: string | null;
  basis: MemoryBasis;
  origin_kind: MemoryOriginKind;
  /** Canonical scalar retained inside the memory domain for v2 source pagination. */
  scalar_text?: string;
};
