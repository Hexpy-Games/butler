import { isOptimisticSessionId } from "./optimisticSession.ts";
import { isDraftChatId } from "./utils.ts";

export function isServerBackedSessionId(value: string): boolean {
  return !value.startsWith("dashboard:") && !isDraftChatId(value) && !isOptimisticSessionId(value);
}
