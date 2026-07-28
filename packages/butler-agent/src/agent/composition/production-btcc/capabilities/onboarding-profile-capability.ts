import { createUpdateOnboardingProfileToolHandler } from
  "../../../tools/memory/update_onboarding_profile/executor.ts";
import type { CapabilityExecutionContext } from "./contracts.ts";

export function updateOnboardingProfile(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
) {
  const execute = createUpdateOnboardingProfileToolHandler({
    butlerHome: context.butlerHome ?? context.workspacePath,
    butlerData: context.butlerData,
  });
  return execute({ args });
}
