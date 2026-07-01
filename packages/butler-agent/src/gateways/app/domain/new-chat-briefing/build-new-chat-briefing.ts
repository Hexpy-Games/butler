import { readNewChatBriefingArtifact } from "../../../../agent/cognition/consolidation/new-chat-briefing.ts";
import { readFirstChatOnboardingState } from "../../../../personalization/onboarding.ts";
import { viewFromArtifact } from "./artifact-briefing-view.ts";
import {
  generalFallbackView,
  onboardingFallbackView,
  projectFallbackView,
} from "./briefing-fallback-view.ts";
import type { BuildNewChatBriefingInput } from "./briefing-types.ts";
import { latestConsolidationRun } from "./consolidation-run-reader.ts";
import type { NewChatBriefingView } from "../../interface/protocol/app-protocol.ts";

export function buildNewChatBriefing(
  input: BuildNewChatBriefingInput,
): NewChatBriefingView {
  const now = input.now ?? new Date();
  const locale = input.preferredLocale;
  if (!input.project && firstChatOnboardingPending(input.butlerData)) {
    return onboardingFallbackView({ locale, now });
  }
  const artifact = readNewChatBriefingArtifact({
    butlerData: input.butlerData,
    date: input.date,
    scope: input.project ? "project" : "general",
    projectId: input.project?.id,
    locale,
  });
  if (artifact) return viewFromArtifact(artifact, now);

  const run = latestConsolidationRun(input.butlerData, input.date);
  return input.project
    ? projectFallbackView({
        project: input.project,
        locale,
        now,
        consolidationRunId: run?.run_id ?? null,
      })
    : generalFallbackView({
        locale,
        now,
        consolidationRunId: run?.run_id ?? null,
      });
}

function firstChatOnboardingPending(butlerData: string): boolean {
  return readFirstChatOnboardingState(butlerData).status !== "complete";
}
