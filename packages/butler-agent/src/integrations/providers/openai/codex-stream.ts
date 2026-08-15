import type { CodexSseAccumulator, OpenAIResponse, PromptUsageAttribution, ProviderStreamProjectionHandler } from "../runtime-contracts.ts";
import { codexAccountIdFromAuthorization, codexRequestBody } from "./responses-client.ts";
import { codexSseResponseFromAccumulator } from "./codex-response-assembly.ts";
import { emitProviderStreamProjectionBestEffort } from "../shared/runtime-support.ts";
import { getCodexOriginator, getCodexResponsesUrl, getCodexUserAgent } from "./config.ts";
import { providerHttpError, providerNetworkError, safeEndpointLabel } from "../provider-errors.ts";
import { admitSerializedProviderRequest } from "../shared/request-context-admission.ts";

export function createCodexSseAccumulator(
  onProviderStreamEvent?: ProviderStreamProjectionHandler,
  fallbackStreamId = `codex-stream-${Date.now()}`,
): CodexSseAccumulator {
  return {
    output: [],
    completed: null,
    fallbackText: "",
    sequence: 0,
    fallbackStreamId,
    onProviderStreamEvent,
  };
}




export { codexSseResponseFromAccumulator } from "./codex-response-assembly.ts";




export async function handleCodexSseEvent(
  accumulator: CodexSseAccumulator,
  event: Record<string, any>,
): Promise<void> {
  const nextSequence = () => {
    accumulator.sequence += 1;
    return accumulator.sequence;
  };
  const streamIdFor = (input: Record<string, any>): string =>
    stringFromUnknown(input.response_id) ||
    stringFromUnknown(input.response?.id) ||
    stringFromUnknown(input.item_id) ||
    accumulator.fallbackStreamId;

  if (event.type === "error") {
    throw codexBackendEventError(event.error ?? event);
  }
  if (event.type === "response.failed") {
    throw codexBackendEventError(event.response?.error ?? event.response ?? event);
  }
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    accumulator.fallbackText += event.delta;
    await emitProviderStreamProjectionBestEffort(accumulator, {
      type: "text_delta",
      streamId: streamIdFor(event),
      sequence: nextSequence(),
      textDelta: event.delta,
      target: "final_candidate",
      raw: event,
    });
    return;
  }
  if (isReasoningDeltaSseEvent(event)) {
    const delta = typeof event.delta === "string" ? event.delta : "";
    await emitProviderStreamProjectionBestEffort(accumulator, {
      type: "reasoning_delta",
      streamId: streamIdFor(event),
      sequence: nextSequence(),
      textDelta: delta,
      charCount: delta.length,
      raw: event,
    });
    return;
  }
  if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
    await emitProviderStreamProjectionBestEffort(accumulator, {
      type: "tool_call_delta",
      streamId: streamIdFor(event),
      callIndex: nonNegativeIntegerFromUnknown(event.output_index) ?? 0,
      sequence: nextSequence(),
      toolCallId: stringFromUnknown(event.call_id) || stringFromUnknown(event.item_id),
      argumentsDelta: event.delta,
      argumentCharCount: event.delta.length,
      publicState: "generating",
      raw: event,
    });
    return;
  }
  if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
    accumulator.output.push(event.item);
    if (event.item.type === "function_call") {
      const rawArguments = typeof event.item.arguments === "string" ? event.item.arguments : "";
      await emitProviderStreamProjectionBestEffort(accumulator, {
        type: "tool_call_delta",
        streamId: streamIdFor(event),
        callIndex: nonNegativeIntegerFromUnknown(event.output_index) ?? 0,
        sequence: nextSequence(),
        toolCallId: stringFromUnknown(event.item.call_id),
        toolName: stringFromUnknown(event.item.name),
        argumentCharCount: rawArguments.length,
        publicState: "ready",
        raw: event,
      });
    }
    return;
  }
  if (event.type === "response.completed" && event.response && typeof event.response === "object") {
    accumulator.completed = event.response;
    await emitProviderStreamProjectionBestEffort(accumulator, {
      type: "completed",
      streamId: streamIdFor(event),
      status: "completed",
      raw: event,
    });
  }
}

function codexBackendEventError(value: unknown) {
  const error = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const type = stringFromUnknown(error.type) ?? "";
  const code = stringFromUnknown(error.code) ?? "";
  const message = stringFromUnknown(error.message) || code || type || "unknown backend error";
  return providerHttpError({
    provider: "openai-codex",
    api: "codex_responses",
    statusCode: codexBackendStatus(type, code),
    detail: message,
    providerError: error,
  });
}

function codexBackendStatus(type: string, code: string): number {
  const identity = `${type}:${code}`.toLocaleLowerCase("en-US");
  if (/rate.?limit|too_many_requests/u.test(identity)) return 429;
  if (/auth|unauthorized/u.test(identity)) return 401;
  if (/permission|forbidden/u.test(identity)) return 403;
  if (/invalid|bad_request/u.test(identity)) return 400;
  if (/service_unavailable|overload/u.test(identity)) return 503;
  return 502;
}




