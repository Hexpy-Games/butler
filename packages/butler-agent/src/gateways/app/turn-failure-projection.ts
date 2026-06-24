import { safeLimitationText } from "../../agent/turn/runtime-delivery-state.ts";

export interface ProjectedSafeTurnFailure {
  code: string;
  message: string;
  cause?: string;
}

export function projectSafeTurnFailure(input: {
  message: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): ProjectedSafeTurnFailure {
  const code = safeOptionalShortToken(input.metadata.safeErrorCode) ?? "gateway_failed";
  return {
    code,
    message:
      safeOptionalShortText(input.message.text) ??
      "Butler could not complete this turn.",
    cause: code === "gateway_failed"
      ? undefined
      : safeOptionalShortCause(input.metadata.safeErrorCause),
  };
}

export function safeTurnFailureEventPayload(
  safeError: ProjectedSafeTurnFailure,
): Record<string, unknown> {
  return {
    safeLabel: safeError.message,
    safeErrorCode: safeError.code,
    ...(safeError.cause ? { safeCause: safeError.cause } : {}),
  };
}

function safeOptionalShortToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[^a-z0-9_.:-]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase()
    .slice(0, 80);
  return normalized || undefined;
}

function safeOptionalShortText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function safeOptionalShortCause(value: unknown): string | undefined {
  const safe = safeLimitationText(value, "");
  return safe || undefined;
}
