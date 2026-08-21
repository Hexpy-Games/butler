import type { SubsessionResultIngressRequest } from "./internal-result-contract.ts";

export function isSubsessionResultIngressRequest(
  value: unknown,
): value is SubsessionResultIngressRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<SubsessionResultIngressRequest>;
  return [
    "relation_id",
    "result_id",
    "parent_chat_id",
    "parent_session_id",
    "parent_turn_id",
    "message_id",
    "safe_title",
    "text",
    "model_ref",
    "reasoning_effort",
    "access_mode",
    "timestamp",
  ].every((key) => {
    const item = input[key as keyof SubsessionResultIngressRequest];
    return typeof item === "string" && item.trim().length > 0;
  }) && (
    input.reasoning_effort === "none" ||
    input.reasoning_effort === "low" ||
    input.reasoning_effort === "medium" ||
    input.reasoning_effort === "high" ||
    input.reasoning_effort === "xhigh" ||
    input.reasoning_effort === "max"
  ) && (
    input.access_mode === "full_access" ||
    input.access_mode === "ask_first" ||
    input.access_mode === "read_only"
  );
}
