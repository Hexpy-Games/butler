import type {
  ModelRoundMessage,
  ModelRoundResult,
  ModelRoundToolCall,
} from "../../../btcc/ports/index.ts";
import { parseDeliveredThroughOrdinal } from
  "../../../btcc/ports/index.ts";

/**
 * Acceptance replay is deliberately limited to the normalized response
 * contract. Raw provider payloads are not durable response state and must not
 * cross a restart boundary; the normalized continuation and provider-owned
 * message data needed to resume the admitted round are retained explicitly.
 */
export function normalizeAcceptedModelRound(result: ModelRoundResult): ModelRoundResult {
  const boundedContinuation = isRecord(result.continuation) &&
    (Object.hasOwn(result.continuation, "deliveredThroughOrdinal") ||
      Object.hasOwn(result.continuation, "boundedItemKeys"));
  const normalized: ModelRoundResult = {
    toolCalls: result.toolCalls.map(normalizeToolCall),
  };
  if (typeof result.text === "string") normalized.text = result.text;
  if (result.textToolCallNames) {
    normalized.textToolCallNames = result.textToolCallNames.map((name) => {
      if (typeof name !== "string") {
        throw new Error("BTCC accepted response has invalid text tool name");
      }
      return name;
    });
  }
  if (result.assistantMessage) {
    normalized.assistantMessage = normalizeAssistantMessage(
      result.assistantMessage,
      !boundedContinuation,
    );
  }
  const continuation = boundedContinuation
    ? normalizeBoundedContinuation(result.continuation)
    : safeJsonClone(result.continuation);
  if (continuation !== undefined) normalized.continuation = continuation;
  if (result.usage === null) {
    normalized.usage = null;
  } else if (result.usage) {
    normalized.usage = {
      model: result.usage.model,
      promptTokens: result.usage.promptTokens,
      cachedTokens: result.usage.cachedTokens,
      totalTokens: result.usage.totalTokens,
      outputTokens: result.usage.outputTokens,
    };
  }
  if (result.providerIdentity) {
    normalized.providerIdentity = normalizeProviderIdentity(result.providerIdentity);
  }
  return normalized;
}

function normalizeBoundedContinuation(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.provider !== "openai" ||
      typeof value.responseId !== "string" || value.responseId.length === 0 ||
      value.responseId.length > 200) {
    throw new Error("BTCC bounded continuation has invalid provider identity");
  }
  const allowed = new Set([
    "provider", "responseId", "deliveredThroughOrdinal", "providerRouteIdentity",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("BTCC bounded continuation has unknown private fields");
  }
  return {
    provider: "openai",
    responseId: value.responseId,
    deliveredThroughOrdinal: parseDeliveredThroughOrdinal(value.deliveredThroughOrdinal),
    ...(value.providerRouteIdentity === undefined
      ? {}
      : { providerRouteIdentity: normalizeProviderRouteCacheIdentity(
          value.providerRouteIdentity,
        ) }),
  };
}

function normalizeProviderRouteCacheIdentity(value: unknown): Record<string, unknown> {
  if (!isRecord(value) ||
      value.schemaVersion !== "butler.provider-route-cache-identity.v1" ||
      typeof value.routeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.routeDigest) ||
      !Number.isSafeInteger(value.routeCursor) || Number(value.routeCursor) < 0 ||
      (value.providerId !== "openai" && value.providerId !== "openai-codex") ||
      typeof value.modelRef !== "string" || value.modelRef.length === 0 || value.modelRef.length > 200 ||
      (value.authMode !== "api_key" && value.authMode !== "codex_subscription" &&
        value.authMode !== "codex_oauth") ||
      typeof value.capabilityDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.capabilityDigest) ||
      (value.serializerContract !== "butler.openai-responses-final-json.v1" &&
        value.serializerContract !== "butler.openai-codex-final-json.v1") ||
      typeof value.toolProfileRevision !== "string" || value.toolProfileRevision.length > 120 ||
      typeof value.stablePrefixRevision !== "string" || value.stablePrefixRevision.length > 120 ||
      typeof value.serializedStablePrefixSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.serializedStablePrefixSha256) ||
      !Number.isSafeInteger(value.serializedStablePrefixBytes) ||
        Number(value.serializedStablePrefixBytes) < 1 ||
        Number(value.serializedStablePrefixBytes) > 1_000_000) {
    throw new Error("BTCC bounded continuation has invalid provider route cache identity");
  }
  return { ...value };
}

export function hydrateAcceptedModelRound(
  value: string,
  providerIdentityJson: string | null,
): ModelRoundResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BTCC accepted response is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.toolCalls)) {
    throw new Error("BTCC accepted response has invalid normalized shape");
  }
  const result = normalizeAcceptedModelRound(parsed as unknown as ModelRoundResult);
  if (providerIdentityJson) {
    let identity: unknown;
    try {
      identity = JSON.parse(providerIdentityJson);
    } catch {
      throw new Error("BTCC accepted response provider identity is not valid JSON");
    }
    result.providerIdentity = normalizeProviderIdentity(identity);
  }
  return result;
}

function normalizeToolCall(call: ModelRoundToolCall): ModelRoundToolCall {
  if (!isRecord(call) || typeof call.id !== "string" ||
      typeof call.name !== "string" || typeof call.rawArguments !== "string" ||
      !isRecord(call.arguments)) {
    throw new Error("BTCC accepted response has invalid tool call");
  }
  return {
    id: call.id,
    name: call.name,
    arguments: cloneJsonRecord(call.arguments),
    rawArguments: call.rawArguments,
    ...(call.origin === "native" || call.origin === "text"
      ? { origin: call.origin }
      : {}),
  };
}

function normalizeAssistantMessage(
  message: ModelRoundMessage,
  retainProviderData: boolean,
): ModelRoundMessage {
  if (!isRecord(message) ||
      (message.role !== "system" && message.role !== "user" &&
        message.role !== "assistant" && message.role !== "tool") ||
      typeof message.content !== "string") {
    throw new Error("BTCC accepted response has invalid assistant message");
  }
  const normalized: ModelRoundMessage = {
    role: message.role,
    content: message.content,
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.name === "string" ? { name: message.name } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(normalizeToolCall) } : {}),
  };
  if (retainProviderData) {
    const providerData = safeJsonClone(message.providerData);
    if (providerData !== undefined) normalized.providerData = providerData;
  }
  const imageAttachments = safeJsonClone(message.imageAttachments);
  if (Array.isArray(imageAttachments)) {
    normalized.imageAttachments = imageAttachments as ModelRoundMessage["imageAttachments"];
  }
  return normalized;
}

function normalizeProviderIdentity(identity: unknown): NonNullable<ModelRoundResult["providerIdentity"]> {
  if (!isRecord(identity) || typeof identity.provider !== "string" ||
      typeof identity.configuredModel !== "string" ||
      typeof identity.reportedModel !== "string") {
    throw new Error("BTCC accepted response has invalid provider identity");
  }
  return {
    provider: identity.provider,
    configuredModel: identity.configuredModel,
    reportedModel: identity.reportedModel,
  };
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const cloned = safeJsonClone(value);
  if (!isRecord(cloned)) {
    throw new Error("BTCC accepted response tool arguments are not JSON serializable");
  }
  return cloned;
}

function safeJsonClone(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
