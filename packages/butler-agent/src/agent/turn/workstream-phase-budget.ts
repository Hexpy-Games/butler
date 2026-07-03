import type { PromptUsageBudgetState } from "../../integrations/providers/provider.ts";
import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import type { WorkStreamResumeSelection } from "./workstream-checkpoint-resume-types.ts";

export const TOOL_CALL_BY_PHASE_METRIC_NAME = "tool_call_count_by_phase";
export const PHASE_BUDGET_EXHAUSTED_METRIC_NAME = "phase_budget_exhausted";

export const FOCUSED_RESUME_EXECUTION_PHASE = "phase_execution";
export const FOCUSED_RESUME_VALIDATION_REPAIR_PHASE = "validation_repair";

interface PhaseBudget {
  maxModelRequests: number;
  maxToolRounds: number;
  maxToolCalls: number;
  finalDeliveryReserveRequests: number;
}

interface PhaseCounts {
  modelRequests: number;
  toolCalls: number;
}

export interface WorkStreamPhaseBudgetController {
  readonly enabled: true;
  initialPromptPhase(): string;
  completionGapPhase(): string;
  maxToolRoundsForPhase(phase: string, requested?: number): number | undefined;
  budgetStateForPhase(phase: string, global: PromptUsageBudgetState): PromptUsageBudgetState;
  beforeModelRequest(input: {
    phase: string;
    roundIndex: number;
    globalBudgetState: PromptUsageBudgetState;
  }): void;
  recordToolCall(input: {
    phase: string;
    toolName: string;
  }): void;
  recordPhaseBudgetExhausted(input: {
    phase: string;
    reason: string;
  }): void;
}

const PHASE_BUDGETS: Record<string, PhaseBudget> = {
  [FOCUSED_RESUME_EXECUTION_PHASE]: {
    maxModelRequests: 6,
    maxToolRounds: 6,
    maxToolCalls: 24,
    finalDeliveryReserveRequests: 2,
  },
  [FOCUSED_RESUME_VALIDATION_REPAIR_PHASE]: {
    maxModelRequests: 2,
    maxToolRounds: 2,
    maxToolCalls: 8,
    finalDeliveryReserveRequests: 2,
  },
};

const DIMENSION_LIMIT = 80;

