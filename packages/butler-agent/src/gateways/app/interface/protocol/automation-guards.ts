import type { CreateAutomationRequest } from "./automation-worker-contract.ts";

export function isCreateAutomationRequest(
  value: unknown,
): value is CreateAutomationRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CreateAutomationRequest>;
  return (
    typeof input.title === "string" &&
    typeof input.prompt_body === "string" &&
    typeof input.target_session_id === "string" &&
    typeof input.interval_seconds === "number"
  );
}
