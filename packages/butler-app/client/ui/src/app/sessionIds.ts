import { isOptimisticSessionId } from "./optimisticSession.ts";
import { isDraftChatId } from "./utils.ts";

export function isServerBackedSessionId(value: string): boolean {
  // An empty id (a form whose target has not loaded yet) names no session.
  return value !== "" && !value.startsWith("dashboard:") && !isDraftChatId(value) && !isOptimisticSessionId(value);
}
