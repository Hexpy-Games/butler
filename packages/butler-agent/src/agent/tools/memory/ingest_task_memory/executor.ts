import { createMemoryToolHandlers } from "../shared.ts";

export function createIngestTaskMemoryToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return createMemoryToolHandlers(input).ingest_task_memory;
}
