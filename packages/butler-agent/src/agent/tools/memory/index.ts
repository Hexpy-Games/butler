import { createIngestTaskMemoryToolHandler } from "./ingest_task_memory/executor.ts";
import { createRecallMemoryToolHandler } from "./recall_memory/executor.ts";
import { createQueryMemoryToolHandler } from "./query_memory/executor.ts";
import { createSummarizeUserProfileToolHandler } from "./summarize_user_profile/executor.ts";
import { createUpdateOnboardingProfileToolHandler } from "./update_onboarding_profile/executor.ts";
import { createReadConversationContextToolHandler } from "./read_conversation_context/executor.ts";
import { createUpdateExplicitMemoryToolHandler } from "./update_explicit_memory/executor.ts";

export function createMemoryToolHandlers(input: Parameters<typeof createIngestTaskMemoryToolHandler>[0]) {
  return {
    "ingest_task_memory": createIngestTaskMemoryToolHandler(input),
    "recall_memory": createRecallMemoryToolHandler(input),
    "query_memory": createQueryMemoryToolHandler(input),
    "summarize_user_profile": createSummarizeUserProfileToolHandler(input),
    "update_onboarding_profile": createUpdateOnboardingProfileToolHandler(input),
    "read_conversation_context": createReadConversationContextToolHandler(input),
    "update_explicit_memory": createUpdateExplicitMemoryToolHandler(input),
  };
}
