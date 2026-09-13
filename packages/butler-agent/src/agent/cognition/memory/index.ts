export {
  ingestConversationMemory,
  advanceNextMemoryProjection,
  resolveMemorySource,
  completionProjectionProcessed,
} from "./projection/ingestion.ts";
export { recallSourceBackedMemory as recallMemory } from "./recall/engine.ts";
export { readActiveDescriptor } from "./projection/generation.ts";
export type {
  MemoryExecutionContext,
  MemoryJobProgress,
  MemorySourceNotice,
} from "./projection/contracts.ts";
