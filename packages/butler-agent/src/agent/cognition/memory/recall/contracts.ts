import type { MemoryExecutionContext } from "../projection/contracts.ts";

export type RecallScope =
  | "current_session"
  | "current_project"
  | "all_user_sessions";
export type RecallProjectFilter = "any" | "unassigned" | "selected";

export type RecallTime = {
  from: string;
  to: string;
  basis: "conversation" | "event";
};

export type RuntimeRecallContext = {
  sessionId: string;
  turnId: string;
  currentUserMessage: string;
  nativeOperationId: string;
  projectId: string | null;
};

export type RecallMemoryInput = {
  context: MemoryExecutionContext;
  cue: string;
  seedPhrases?: string[];
  vectorQueries?: string[];
  includeVector: boolean;
  includeInternal: boolean;
  limit: number;
  scope: RecallScope;
  projectFilter: RecallProjectFilter;
  projectIds: string[];
  sessionIds: string[];
  asOf: string;
  asOfExplicit?: boolean;
  time?: RecallTime;
  cursor?: string;
  /** Admission-snapshot v1 execution controls; absent for the public v2 contract. */
  admittedChannels?: {
    graph: boolean;
    lexical: boolean;
    vector: boolean;
    context: boolean;
    explicit: boolean;
    task: boolean;
  };
  runtime: RuntimeRecallContext;
};

export type RecallCoverageState =
  | "ok"
  | "partial"
  | "unavailable"
  | "disabled_by_request";
export type RecallChannel =
  | "graph"
  | "lexical"
  | "vector"
  | "context"
  | "explicit";

export type RecallAssociationStep = {
  from: string;
  relation: string;
  to: string;
  traversed_reverse: boolean;
};

export type RecallMemoryResult = {
  status: "complete" | "partial" | "unavailable";
  results: Array<{
    episode_ref: string;
    revision: string;
    summary: string;
    occurred_at: string | null;
    conversation_at: string | null;
    channels: RecallChannel[];
    matched_node_ref: string | null;
    association_path: RecallAssociationStep[];
    evidence: Array<{
      source_ref: string;
      basis: string;
      excerpt: string;
      source_resolved: true;
      conversation_session_id: string | null;
      conversation_message_id: string | null;
      source_kind?: "conversation" | "task_report" | "explicit_record";
      support: { node_ref: string; relation: "mentions" | "supports" };
      read_args: {
        scope: RecallScope;
        source_ref: string;
        max_chars: number;
        session_ids?: string[];
        project_filter?: RecallProjectFilter;
        project_ids?: string[];
        include_internal?: boolean;
      };
    }>;
    requirements?: Array<{ node_ref: string; action: string; condition: import("../projection/meaning.ts").Condition<string>; basis: string; source_refs: string[] }>;
    interpretations?: Array<{
      node_ref: string; statement: string; speech_act: string; basis: string;
      source_class: import("../projection/claim-store.ts").SourceClass;
      authority: "model_interpretation"; source_refs: string[]; support_complete: boolean;
      status: "recorded" | "historical" | "superseded" | "conflicted" | "refined";
    }>;
    current_state_requires_verification?: true;
    qualifications: string[];
  }>;
  coverage: {
    graph: { state: RecallCoverageState; candidates: number; codes: string[] };
    vectors: {
      state: RecallCoverageState;
      candidates: number;
      codes: string[];
    };
    source: { state: RecallCoverageState; candidates: number; codes: string[] };
  };
  next_cursor: string | null;
  diagnostics: string[];
};

export type SeedCandidate = {
  nodeId: string;
  channel: "alias" | "lexical" | "vector" | "context" | "temporal";
  rank: number;
  score: number;
};

export type RecallEdge = {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: string;
  claimNodeId: string | null;
  support: number;
};

export type RecallMention = {
  nodeId: string;
  sourceId: string;
  episodeId: string;
  revision: string;
  relation?: "mentions" | "supports";
};
