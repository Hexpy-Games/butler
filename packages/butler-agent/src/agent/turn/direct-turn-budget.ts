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

export type DirectTurnBudgetPartition = "execution" | "review" | "finalization";

const DIRECT_TURN_REQUEST_OUTPUT_LIMITS: Record<DirectTurnBudgetPartition, number> = {
  execution: 4_096,
  review: 2_048,
  finalization: 8_192,
};

export function directTurnRequestedOutputTokens(partition: DirectTurnBudgetPartition): number {
  return DIRECT_TURN_REQUEST_OUTPUT_LIMITS[partition];
}

interface DirectTurnPartitionBudget {
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

export interface DirectTurnCumulativeUsage {
  modelRequestsUsed: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const DIRECT_TURN_PARTITION_LIMITS: Record<DirectTurnBudgetPartition, Pick<
  DirectTurnPartitionBudget,
  "maxModelCalls" | "maxPromptTokens" | "maxOutputTokens" | "maxTotalTokens"
>> = {
  execution: { maxModelCalls: 24, maxPromptTokens: 160_000, maxOutputTokens: 50_000, maxTotalTokens: 210_000 },
  review: { maxModelCalls: 4, maxPromptTokens: 30_000, maxOutputTokens: 10_000, maxTotalTokens: 40_000 },
  finalization: { maxModelCalls: 4, maxPromptTokens: 30_000, maxOutputTokens: 20_000, maxTotalTokens: 50_000 },
};

export interface DirectTurnBudget {
  turnId: string;
  executionSlice: number;
  modelRequestsUsed: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxModelCalls: number;
  maxPromptTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  cumulativeUsage: DirectTurnCumulativeUsage;
  partitions: Record<DirectTurnBudgetPartition, DirectTurnPartitionBudget>;
}

export interface DirectTurnBudgetSnapshot {
  turnId: string;
  executionSlice?: number;
  modelRequestsUsed: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxModelCalls: number;
  maxPromptTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  cumulativeUsage?: DirectTurnCumulativeUsage;
  partitions?: Record<DirectTurnBudgetPartition, DirectTurnPartitionBudget>;
}

export interface DirectTurnPromptUsageInput {
  promptContextChars: number;
  promptContextSections?: Array<{
    id: string;
    chars: number;
  }>;
  compactionContextChars: number;
  feedbackBufferContextChars: number;
  workingMemoryContextChars: number;
  recentConversationChars: number;
  recallContextChars: number;
  inboundMessageChars: number;
  focusedResumeEnvelopeChars?: number;
  resumeDecisionEnvelopeChars?: number;
}

export function createDirectTurnBudget(turnId: string): DirectTurnBudget {
  return {
    turnId,
    executionSlice: 1,
    modelRequestsUsed: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxModelCalls: DIRECT_TURN_MODEL_CALL_BUDGET,
    maxPromptTokens: DIRECT_TURN_PROMPT_TOKEN_BUDGET,
    maxOutputTokens: DIRECT_TURN_OUTPUT_TOKEN_BUDGET,
    maxTotalTokens: DIRECT_TURN_TOTAL_TOKEN_BUDGET,
    cumulativeUsage: emptyCumulativeUsage(),
    partitions: createPartitionBudgets(),
  };
}

export function snapshotDirectTurnBudget(budget: DirectTurnBudget): DirectTurnBudgetSnapshot {
  return {
    turnId: budget.turnId,
    executionSlice: budget.executionSlice,
    modelRequestsUsed: budget.modelRequestsUsed,
    promptTokens: budget.promptTokens,
    cachedTokens: budget.cachedTokens,
    outputTokens: budget.outputTokens,
    totalTokens: budget.totalTokens,
    maxModelCalls: budget.maxModelCalls,
    maxPromptTokens: budget.maxPromptTokens,
    maxOutputTokens: budget.maxOutputTokens,
    maxTotalTokens: budget.maxTotalTokens,
    cumulativeUsage: structuredClone(budget.cumulativeUsage),
    partitions: structuredClone(budget.partitions),
  };
}

export function snapshotDirectTurnBudgetForRollover(
  budget: DirectTurnBudget,
): DirectTurnBudgetSnapshot {
  const snapshot = snapshotDirectTurnBudget(budget);
  return {
    ...snapshot,
    executionSlice: budget.executionSlice + 1,
    modelRequestsUsed: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    partitions: Object.fromEntries(
      (Object.entries(budget.partitions) as Array<[
        DirectTurnBudgetPartition,
        DirectTurnPartitionBudget,
      ]>).map(([name, partition]) => [name, {
        ...partition,
        modelRequestsUsed: 0,
        promptTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }]),
    ) as Record<DirectTurnBudgetPartition, DirectTurnPartitionBudget>,
  };
}

export function canRolloverDirectTurnBudget(
  budget: DirectTurnBudget,
  error: unknown,
): boolean {
  if (!sliceHasAdmittedUsage(budget)) return false;
  const detail = budgetErrorDetail(error);
  if (detail?.rolloverEligible === false) return false;
  const partitionName = detail?.partition ?? "execution";
  const partition = budget.partitions[partitionName];
  const projectedPromptTokens = finiteNonNegativeInteger(detail?.admittedPromptTokens ?? 0);
  const projectedOutputTokens = finiteNonNegativeInteger(detail?.requestedOutputTokens ?? 0);
  return requestFitsEmptySlice({
    budget,
    partition,
    projectedPromptTokens,
    projectedOutputTokens,
  });
}

export function hydrateDirectTurnBudget(
  turnId: string,
  snapshot?: DirectTurnBudgetSnapshot | null,
): DirectTurnBudget {
  const budget = createDirectTurnBudget(turnId);
  if (!snapshot || typeof snapshot !== "object") return budget;
  budget.executionSlice = finitePositiveInteger(snapshot.executionSlice ?? 1, 1);
  budget.modelRequestsUsed = finiteNonNegativeInteger(snapshot.modelRequestsUsed);
  budget.promptTokens = finiteNonNegativeInteger(snapshot.promptTokens);
  budget.cachedTokens = Math.min(
    finiteNonNegativeInteger(snapshot.cachedTokens),
    budget.promptTokens,
  );
  budget.outputTokens = finiteNonNegativeInteger(snapshot.outputTokens);
  budget.totalTokens = finiteNonNegativeInteger(snapshot.totalTokens);
  budget.maxModelCalls = finitePositiveInteger(snapshot.maxModelCalls, budget.maxModelCalls);
  budget.maxPromptTokens = finitePositiveInteger(snapshot.maxPromptTokens, budget.maxPromptTokens);
  budget.maxOutputTokens = finitePositiveInteger(snapshot.maxOutputTokens, budget.maxOutputTokens);
  budget.maxTotalTokens = finitePositiveInteger(snapshot.maxTotalTokens, budget.maxTotalTokens);
  budget.cumulativeUsage = hydrateCumulativeUsage(snapshot.cumulativeUsage, budget);
  budget.partitions = hydratePartitionBudgets(snapshot.partitions, budget);
  return budget;
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
    cumulativeRequestCount: budget.cumulativeUsage.modelRequestsUsed,
    cumulativePromptTokens: budget.cumulativeUsage.promptTokens,
    cumulativeCachedTokens: budget.cumulativeUsage.cachedTokens,
    cumulativeOutputTokens: budget.cumulativeUsage.outputTokens,
    cumulativeTotalTokens: budget.cumulativeUsage.totalTokens,
  };
}

export function beforeDirectTurnModelRequest(
  budget: DirectTurnBudget,
  input: {
    partition?: DirectTurnBudgetPartition;
    admittedPromptTokens?: number;
    requestedOutputTokens?: number;
    beforeCommit?: () => void;
  } = {},
): void {
  const partitionName = input.partition ?? "execution";
  const partition = budget.partitions[partitionName];
  const projectedPromptTokens = finiteNonNegativeInteger(input.admittedPromptTokens ?? 0);
  const projectedOutputTokens = finiteNonNegativeInteger(input.requestedOutputTokens ?? 0);
  assertRequestFitsBudget({
    budget,
    partition,
    partitionName,
    projectedPromptTokens,
    projectedOutputTokens,
  });
  input.beforeCommit?.();
  budget.modelRequestsUsed += 1;
  budget.cumulativeUsage.modelRequestsUsed += 1;
  partition.modelRequestsUsed += 1;
}

export function directTurnPartitionBudgetState(
  budget: DirectTurnBudget,
  partition: DirectTurnBudgetPartition,
): PromptUsageBudgetState {
  const state = budget.partitions[partition];
  return {
    status: partitionBudgetStatus(state),
    requestCount: state.modelRequestsUsed,
    maxRequests: state.maxModelCalls,
    promptTokens: state.promptTokens,
    cachedTokens: state.cachedTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.totalTokens,
    maxPromptTokens: state.maxPromptTokens,
    maxOutputTokens: state.maxOutputTokens,
    maxTotalTokens: state.maxTotalTokens,
  };
}

export function hasDirectTurnModelRequestReserve(
  budget: DirectTurnBudget,
  reserveRequests: number,
): boolean {
  return directTurnModelRequestsRemaining(budget) > reserveRequests;
}

export function directTurnModelRequestsRemaining(
  budget: DirectTurnBudget,
): number {
  return Math.max(
    0,
    budget.maxModelCalls - budget.modelRequestsUsed,
  );
}

export function directTurnPartitionModelRequestsRemaining(
  budget: DirectTurnBudget,
  partition: DirectTurnBudgetPartition,
): number {
  const state = budget.partitions[partition];
  return Math.max(0, state.maxModelCalls - state.modelRequestsUsed);
}

export function addDirectTurnUsage(input: {
  budget: DirectTurnBudget;
  promptTokens: number | null;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number | null;
  partition?: DirectTurnBudgetPartition;
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
  input.budget.cumulativeUsage.promptTokens += promptTokens;
  input.budget.cumulativeUsage.cachedTokens += cachedTokens;
  input.budget.cumulativeUsage.outputTokens += outputTokens;
  input.budget.cumulativeUsage.totalTokens += totalTokens;
  const partition = input.budget.partitions[input.partition ?? "execution"];
  partition.promptTokens += promptTokens;
  partition.cachedTokens += cachedTokens;
  partition.outputTokens += outputTokens;
  partition.totalTokens += totalTokens;
}

export function promptUsageSectionsFromPrompt(
  input: DirectTurnPromptUsageInput,
): PromptUsageSectionAttribution[] {
  const promptContextSections = granularPromptContextSections(input);
  const sections = [
    ...promptContextSections,
    ["compaction_context", input.compactionContextChars],
    ["feedback_buffer", input.feedbackBufferContextChars],
    ["working_memory", input.workingMemoryContextChars],
    ["recent_conversation", input.recentConversationChars],
    ["recall_context", input.recallContextChars],
    ["inbound_message", input.inboundMessageChars],
    ["focused_resume_envelope", input.focusedResumeEnvelopeChars ?? 0],
    ["resume_decision_envelope", input.resumeDecisionEnvelopeChars ?? 0],
  ] as const;
  return sections
    .filter(([, chars]) => chars > 0)
    .map(([id, chars]) => ({
      id,
      chars,
      estimatedTokens: estimateContextTokens(chars),
    }));
}

function granularPromptContextSections(input: DirectTurnPromptUsageInput): Array<[string, number]> {
  const sections = (input.promptContextSections ?? [])
    .filter((section) => section.id.trim() && section.chars > 0)
    .map((section) => [section.id.trim(), section.chars] as [string, number]);
  if (sections.length === 0) return [["prompt_context", input.promptContextChars]];
  const attributedChars = sections.reduce((sum, [, chars]) => sum + chars, 0);
  const remainder = Math.max(0, input.promptContextChars - attributedChars);
  return remainder > 0
    ? [...sections, ["prompt_context_other", remainder]]
    : sections;
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
  const requests = budget.modelRequestsUsed;
  const promptTokens = budget.promptTokens;
  const outputTokens = budget.outputTokens;
  const totalTokens = budget.totalTokens;
  if (
    requests >= budget.maxModelCalls ||
    promptTokens >= budget.maxPromptTokens ||
    outputTokens >= budget.maxOutputTokens ||
    totalTokens >= budget.maxTotalTokens
  ) {
    return "exhausted";
  }
  if (
    requests >= Math.floor(budget.maxModelCalls * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    promptTokens >= Math.floor(budget.maxPromptTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    outputTokens >= Math.floor(budget.maxOutputTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    totalTokens >= Math.floor(budget.maxTotalTokens * DIRECT_TURN_BUDGET_WARNING_RATIO)
  ) {
    return "warning";
  }
  return "ok";
}

function createPartitionBudgets(): Record<DirectTurnBudgetPartition, DirectTurnPartitionBudget> {
  return Object.fromEntries(
    (Object.entries(DIRECT_TURN_PARTITION_LIMITS) as Array<[
      DirectTurnBudgetPartition,
      typeof DIRECT_TURN_PARTITION_LIMITS[DirectTurnBudgetPartition],
    ]>).map(([name, limits]) => [name, {
      modelRequestsUsed: 0,
      promptTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      ...limits,
    }]),
  ) as Record<DirectTurnBudgetPartition, DirectTurnPartitionBudget>;
}

function emptyCumulativeUsage(): DirectTurnCumulativeUsage {
  return {
    modelRequestsUsed: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function hydrateCumulativeUsage(
  snapshot: DirectTurnCumulativeUsage | undefined,
  budget: DirectTurnBudget,
): DirectTurnCumulativeUsage {
  if (!snapshot) {
    return {
      modelRequestsUsed: budget.modelRequestsUsed,
      promptTokens: budget.promptTokens,
      cachedTokens: budget.cachedTokens,
      outputTokens: budget.outputTokens,
      totalTokens: budget.totalTokens,
    };
  }
  const promptTokens = Math.max(
    budget.promptTokens,
    finiteNonNegativeInteger(snapshot.promptTokens),
  );
  const outputTokens = Math.max(
    budget.outputTokens,
    finiteNonNegativeInteger(snapshot.outputTokens),
  );
  return {
    modelRequestsUsed: Math.max(
      budget.modelRequestsUsed,
      finiteNonNegativeInteger(snapshot.modelRequestsUsed),
    ),
    promptTokens,
    cachedTokens: Math.min(
      promptTokens,
      Math.max(budget.cachedTokens, finiteNonNegativeInteger(snapshot.cachedTokens)),
    ),
    outputTokens,
    totalTokens: Math.max(
      budget.totalTokens,
      finiteNonNegativeInteger(snapshot.totalTokens),
      promptTokens + outputTokens,
    ),
  };
}

function hydratePartitionBudgets(
  snapshot: DirectTurnBudgetSnapshot["partitions"],
  budget: DirectTurnBudget,
): Record<DirectTurnBudgetPartition, DirectTurnPartitionBudget> {
  const partitions = createPartitionBudgets();
  if (!snapshot) {
    partitions.execution.modelRequestsUsed = budget.modelRequestsUsed;
    partitions.execution.promptTokens = budget.promptTokens;
    partitions.execution.cachedTokens = budget.cachedTokens;
    partitions.execution.outputTokens = budget.outputTokens;
    partitions.execution.totalTokens = budget.totalTokens;
    return partitions;
  }
  for (const name of Object.keys(partitions) as DirectTurnBudgetPartition[]) {
    const source = snapshot[name];
    if (!source) continue;
    const target = partitions[name];
    target.modelRequestsUsed = finiteNonNegativeInteger(source.modelRequestsUsed);
    target.promptTokens = finiteNonNegativeInteger(source.promptTokens);
    target.cachedTokens = Math.min(finiteNonNegativeInteger(source.cachedTokens), target.promptTokens);
    target.outputTokens = finiteNonNegativeInteger(source.outputTokens);
    target.totalTokens = finiteNonNegativeInteger(source.totalTokens);
    target.maxModelCalls = finitePositiveInteger(source.maxModelCalls, target.maxModelCalls);
    target.maxPromptTokens = finitePositiveInteger(source.maxPromptTokens, target.maxPromptTokens);
    target.maxOutputTokens = finitePositiveInteger(source.maxOutputTokens, target.maxOutputTokens);
    target.maxTotalTokens = finitePositiveInteger(source.maxTotalTokens, target.maxTotalTokens);
  }
  return partitions;
}

function partitionBudgetStatus(partition: DirectTurnPartitionBudget): PromptUsageBudgetState["status"] {
  if (
    partition.modelRequestsUsed >= partition.maxModelCalls ||
    partition.promptTokens >= partition.maxPromptTokens ||
    partition.outputTokens >= partition.maxOutputTokens ||
    partition.totalTokens >= partition.maxTotalTokens
  ) return "exhausted";
  if (
    partition.modelRequestsUsed >= Math.floor(partition.maxModelCalls * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    partition.promptTokens >= Math.floor(partition.maxPromptTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    partition.outputTokens >= Math.floor(partition.maxOutputTokens * DIRECT_TURN_BUDGET_WARNING_RATIO) ||
    partition.totalTokens >= Math.floor(partition.maxTotalTokens * DIRECT_TURN_BUDGET_WARNING_RATIO)
  ) return "warning";
  return "ok";
}

function assertRequestFitsBudget(input: {
  budget: DirectTurnBudget;
  partition: DirectTurnPartitionBudget;
  partitionName: DirectTurnBudgetPartition;
  projectedPromptTokens: number;
  projectedOutputTokens: number;
}): void {
  const projectedTotalTokens = input.projectedPromptTokens + input.projectedOutputTokens;
  const exhausted =
    input.budget.modelRequestsUsed + 1 > input.budget.maxModelCalls ||
    input.budget.promptTokens + input.projectedPromptTokens > input.budget.maxPromptTokens ||
    input.budget.outputTokens + input.projectedOutputTokens > input.budget.maxOutputTokens ||
    input.budget.totalTokens + projectedTotalTokens > input.budget.maxTotalTokens ||
    input.partition.modelRequestsUsed + 1 > input.partition.maxModelCalls ||
    input.partition.promptTokens + input.projectedPromptTokens > input.partition.maxPromptTokens ||
    input.partition.outputTokens + input.projectedOutputTokens > input.partition.maxOutputTokens ||
    input.partition.totalTokens + projectedTotalTokens > input.partition.maxTotalTokens;
  if (!exhausted) return;
  const rolloverEligible = sliceHasAdmittedUsage(input.budget) && requestFitsEmptySlice({
    budget: input.budget,
    partition: input.partition,
    projectedPromptTokens: input.projectedPromptTokens,
    projectedOutputTokens: input.projectedOutputTokens,
  });
  const error = Object.assign(
    new Error("Prompt usage model-call budget exhausted before provider request"),
    {
      code: "prompt_usage_model_call_budget_exhausted",
      partition: input.partitionName,
      admittedPromptTokens: input.projectedPromptTokens,
      requestedOutputTokens: input.projectedOutputTokens,
      rolloverEligible,
    },
  );
  error.name = "PromptUsageModelCallBudgetExhaustedError";
  throw error;
}

function sliceHasAdmittedUsage(budget: DirectTurnBudget): boolean {
  return budget.modelRequestsUsed > 0 ||
    budget.promptTokens > 0 ||
    budget.outputTokens > 0 ||
    budget.totalTokens > 0;
}

function requestFitsEmptySlice(input: {
  budget: DirectTurnBudget;
  partition: DirectTurnPartitionBudget;
  projectedPromptTokens: number;
  projectedOutputTokens: number;
}): boolean {
  const projectedTotalTokens = input.projectedPromptTokens + input.projectedOutputTokens;
  return 1 <= input.budget.maxModelCalls &&
    input.projectedPromptTokens <= input.budget.maxPromptTokens &&
    input.projectedOutputTokens <= input.budget.maxOutputTokens &&
    projectedTotalTokens <= input.budget.maxTotalTokens &&
    1 <= input.partition.maxModelCalls &&
    input.projectedPromptTokens <= input.partition.maxPromptTokens &&
    input.projectedOutputTokens <= input.partition.maxOutputTokens &&
    projectedTotalTokens <= input.partition.maxTotalTokens;
}

function budgetErrorDetail(error: unknown): {
  partition?: DirectTurnBudgetPartition;
  admittedPromptTokens?: number;
  requestedOutputTokens?: number;
  rolloverEligible?: boolean;
} | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const partition = record.partition === "execution" ||
      record.partition === "review" ||
      record.partition === "finalization"
    ? record.partition
    : undefined;
  return {
    ...(partition ? { partition } : {}),
    ...(typeof record.admittedPromptTokens === "number"
      ? { admittedPromptTokens: record.admittedPromptTokens }
      : {}),
    ...(typeof record.requestedOutputTokens === "number"
      ? { requestedOutputTokens: record.requestedOutputTokens }
      : {}),
    ...(typeof record.rolloverEligible === "boolean"
      ? { rolloverEligible: record.rolloverEligible }
      : {}),
  };
}

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finitePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
