import type { OpenAIAuthOverride, OpenAIResponse, ProviderStreamProjectionHandler } from "../runtime-contracts.ts";
import { getFunctionCalls, withModelApiRetry } from "../shared/runtime-support.ts";
import { createCodexResponse } from "./codex-stream.ts";
import { getResponsesUrl } from "./config.ts";
import { providerHttpError, providerNetworkError, safeEndpointLabel } from "../provider-errors.ts";
import { resolveOpenAIAuth } from "./auth.ts";




export async function createOpenAIResponse(
  body: Record<string, any>,
  signal?: AbortSignal,
  authOverride?: OpenAIAuthOverride,
  onProviderStreamEvent?: ProviderStreamProjectionHandler,
): Promise<OpenAIResponse> {
  return await withModelApiRetry(
    async () => await createOpenAIResponseOnce(body, signal, authOverride, onProviderStreamEvent),
    signal,
  );
}




export async function createOpenAIResponseOnce(
  body: Record<string, any>,
  signal?: AbortSignal,
  authOverride?: OpenAIAuthOverride,
  onProviderStreamEvent?: ProviderStreamProjectionHandler,
): Promise<OpenAIResponse> {
  const auth = authOverride ?? await resolveOpenAIAuth();
  if (auth.mode === "codex_subscription" || auth.mode === "codex_oauth") {
    return await createCodexResponse(body, auth.authorization, signal, onProviderStreamEvent);
  }
  const { __butler_codex_stateless_input: _codexStatelessInput, ...officialBody } = body;
  const endpoint = safeEndpointLabel(getResponsesUrl());
  const model = typeof officialBody.model === "string" ? officialBody.model : undefined;

  let response: Response;
  try {
    response = await fetch(getResponsesUrl(), {
      method: "POST",
      headers: {
        Authorization: auth.authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(officialBody),
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "openai",
      api: "responses",
      endpoint,
      model,
      error,
    });
  }

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || raw;
    } catch {}
    throw providerHttpError({
      provider: "openai",
      api: "responses",
      statusCode: response.status,
      detail,
      endpoint,
      model,
    });
  }

  return (await response.json()) as OpenAIResponse;
}




export function decodeJwtPayload(token: string): Record<string, any> | null {
  const rawToken = token.replace(/^Bearer\s+/i, "");
  const part = rawToken.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}




export function codexAccountIdFromAuthorization(authorization: string): string {
  const payload = decodeJwtPayload(authorization);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = auth && typeof auth === "object"
    ? (auth.chatgpt_account_id || auth.account_id)
    : undefined;
  if (typeof accountId === "string" && accountId) return accountId;
  throw new Error("Codex subscription token did not include a ChatGPT account id");
}




export function codexRequestBody(body: Record<string, any>): Record<string, any> {
  const rawInput = body.__butler_codex_stateless_input ?? body.input;
  const next: Record<string, any> = {
    ...body,
    model: codexSubscriptionModel(String(body.model || "")),
    instructions: typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions
      : "You are Butler, a helpful personal AI assistant.",
    input: codexInput(rawInput),
    store: false,
    stream: true,
  };
  delete next.previous_response_id;
  delete next.__butler_codex_stateless_input;
  delete next.prompt_cache_retention;
  if (!next.text) {
    next.text = { verbosity: "medium" };
  }
  return next;
}




export function codexSubscriptionModel(model: string): string {
  const trimmed = model.trim();
  if (/^gpt-\d+(?:\.\d+)*-codex$/i.test(trimmed)) {
    return trimmed.replace(/-codex$/i, "");
  }
  if (!trimmed) {
    throw new Error("Codex subscription model is required; no model fallback is allowed.");
  }
  return trimmed;
}




export function codexInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  return [{
    role: "user",
    content: [{
      type: "input_text",
      text: input,
    }],
  }];
}




export function toCodexStatelessInput(input: unknown): Array<Record<string, unknown>> {
  const converted = codexInput(input);
  return Array.isArray(converted)
    ? converted.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}




export function functionCallContinuationItems(
  response: OpenAIResponse,
  allowedNames?: Set<string>,
): Array<Record<string, unknown>> {
  return getFunctionCalls(response, allowedNames).map((call) => ({
    type: "function_call",
    call_id: call.call_id,
    name: call.name,
    arguments: call.arguments,
  }));
}
