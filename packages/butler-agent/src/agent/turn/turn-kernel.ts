export type TurnState =
  | "accepted"
  | "model_deciding"
  | "announcing_intent"
  | "executing_tools"
  | "observing_tools"
  | "continuing"
  | "waiting_user"
  | "completed"
  | "failed"
  | "aborted"
  | "runtime_fault";

export type TerminalTurnState =
  | "waiting_user"
  | "completed"
  | "failed"
  | "aborted"
  | "runtime_fault";

export const TERMINAL_TURN_STATES: ReadonlySet<TerminalTurnState> = new Set([
  "waiting_user",
  "completed",
  "failed",
  "aborted",
  "runtime_fault",
]);

export type ObservationKind =
  | "tool_result"
  | "tool_invalid_arguments"
  | "tool_unavailable"
  | "command_failed"
  | "test_failed"
  | "validation_failed"
  | "completion_gap"
  | "public_decision_required"
  | "context_compacted"
  | "user_input"
  | "user_cancelled";

export type ObservationVisibility = "model" | "public" | "operator";

export interface TurnObservation {
  observationId: string;
  turnId: string;
  kind: ObservationKind;
  visibility: ObservationVisibility;
  summary: string;
  modelVisibleContent: string;
  publicSummary?: string;
  refs?: Array<{ kind: string; id: string; path?: string }>;
  causedByToolCallId?: string;
  causedByDecisionId?: string;
  createdAt: string;
}

export type AssistantDecisionSource = "assistant-authored" | "model-authored" | "principal-authored";

export interface AssistantDecisionEvent {
  kind: "assistant.decision";
  turnId: string;
  decisionId: string;
  source: AssistantDecisionSource;
  summary: string;
  rationale: string;
  nextStep: string;
  appliesToToolCallIds?: string[];
  evidenceRefs?: string[];
  createdAt: string;
}

export type RuntimeFaultKind =
  | "runtime_process_crash"
  | "provider_stream_corruption"
  | "storage_invariant_violation"
  | "api_protocol_invariant_violation"
  | "queue_claim_invariant_violation"
  | "compaction_invariant_violation";

export interface RuntimeFault {
  turnId: string;
  faultId: string;
  kind: RuntimeFaultKind;
  retryable: boolean;
  publicSummary: string;
  operatorSummary: string;
  recoveryToken?: string;
  createdAt: string;
}

export type TurnOutcome = TerminalTurnState;

export interface TurnStateTransition {
  from: TurnState;
  to: TurnState;
}

export interface KernelTerminalOutcomeTransition {
  from: TurnState;
  to: TerminalTurnState;
  reason: string;
  evidenceRefs: string[];
}

const KERNEL_TRANSITIONS: Record<TurnState, ReadonlySet<TurnState>> = {
  accepted: new Set(["model_deciding", "waiting_user", "aborted", "runtime_fault"]),
  model_deciding: new Set([
    "announcing_intent",
    "observing_tools",
    "continuing",
    "completed",
    "failed",
    "waiting_user",
    "runtime_fault",
    "aborted",
  ]),
  announcing_intent: new Set([
    "executing_tools",
    "observing_tools",
    "model_deciding",
    "continuing",
    "completed",
    "failed",
    "waiting_user",
    "runtime_fault",
    "aborted",
  ]),
  executing_tools: new Set([
    "observing_tools",
    "continuing",
    "failed",
    "aborted",
    "runtime_fault",
    "waiting_user",
  ]),
  observing_tools: new Set([
    "model_deciding",
    "continuing",
    "completed",
    "failed",
    "waiting_user",
    "runtime_fault",
    "aborted",
  ]),
  continuing: new Set([
    "model_deciding",
    "failed",
    "waiting_user",
    "runtime_fault",
    "aborted",
  ]),
  waiting_user: new Set([]),
  completed: new Set([]),
  failed: new Set([]),
  aborted: new Set([]),
  runtime_fault: new Set([]),
};

export function isTerminalTurnState(state: TurnState): state is TerminalTurnState {
  return TERMINAL_TURN_STATES.has(state as TerminalTurnState);
}

export function isAllowedTurnStateTransition(from: TurnState, to: TurnState): boolean {
  return KERNEL_TRANSITIONS[from]?.has(to) === true;
}

export function assertTurnStateTransition(input: TurnStateTransition): TurnState {
  if (!isAllowedTurnStateTransition(input.from, input.to)) {
    throw new Error(`invalid turn state transition ${input.from} -> ${input.to}`);
  }
  return input.to;
}

export function terminalizeTurnThroughKernel(
  input: KernelTerminalOutcomeTransition,
): KernelTerminalOutcomeTransition {
  assertTurnStateTransition(input);
  if (!isTerminalTurnState(input.to)) {
    throw new Error(`turn kernel terminalization requires terminal state: ${input.to}`);
  }
  if (input.reason.trim().length === 0) {
    throw new Error("turn kernel terminalization requires an explicit reason");
  }
  return {
    from: input.from,
    to: input.to,
    reason: input.reason,
    evidenceRefs: Array.from(new Set(input.evidenceRefs)),
  };
}
