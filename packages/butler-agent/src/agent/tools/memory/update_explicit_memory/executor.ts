import { createMemoryToolHandlers } from "../shared.ts";

export function createUpdateExplicitMemoryToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return createMemoryToolHandlers(input).update_explicit_memory;
}
