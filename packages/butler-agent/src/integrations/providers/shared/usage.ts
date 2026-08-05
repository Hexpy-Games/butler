import type {
  CodexSseAccumulator,
  OpenAIResponse,
  PromptCacheStats,
  PromptUsageAttribution,
  PromptUsageReport,
  ProviderStreamProjectionChunk,
} from "../runtime-contracts.ts";
import { appendPromptUsageMetric } from "../prompt-cache-metrics.ts";
import { MAX_TOOL_ROUNDS } from "./environment.ts";
import { localFinalAnswerEnvelope } from "./tools.ts";

export async function emitProviderStreamProjectionBestEffort(
  accumulator: CodexSseAccumulator,
  chunk: ProviderStreamProjectionChunk,
): Promise<void> {
  try {
    await accumulator.onProviderStreamEvent?.(chunk);
  } catch {
    // Stream projection is observational only. Provider/model failures still
    // propagate through the SSE event handlers above, but sink failures must
    // not abort, retry, or alter final response reconstruction.
  }
}

export function extractResponseText(response: OpenAIResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return sanitizeResponseFinalAnswerText(response.output_text);
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (
          (content?.type === "output_text" || content?.type === "text") &&
          typeof content.text === "string"
        ) {
          parts.push(content.text);
        }
      }
      continue;
    }
    if (
      (item?.type === "output_text" || item?.type === "text") &&
      typeof item.text === "string"
    ) {
      parts.push(item.text);
    }
  }

  return sanitizeResponseFinalAnswerText(parts.join("\n"));
}

export function sanitizeResponseFinalAnswerText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  return localFinalAnswerEnvelope(text) ?? text;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function extractPromptCacheStats(
  response: OpenAIResponse,
): PromptCacheStats | null {
  const promptTokens =
    numberOrNull(response.usage?.input_tokens) ??
    numberOrNull(response.usage?.prompt_tokens);
  const totalTokens = numberOrNull(response.usage?.total_tokens);
  const cachedTokens =
    numberOrNull(response.usage?.prompt_tokens_details?.cached_tokens) ??
    numberOrNull(response.usage?.input_tokens_details?.cached_tokens);
  const cacheWriteTokens =
    numberOrNull(response.usage?.prompt_tokens_details?.cache_write_tokens) ??
    numberOrNull(response.usage?.input_tokens_details?.cache_write_tokens);

  if (
    promptTokens === null &&
    totalTokens === null &&
    cachedTokens === null &&
    cacheWriteTokens === null
  ) {
    return null;
  }

  return {
    promptTokens,
    cachedTokens: cachedTokens ?? 0,
    cacheWriteTokens,
    totalTokens,
  };
}

export function usageReportFromStats(input: {
  model: string;
  stats: PromptCacheStats;
  roundIndex: number;
}): PromptUsageReport & { outputTokens: number; roundIndex: number } {
  const outputTokens =
    input.stats.totalTokens === null || input.stats.promptTokens === null
      ? 0
      : Math.max(0, input.stats.totalTokens - input.stats.promptTokens);
  return {
    model: input.model,
    promptTokens: input.stats.promptTokens,
    cachedTokens: input.stats.cachedTokens,
    totalTokens: input.stats.totalTokens,
    outputTokens,
    roundIndex: input.roundIndex,
  };
}

export function beforeAttributedModelRequest(input: {
  attribution?: PromptUsageAttribution;
  roundIndex: number;
}): void {
  const budget =
    input.attribution?.getBudgetState?.() ?? input.attribution?.budgetState;
  if (
    budget &&
    (budget.status === "exhausted" || budget.requestCount >= budget.maxRequests)
  ) {
    throw promptUsageModelCallBudgetExhaustedError();
  }
  input.attribution?.beforeModelRequest?.({
    roundIndex: input.roundIndex,
    phase: input.attribution.phase,
  });
}

export function beforeAttributedAdmittedModelRequest(input: {
  attribution?: PromptUsageAttribution;
  roundIndex: number;
  admittedPromptTokens: number;
  requestedOutputTokens: number;
  requestHash: string;
}): void {
  input.attribution?.beforeAdmittedModelRequest?.({
    roundIndex: input.roundIndex,
    phase: input.attribution.phase,
    admittedPromptTokens: input.admittedPromptTokens,
    requestedOutputTokens: input.requestedOutputTokens,
    requestHash: input.requestHash,
  });
}

