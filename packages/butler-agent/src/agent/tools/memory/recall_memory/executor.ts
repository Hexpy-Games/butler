import { createMemoryToolHandlers } from "../shared.ts";

export function createRecallMemoryToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return createMemoryToolHandlers(input).recall_memory;
}
