import type { FunctionToolDefinition } from "../runtime-contracts.ts";
import type { LocalModelConfig } from "./models.ts";
import { ModelProviderRequestError, providerHttpError, providerNetworkError, safeEndpointLabel } from "../provider-errors.ts";
import { withModelApiRetry } from "../shared/runtime-support.ts";
import { localChatUrl } from "./protocol.ts";



export async function createLocalChatCompletion(
  config: LocalModelConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  return await withModelApiRetry(
    async () => await createLocalChatCompletionOnce(config, body, signal),
    signal,
  );
}


async function createLocalChatCompletionOnce(
  config: LocalModelConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const requestBody = {
    temperature: 0,
    ...(Number.isFinite(config.max_output_tokens) && Number(config.max_output_tokens) > 0
      ? { max_tokens: Math.trunc(Number(config.max_output_tokens)) }
      : {}),
    ...body,
  };
  const endpoint = safeEndpointLabel(localChatUrl(config));
  const model = typeof body.model === "string" ? body.model : config.model_id;
  let response: Response;
  try {
    response = await fetch(localChatUrl(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "local",
      api: "chat_completions",
      endpoint,
      model,
      error,
    });
  }
  const raw = await response.text();
  let parsed: Record<string, any>;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const detail = parsed?.error?.message || raw || `status ${response.status}`;
    throw providerHttpError({
      provider: "local",
      api: "chat_completions",
      statusCode: response.status,
      detail,
      endpoint,
      model,
    });
  }
  return parsed;
}



export function firstLocalAssistantMessage(response: Record<string, any>): Record<string, any> {
  const message = response.choices?.[0]?.message;
  return message && typeof message === "object" ? message : {};
}



export function isLocalContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const causeMessage = error instanceof ModelProviderRequestError ? error.causeMessage : "";
  const text = [error.message, causeMessage].filter(Boolean).join("\n");
  return /(?:available context size|context (?:size|window|length)|maximum context|too many tokens|request \(\d+ tokens\) exceeds)/iu
    .test(text);
}



export function localToolFallbackInstructions(instructions?: string): string {
  return [
    instructions?.trim(),
    "The local model server rejected the tool-enabled request because its context window is too small for the full Butler tool schema. Answer directly without calling tools. If a tool would be required for certainty, say what cannot be verified from the available context.",
  ].filter(Boolean).join("\n\n");
}



export function localCompactEvidenceTools(tools: FunctionToolDefinition[]): FunctionToolDefinition[] {
  const evidenceToolNames = new Set(["web_search", "web_read"]);
  return tools.filter((tool) => evidenceToolNames.has(tool.name));
}
