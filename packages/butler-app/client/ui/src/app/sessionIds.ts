import { isOptimisticSessionId } from "./optimisticSession.ts";
import { isDraftChatId } from "./utils.ts";

export function isServerBackedSessionId(value: string): boolean {
  return !isDraftChatId(value) && !isOptimisticSessionId(value);
}
