import type {
  ContextProjectionRebaseIdentity,
  ProviderRouteCacheIdentity,
} from "../../../agent/btcc/ports/model-round.ts";

export interface OpenAIResponseContinuation {
  provider: "openai";
  responseId: string;
  sent?: { toolMessages: number; userMessages: number };
  /** Highest Turn-local occurrence already represented by the Responses chain. */
  deliveredThroughOrdinal?: number;
  statelessInput?: Array<Record<string, unknown>>;
  providerRouteIdentity?: ProviderRouteCacheIdentity;
  contextProjection?: ContextProjectionRebaseIdentity;
}

export function requiredLegacyOpenAISent(
  value: OpenAIResponseContinuation["sent"],
): NonNullable<OpenAIResponseContinuation["sent"]> {
  if (!value || !Number.isSafeInteger(value.toolMessages) ||
      !Number.isSafeInteger(value.userMessages)) {
    throw new Error("openai_sent_continuation_missing");
  }
  return value;
}

export function isOpenAIResponseContinuation(
  value: unknown,
): value is OpenAIResponseContinuation {
  return Boolean(
    value && typeof value === "object" &&
    (value as Record<string, unknown>).provider === "openai" &&
    typeof (value as Record<string, unknown>).responseId === "string",
  );
}
