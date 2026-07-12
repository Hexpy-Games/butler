import type { SessionControlState } from "./session-contract.ts";

export function isSessionControlUpdateRequest(
  value: unknown,
): value is Partial<SessionControlState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set([
    "model",
    "reasoning_effort",
    "access_mode",
    "plan_mode",
  ]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  if ("model" in input && typeof input.model !== "string") return false;
  if (
    "reasoning_effort" in input &&
    !["none", "low", "medium", "high", "xhigh", "max"].includes(
      String(input.reasoning_effort),
    )
  )
    return false;
  if (
    "access_mode" in input &&
    !["full_access", "ask_first", "read_only"].includes(
      String(input.access_mode),
    )
  )
    return false;
  if ("plan_mode" in input && typeof input.plan_mode !== "boolean")
    return false;
  return true;
}
