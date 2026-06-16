import { createMemoryToolHandlers } from "../shared.ts";

export function createSummarizeUserProfileToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return createMemoryToolHandlers(input).summarize_user_profile;
}