export function codexSseEventFromFrame(frame: string): Record<string, any> | null {
  const data = frame
    .split(/\r\n|\n|\r/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Ignore non-JSON keepalive frames.
    return null;
  }
}




export async function consumeCodexSseFrame(
  accumulator: CodexSseAccumulator,
  frame: string,
  onValidEvent?: () => void,
): Promise<boolean> {
  const event = codexSseEventFromFrame(frame);
  if (!event) return false;
  onValidEvent?.();
  await handleCodexSseEvent(accumulator, event);
  return true;
}




export function nextSseFrameBoundary(buffer: string): { index: number; length: number } | null {
  const candidates = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => candidate.index < best.index ? candidate : best);
}




export async function readCodexSseResponse(
  response: Response,
  onProviderStreamEvent?: ProviderStreamProjectionHandler,
  onValidEvent?: () => void,
): Promise<OpenAIResponse> {
  const accumulator = createCodexSseAccumulator(onProviderStreamEvent);
  if (!response.body) {
    await consumeCodexSseText(await response.text(), accumulator, onValidEvent);
    return codexSseResponseFromAccumulator(accumulator);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembled = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (!done && (!value || value.byteLength === 0)) {
        await yieldToEventLoop();
        continue;
      }
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const boundary = nextSseFrameBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        await consumeCodexSseFrame(accumulator, frame, onValidEvent);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      await consumeCodexSseFrame(accumulator, buffer, onValidEvent);
    }
    const result = codexSseResponseFromAccumulator(accumulator);
    assembled = true;
    return result;
  } finally {
    if (!assembled) await cancelReader(reader);
    try {
      reader.releaseLock();
    } catch {
      // The stream may have released its lock while closing.
    }
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Preserve the provider failure that made the stream incomplete.
  }
}




export async function consumeCodexSseText(
  text: string,
  accumulator: CodexSseAccumulator,
  onValidEvent?: () => void,
): Promise<void> {
  let buffer = text;
  while (true) {
    const boundary = nextSseFrameBoundary(buffer);
    if (!boundary) break;
    const frame = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary.length);
    await consumeCodexSseFrame(accumulator, frame, onValidEvent);
  }
  if (buffer.trim()) {
    await consumeCodexSseFrame(accumulator, buffer, onValidEvent);
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}




export function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}




export function nonNegativeIntegerFromUnknown(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}




export function isReasoningDeltaSseEvent(event: Record<string, any>): boolean {
  return typeof event.delta === "string" &&
    /(?:^|\.)reasoning(?:_summary)?(?:_text)?\.delta$/u.test(String(event.type ?? ""));
}




export async function createCodexResponse(
  body: Record<string, any>,
  authorization: string,
  signal?: AbortSignal,
  onProviderStreamEvent?: ProviderStreamProjectionHandler,
  budgetContext?: { attribution?: PromptUsageAttribution; roundIndex: number },
  onProviderRoundProgress?: () => void,
  onProviderRoundStarted?: () => void,
): Promise<OpenAIResponse> {
  const accountId = codexAccountIdFromAuthorization(authorization);
  const endpoint = safeEndpointLabel(getCodexResponsesUrl());
  const model = typeof body.model === "string" ? body.model : undefined;
  const requestBody = codexRequestBody(body);
  const admittedRequest = admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: typeof requestBody.model === "string" ? requestBody.model : model ?? "",
    body: requestBody,
    requestedOutputTokens: budgetContext?.attribution?.requestedOutputTokens,
    usageAttribution: budgetContext?.attribution,
    roundIndex: budgetContext?.roundIndex,
  });
  let response: Response;
  try {
    onProviderRoundStarted?.();
    response = await fetch(getCodexResponsesUrl(), {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        "User-Agent": getCodexUserAgent(),
        "chatgpt-account-id": accountId,
        originator: getCodexOriginator(),
      },
      body: admittedRequest.serialized_request,
      signal,
    });
  } catch (error) {
    throw providerNetworkError({
      provider: "openai-codex",
      api: "codex_responses",
      endpoint,
      model,
      error,
    });
  }

  onProviderRoundProgress?.();

  if (!response.ok) {
    const raw = await response.text();
    let parsed: Record<string, any> = {};
    let detail = raw;
    try {
      parsed = JSON.parse(raw);
      detail = parsed?.error?.message || raw;
    } catch {}
    throw providerHttpError({
      provider: "openai-codex",
      api: "codex_responses",
      statusCode: response.status,
      detail,
      providerError: parsed,
      endpoint,
      model,
      admission: admittedRequest,
      headers: response.headers,
    });
  }

  return await readCodexSseResponse(response, onProviderStreamEvent, onProviderRoundProgress);
}
