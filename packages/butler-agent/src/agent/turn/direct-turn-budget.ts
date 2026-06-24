import type {
  PromptUsageBudgetState,
  PromptUsageSectionAttribution,
} from "../../integrations/providers/provider.ts";
import { estimateContextTokens } from "../context/budget.ts";

const DIRECT_TURN_MODEL_CALL_BUDGET = 32;
const DIRECT_TURN_PROMPT_TOKEN_BUDGET = 220_000;
const DIRECT_TURN_OUTPUT_TOKEN_BUDGET = 80_000;
const DIRECT_TURN_TOTAL_TOKEN_BUDGET = 300_000;
const DIRECT_TURN_BUDGET_WARNING_RATIO = 0.8;
const COMPACT_RECENT_CONVERSATION_TOKEN_BUDGET = 2_000;

export interface DirectTurnBudget {
  turnId: string;
  modelRequestsUsed: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxModelCalls: number;
  maxPromptTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
}

export interface DirectTurnPromptUsageInput {
  promptContextChars: number;
  compactionContextChars: number;
  feedbackBufferContextChars: number;
  workingMemoryContextChars: number;
  recentConversationChars: number;
  recallContextChars: number;
  inboundMessageChars: number;
}

export function createDirectTurnBudget(turnId: string): DirectTurnBudget {
  return {
    turnId,
    modelRequestsUsed: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxModelCalls: DIRECT_TURN_MODEL_CALL_BUDGET,
    maxPromptTokens: DIRECT_TURN_PROMPT_TOKEN_BUDGET,
    maxOutputTokens: DIRECT_TURN_OUTPUT_TOKEN_BUDGET,
    maxTotalTokens: DIRECT_TURN_TOTAL_TOKEN_BUDGET,
  };
}

export function directTurnBudgetState(budget: DirectTurnBudget): PromptUsageBudgetState {
  return {
    status: directTurnBudgetStatus(budget),
    requestCount: budget.modelRequestsUsed,
    maxRequests: budget.maxModelCalls,
    promptTokens: budget.promptTokens,
    cachedTokens: budget.cachedTokens,
    outputTokens: budget.outputTokens,
    totalTokens: budget.totalTokens,
    maxPromptTokens: budget.maxPromptTokens,
    maxOutputTokens: budget.maxOutputTokens,
    maxTotalTokens: budget.maxTotalTokens,
  };
}

export function beforeDirectTurnModelRequest(budget: DirectTurnBudget): void {
  budget.modelRequestsUsed += 1;
}

export function addDirectTurnUsage(input: {
  budget: DirectTurnBudget;
  promptTokens: number | null;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number | null;
}): void {
  const promptTokens = typeof input.promptTokens === "number" && Number.isFinite(input.promptTokens)
    ? Math.max(0, input.promptTokens)
    : 0;
  const cachedTokens = Number.isFinite(input.cachedTokens)
    ? Math.max(0, Math.min(input.cachedTokens, promptTokens))
    : 0;
  const outputTokens = Number.isFinite(input.outputTokens) ? Math.max(0, input.outputTokens) : 0;
  const totalTokens = typeof input.totalTokens === "number" && Number.isFinite(input.totalTokens)
    ? Math.max(0, input.totalTokens)
    : promptTokens + outputTokens;
  input.budget.promptTokens += promptTokens;
  input.budget.cachedTokens += cachedTokens;
  input.budget.outputTokens += outputTokens;
  input.budget.totalTokens += totalTokens;
}

export function promptUsageSectionsFromPrompt(
  input: DirectTurnPromptUsageInput,
): PromptUsageSectionAttribution[] {
  const sections = [
    ["prompt_context", input.promptContextChars],
    ["compaction_context", input.compactionContextChars],
    ["feedback_buffer", input.feedbackBufferContextChars],
    ["working_memory", input.workingMemoryContextChars],
    ["recent_conversation", input.recentConversationChars],
    ["recall_context", input.recallContextChars],
    ["inbound_message", input.inboundMessageChars],
  ] as const;
  return sections
    .filter(([, chars]) => chars > 0)
    .map(([id, chars]) => ({
      id,
      chars,
      estimatedTokens: estimateContextTokens("x".repeat(Math.min(chars, 200_000))),
    }));
}

export function recentConversationBudgetForTurn(input: {
  configuredBudget: number;
  compactionContext: string;
}): number {
  if (input.compactionContext.trim()) {
    return Math.min(input.configuredBudget, COMPACT_RECENT_CONVERSATION_TOKEN_BUDGET);
  }
  return input.configuredBudget;
}

function directTurnBudgetStatus(budget: DirectTurnBudget): PromptUsageBudgetState["status"] {
  if (budget.modelRequestsUsed >= budget.maxModelCalls) {
    return "exhausted";
  }
  if (
    budget.modelRequestsUsed >= Math.floor(budget.maxModelCalls * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    budget.promptTokens >= Math.floor(budget.maxPromptTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    budget.outputTokens >= Math.floor(budget.maxOutputTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    budget.totalTokens >= Math.floor(budget.maxTotalTokens * DIRECT_TURN_BUDGET_WARNING_RATIO)
  ) {
    return "warning";
  }
  return "ok";
}
