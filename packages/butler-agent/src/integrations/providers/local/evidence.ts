import type { FunctionToolPromptOptions } from "../runtime-contracts.ts";
import type { LocalModelConfig } from "./models.ts";
import { createLocalChatCompletion, firstLocalAssistantMessage } from "./client.ts";
import { estimateToolResultTokens, finalNoToolInstructions, trimTextToTokenBudgetBalanced } from "../shared/runtime-support.ts";
import { extractLocalFinalEnvelopeText, type LocalChatMessage, localChatUrl, localReasoningRequestParams } from "./protocol.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";



export const MIN_LOCAL_TOOL_RESULT_TOTAL_TOKENS = 800;


export const MAX_LOCAL_TOOL_RESULT_TOTAL_TOKENS = 12_000;


export const LOCAL_TOOL_RESULT_TOTAL_CONTEXT_RATIO = 0.15;


export const MIN_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS = 300;


export const MAX_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS = 4_000;


export const LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_CONTEXT_RATIO = 0.04;


export function localToolResultTotalTokenBudget(config: LocalModelConfig, aggressive = false): number {
  const window = Number.isFinite(config.context_window_tokens)
    ? Math.max(0, Math.trunc(Number(config.context_window_tokens)))
    : 0;
  const ratio = aggressive
    ? LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_CONTEXT_RATIO
    : LOCAL_TOOL_RESULT_TOTAL_CONTEXT_RATIO;
  const min = aggressive
    ? MIN_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS
    : MIN_LOCAL_TOOL_RESULT_TOTAL_TOKENS;
  const max = aggressive
    ? MAX_LOCAL_TOOL_RESULT_AGGRESSIVE_TOTAL_TOKENS
    : MAX_LOCAL_TOOL_RESULT_TOTAL_TOKENS;
  const proportional = window > 0 ? Math.floor(window * ratio) : max;
  return Math.max(min, Math.min(max, proportional));
}



export function compactLocalToolResultContent(input: {
  source: string;
  toolName: string;
  maxTokens: number;
  log: (line: string) => void;
  reason: string;
  ok?: boolean;
}): string {
  const rawTokens = estimateToolResultTokens(input.source);
  if (rawTokens <= input.maxTokens) return input.source;

  const previewTokens = Math.max(40, input.maxTokens - 160);
  const preview = trimTextToTokenBudgetBalanced(input.source, previewTokens);
  const compactPayload = {
    ok: input.ok ?? true,
    output: {
      butler_tool_result_compacted: true,
      tool_name: input.toolName,
      compaction_reason: input.reason,
      raw_estimated_tokens: rawTokens,
      compact_estimated_tokens: estimateToolResultTokens(preview),
      preview,
    },
  };
  const compact = JSON.stringify(compactPayload);
  input.log(
    `tool ${input.toolName} result compacted for local context: reason=${input.reason} raw_tokens=${rawTokens} compact_tokens=${estimateToolResultTokens(compact)}`,
  );
  return compact;
}



export function localToolResultMessageContent(input: {
  payload: Record<string, unknown>;
  toolName: string;
  config: LocalModelConfig;
  log: (line: string) => void;
}): string {
  return JSON.stringify(input.payload);
}



export function existingLocalToolContentSource(content: unknown): {
  source: string;
  ok?: boolean;
} {
  const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const output = parsed?.output;
    if (
      output &&
      typeof output === "object" &&
      output.butler_tool_result_compacted === true &&
      typeof output.preview === "string"
    ) {
      return {
        source: output.preview,
        ok: parsed.ok === true,
      };
    }
    return {
      source: raw,
      ok: parsed?.ok === true,
    };
  } catch {
    return { source: raw };
  }
}



export function rebudgetLocalToolMessages(input: {
  messages: LocalChatMessage[];
  config: LocalModelConfig;
  log: (line: string) => void;
  aggressive?: boolean;
}): boolean {
  const toolMessages = input.messages.filter((message) => message.role === "tool");
  if (toolMessages.length === 0) return false;

  const totalBudget = localToolResultTotalTokenBudget(input.config, input.aggressive === true);
  const perToolBudget = Math.max(1, Math.floor(totalBudget / toolMessages.length));
  let changed = false;
  for (const message of toolMessages) {
    const { source, ok } = existingLocalToolContentSource(message.content);
    if (estimateToolResultTokens(source) <= perToolBudget) continue;
    message.content = compactLocalToolResultContent({
      source,
      toolName: message.name ?? "tool",
      maxTokens: perToolBudget,
      log: input.log,
      reason: input.aggressive === true ? "final_synthesis_context_retry" : "cumulative_tool_result_budget",
      ok,
    });
    changed = true;
  }
  return changed;
}



export function localToolEvidenceDigest(messages: LocalChatMessage[], config: LocalModelConfig): string {
  const toolMessages = messages.filter((message) => message.role === "tool");
  if (toolMessages.length === 0) return "";
  const totalBudget = localToolResultTotalTokenBudget(config, true);
  const perToolBudget = Math.max(1, Math.floor(totalBudget / toolMessages.length));
  return toolMessages.map((message, index) => {
    const { source } = existingLocalToolContentSource(message.content);
    const preview = trimTextToTokenBudgetBalanced(source, perToolBudget);
    return [
      `Tool evidence ${index + 1}${message.name ? ` (${message.name})` : ""}:`,
      preview,
    ].join("\n");
  }).join("\n\n");
}



export async function runLocalCompactFinalAnswerText(input: {
  config: LocalModelConfig;
  options: FunctionToolPromptOptions;
  messages: LocalChatMessage[];
  log: (line: string) => void;
  requestCompletion?: (body: Record<string, unknown>) => Promise<Record<string, any>>;
}): Promise<string> {
  const evidence = localToolEvidenceDigest(input.messages, input.config);
  if (!evidence) throw new Error("Local model API request exceeded context window after tool execution");
  input.log("local model final synthesis exceeded context window after retry; using compact evidence-only final synthesis");
  const body = {
    model: input.config.model_id,
    messages: [
      {
        role: "system",
        content: [
          "You are Butler final answer synthesis.",
          "Use only the user task and compact tool evidence below.",
          "Do not expose hidden reasoning, tool logs, raw JSON, or process notes.",
          "Return exactly one `<butler_final_answer>...</butler_final_answer>` block.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "User task:",
          input.options.prompt,
          "",
          "Compact tool evidence:",
          evidence,
          "",
          finalNoToolInstructions(),
        ].join("\n"),
      },
    ],
    ...localReasoningRequestParams(input.config),
    stream: false,
  };
  const response = input.requestCompletion
    ? await input.requestCompletion(body)
    : await createLocalChatCompletion(input.config, body, input.options.signal);
  const text = extractLocalFinalEnvelopeText(firstLocalAssistantMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      endpoint: safeEndpointLabel(localChatUrl(input.config)),
      model: input.config.model_id,
      local: true,
    });
  }
  return text;
}
