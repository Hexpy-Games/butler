export const RUNTIME_MEMORY_ATTRIBUTION_SCHEMA = "butler.agent-memory-attribution.v1" as const;

export type RuntimeMemoryAttributionEvent =
  | "turn_start"
  | "turn_end"
  | "model_call_start"
  | "model_call_end"
  | "model_call_failure"
  | "tool_call_start"
  | "tool_call_end"
  | "tool_call_failure"
  | "project_ledger_phase"
  | "terminal_state"
  | "idle_checkpoint"
  | "idle_pre_gc"
  | "idle_post_gc";

export type RuntimeMemoryAttributionTerminalState = "delivered" | "cancelled";

export type RuntimeMemoryAttributionProjectLedgerPhase =
  | "work_update"
  | "observe_base"
  | "source_head"
  | "prepare"
  | "materialize"
  | "copy"
  | "index"
  | "render_dashboard"
  | "render_handoff"
  | "render_roadmap"
  | "write_index"
  | "inspect_publication"
  | "promote"
  | "observe_promotion"
  | "observe_current_head"
  | "check";

export type RuntimeMemoryAttributionPhaseStatus = "start" | "end" | "failure";

export type RuntimeMemoryAttributionOperation =
  | "provider"
  | "command"
  | "web"
  | "filesystem"
  | "memory"
  | "project_ledger"
  | "work_tracking"
  | "other_tool"
  | "terminal"
  | "window"
  | "turn"
  | "other";

export type RuntimeMemoryAttributionOwnerCounts = {
  activeProviderStreams?: number;
  activeToolCalls?: number;
  activeTerminalProcesses?: number;
  activeLanceDbHandles?: number;
  activeFetchReaders?: number;
};

export type RuntimeMemoryAttributionCheckpoint = {
  event: RuntimeMemoryAttributionEvent;
  operation?: RuntimeMemoryAttributionOperation;
  durationMs?: number;
  iteration?: number;
  windowIndex?: number;
  terminalState?: RuntimeMemoryAttributionTerminalState;
  phase?: RuntimeMemoryAttributionProjectLedgerPhase;
  phaseStatus?: RuntimeMemoryAttributionPhaseStatus;
  ownerCounts?: RuntimeMemoryAttributionOwnerCounts;
};

export type RuntimeMemoryAttributionHeapCounters = {
  heapSizeBytes: number | null;
  heapCapacityBytes: number | null;
  extraMemoryBytes: number | null;
  objectCount: number | null;
};

export type RuntimeMemoryAttributionProcessCounters = {
  rssBytes: number | null;
  heapTotalBytes: number | null;
  heapUsedBytes: number | null;
  externalBytes: number | null;
  arrayBufferBytes: number | null;
};

export type RuntimeMemoryAttributionRecord = {
  schema: typeof RUNTIME_MEMORY_ATTRIBUTION_SCHEMA;
  sequence: number;
  monotonicMs: number;
  wallClockMs: number;
  event: RuntimeMemoryAttributionEvent;
  operation: RuntimeMemoryAttributionOperation;
  durationMs: number | null;
  iteration: number | null;
  windowIndex: number | null;
  terminalState: RuntimeMemoryAttributionTerminalState | null;
  phase: RuntimeMemoryAttributionProjectLedgerPhase | null;
  phaseStatus: RuntimeMemoryAttributionPhaseStatus | null;
  process: RuntimeMemoryAttributionProcessCounters;
  heap: RuntimeMemoryAttributionHeapCounters;
  ownerCounts: RuntimeMemoryAttributionOwnerCounts;
  gcProbe: "before" | "after" | null;
};

export interface RuntimeMemoryAttributionPort {
  checkpoint(input: RuntimeMemoryAttributionCheckpoint): void;
  projectLedgerPhase(input: {
    phase: RuntimeMemoryAttributionProjectLedgerPhase;
    status: RuntimeMemoryAttributionPhaseStatus;
    durationMs?: number;
  }): void;
  terminal(state: RuntimeMemoryAttributionTerminalState): void;
  close(): void;
}
