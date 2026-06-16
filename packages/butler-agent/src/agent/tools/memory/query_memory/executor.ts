import { createMemoryToolHandlers } from "../shared.ts";

export function createQueryMemoryToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return createMemoryToolHandlers(input).query_memory;
}
