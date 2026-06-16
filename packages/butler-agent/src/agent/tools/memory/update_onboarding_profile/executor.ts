import { createMemoryToolHandlers } from "../shared.ts";

export function createUpdateOnboardingProfileToolHandler(input: Parameters<typeof createMemoryToolHandlers>[0]) {
  return createMemoryToolHandlers(input).update_onboarding_profile;
}