export function promptUsageModelCallBudgetExhaustedError(): Error & {
  code: string;
} {
  const error = Object.assign(
    new Error(
      "Prompt usage model-call budget exhausted before provider request",
    ),
    { code: "prompt_usage_model_call_budget_exhausted" },
  );
  error.name = "PromptUsageModelCallBudgetExhaustedError";
  return error;
}

export function modelIterationLimitWithinUsageBudget(
  requestedRounds: number,
  attribution?: PromptUsageAttribution,
): number {
  const requested =
    requestedRounds === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.min(requestedRounds, MAX_TOOL_ROUNDS));
  const budget = attribution?.getBudgetState?.() ?? attribution?.budgetState;
  if (
    !budget ||
    !Number.isFinite(budget.requestCount) ||
    !Number.isFinite(budget.maxRequests)
  ) {
    return requested;
  }
  const remainingRequests = Math.max(
    0,
    budget.maxRequests - budget.requestCount,
  );
  if (remainingRequests <= 1) return 1;
  return Math.max(1, Math.min(requested, remainingRequests - 1));
}

export function afterAttributedModelResponse(input: {
  attribution?: PromptUsageAttribution;
  model: string;
  response: OpenAIResponse;
  roundIndex: number;
}): void {
  const stats = extractPromptCacheStats(input.response);
  if (!stats || stats.promptTokens === null) return;
  input.attribution?.afterModelResponseUsage?.(
    usageReportFromStats({
      model: input.model,
      stats,
      roundIndex: input.roundIndex,
    }),
  );
}

export interface ProviderUsageSample {
  promptTokens: number | null;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number | null;
}

export interface ProviderRequestAttributor {
  request<T>(input: {
    model: string;
    run: (context: {
      roundIndex: number;
      attribution?: PromptUsageAttribution;
    }) => Promise<T>;
    usage?: (response: T) => ProviderUsageSample | null;
  }): Promise<T>;
}

export function createProviderRequestAttributor(input: {
  attribution?: PromptUsageAttribution;
  startRoundIndex?: number;
  butlerData?: string;
  cacheScope?: string;
}): ProviderRequestAttributor {
  let nextRoundIndex =
    input.startRoundIndex ?? input.attribution?.roundIndex ?? 0;
  return {
    async request<T>(requestInput: {
      model: string;
      run: (context: {
        roundIndex: number;
        attribution?: PromptUsageAttribution;
      }) => Promise<T>;
      usage?: (response: T) => ProviderUsageSample | null;
    }): Promise<T> {
      const { model, run, usage } = requestInput;
      const roundIndex = nextRoundIndex;
      nextRoundIndex += 1;
      beforeAttributedModelRequest({
        attribution: input.attribution,
        roundIndex,
      });
      const response = await run({
        roundIndex,
        attribution: input.attribution,
      });
      const sample = usage?.(response) ?? null;
      if (sample) {
        const metricContextProvided =
          input.butlerData !== undefined || input.cacheScope !== undefined;
        if (metricContextProvided) {
          appendPromptUsageMetric({
            model,
            scope: input.cacheScope ?? "btcc-agent-loop",
            promptTokens: sample.promptTokens,
            cachedTokens: sample.cachedTokens,
            totalTokens: sample.totalTokens,
            usageAttribution: input.attribution,
            butlerData: input.butlerData,
          });
        }
        input.attribution?.afterModelResponseUsage?.({
          model,
          ...sample,
          roundIndex,
        });
      }
      return response;
    },
  };
}

export function openAICompatibleUsageSample(
  response: Record<string, any>,
): ProviderUsageSample | null {
  const promptTokens =
    numberOrNull(response.usage?.prompt_tokens) ??
    numberOrNull(response.usage?.input_tokens);
  const outputTokens =
    numberOrNull(response.usage?.completion_tokens) ??
    numberOrNull(response.usage?.output_tokens) ??
    0;
  const totalTokens =
    numberOrNull(response.usage?.total_tokens) ??
    (promptTokens === null ? null : promptTokens + outputTokens);
  const cachedTokens =
    numberOrNull(
      response.usage?.prompt_tokens_details?.cached_tokens ??
        response.usage?.input_tokens_details?.cached_tokens,
    ) ?? 0;
  if (promptTokens === null && totalTokens === null) return null;
  return {
    promptTokens,
    cachedTokens,
    outputTokens,
    totalTokens,
  };
}
