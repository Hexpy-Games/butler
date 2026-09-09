export function ordinaryChatPhaseForIntent(
  policy: Pick<ButlerExecutionPolicy, "role" | "trackingMode">,
  _message: string,
): "direct" | "execution" {
  return policy.role === "butler" && policy.trackingMode !== "none"
    ? "execution"
    : "direct";
}
import type { ButlerExecutionPolicy } from "../contracts.ts";
