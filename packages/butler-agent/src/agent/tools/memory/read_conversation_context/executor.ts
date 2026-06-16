import { createMemoryToolHandlers } from "../shared.ts";

export function createReadConversationContextToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return createMemoryToolHandlers(input).read_conversation_context;
}