export function createWorkStreamPhaseBudgetController(input: {
  butlerData: string;
  resumeSelection: WorkStreamResumeSelection;
  role?: string;
  runtime?: string;
  model?: string;
}): WorkStreamPhaseBudgetController | null {
  if (input.resumeSelection.state !== "resume_selected" || !input.resumeSelection.selected) {
    return null;
  }

  const counts = new Map<string, PhaseCounts>();
  const exhaustedRecorded = new Set<string>();
  const selected = input.resumeSelection.selected;

  const controller: WorkStreamPhaseBudgetController = {
    enabled: true,

    initialPromptPhase(): string {
      return FOCUSED_RESUME_EXECUTION_PHASE;
    },

    completionGapPhase(): string {
      return FOCUSED_RESUME_VALIDATION_REPAIR_PHASE;
    },

    maxToolRoundsForPhase(phase, requested): number | undefined {
      const budget = PHASE_BUDGETS[phase];
      if (!budget) return requested;
      return requested === undefined
        ? budget.maxToolRounds
        : Math.max(1, Math.min(requested, budget.maxToolRounds));
    },

    budgetStateForPhase(phase, global): PromptUsageBudgetState {
      const budget = PHASE_BUDGETS[phase];
      if (!budget) return global;
      const count = phaseCounts(counts, phase).modelRequests;
      const spendableGlobal = Math.max(
        0,
        global.maxRequests - global.requestCount - budget.finalDeliveryReserveRequests,
      );
      const maxRequests = Math.max(0, Math.min(budget.maxModelRequests, count + spendableGlobal));
      const exhausted = global.status === "exhausted" || count >= maxRequests;
      if (exhausted) {
        controller.recordPhaseBudgetExhausted({
          phase,
          reason: global.status === "exhausted" ? "logical_turn_budget_exhausted" : "phase_model_budget_exhausted",
        });
      }
      return {
        ...global,
        status: exhausted ? "exhausted" : global.status,
        requestCount: count,
        maxRequests,
      };
    },

    beforeModelRequest({ phase, globalBudgetState }): void {
      const state = controller.budgetStateForPhase(phase, globalBudgetState);
      if (state.status === "exhausted" || state.requestCount >= state.maxRequests) {
        throw promptUsageModelCallBudgetExhaustedError();
      }
      const count = phaseCounts(counts, phase);
      count.modelRequests += 1;
    },

    recordToolCall({ phase, toolName }): void {
      const budget = PHASE_BUDGETS[phase];
      const count = phaseCounts(counts, phase);
      count.toolCalls += 1;
      const toolBudgetExceeded = Boolean(budget && count.toolCalls > budget.maxToolCalls);
      if (toolBudgetExceeded) {
        controller.recordPhaseBudgetExhausted({
          phase,
          reason: "phase_tool_call_budget_exhausted",
        });
      }
      recordOperationalMetric({
        category: "runtime",
        name: TOOL_CALL_BY_PHASE_METRIC_NAME,
        status: toolBudgetExceeded ? "error" : "ok",
        value: 1,
        unit: "tool_call",
        dimensions: {
          ...commonDimensions(input),
          phase: safeDimensionIdentifier(phase),
          toolName: safeDimensionIdentifier(toolName),
          toolCallCount: count.toolCalls,
          maxToolCalls: budget?.maxToolCalls,
          resumeSelectionState: input.resumeSelection.state,
          workStreamId: safeDimensionIdentifier(selected.id),
        },
      }, { butlerData: input.butlerData });
    },

    recordPhaseBudgetExhausted({ phase, reason }): void {
      const key = `${phase}:${reason}`;
      if (exhaustedRecorded.has(key)) return;
      exhaustedRecorded.add(key);
      const budget = PHASE_BUDGETS[phase];
      const count = phaseCounts(counts, phase);
      recordOperationalMetric({
        category: "runtime",
        name: PHASE_BUDGET_EXHAUSTED_METRIC_NAME,
        status: "error",
        value: 1,
        unit: "event",
        dimensions: {
          ...commonDimensions(input),
          phase: safeDimensionIdentifier(phase),
          reason: safeDimensionIdentifier(reason),
          modelRequestsUsed: count.modelRequests,
          maxModelRequests: budget?.maxModelRequests,
          toolCallsUsed: count.toolCalls,
          maxToolCalls: budget?.maxToolCalls,
          resumeSelectionState: input.resumeSelection.state,
          workStreamId: safeDimensionIdentifier(selected.id),
        },
      }, { butlerData: input.butlerData });
    },
  };

  return controller;
}

export function completionGapFingerprint(input: {
  kind: string;
  summary: string;
  refs?: Array<{ kind: string; id: string }>;
}): string {
  const refs = (input.refs ?? [])
    .map((ref) => `${ref.kind}:${ref.id}`)
    .sort()
    .join("|");
  return stableHash([
    input.kind.trim(),
    input.summary.trim(),
    refs,
  ].join("\n"));
}

export function promptUsageModelCallBudgetExhaustedError(): Error & { code: string } {
  const error = Object.assign(
    new Error("Prompt usage model-call budget exhausted before provider request"),
    { code: "prompt_usage_model_call_budget_exhausted" },
  );
  error.name = "PromptUsageModelCallBudgetExhaustedError";
  return error;
}

function phaseCounts(counts: Map<string, PhaseCounts>, phase: string): PhaseCounts {
  const current = counts.get(phase);
  if (current) return current;
  const next = { modelRequests: 0, toolCalls: 0 };
  counts.set(phase, next);
  return next;
}

function commonDimensions(input: {
  role?: string;
  runtime?: string;
  model?: string;
}) {
  return {
    role: safeDimensionIdentifier(input.role),
    runtime: safeDimensionIdentifier(input.runtime),
    model: safeDimensionIdentifier(input.model),
  };
}

function safeDimensionIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > DIMENSION_LIMIT) return undefined;
  if (/(prompt|message|transcript|query|url|uri|args?|arguments?|result|content|raw|secret|password|credential|apikey|api_key|key|token)/i.test(trimmed)) {
    return undefined;
  }
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(trimmed) ? trimmed : undefined;
}

function stableHash(value: string): string {
  let hash = 5381;
  for (const char of value) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}
