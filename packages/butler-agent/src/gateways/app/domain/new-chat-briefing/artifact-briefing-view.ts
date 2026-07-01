import {
  type NewChatBriefingArtifact,
} from "../../../../agent/cognition/consolidation/new-chat-briefing.ts";
import type { NewChatBriefingView } from "../../interface/protocol/app-protocol.ts";
import { formatMoment, timeOfDay } from "./briefing-format.ts";

export function viewFromArtifact(
  artifact: NewChatBriefingArtifact,
  now: Date,
): NewChatBriefingView {
  return {
    moment:
      artifact.scope === "general" && artifact.title_variants
        ? formatMoment(now, artifact.locale)
        : artifact.moment,
    title: titleFromArtifact(artifact, now),
    description: artifact.description,
    suggestions: artifact.suggestions.map((suggestion) => ({
      id: suggestion.id,
      title: suggestion.title,
      description: suggestion.description,
      text: suggestion.text,
    })),
    source: {
      scope: artifact.scope,
      content_origin: "generated",
      consolidation_run_id: artifact.source.consolidation_run_id,
      generated_at: artifact.source.generated_at,
      locale: artifact.locale,
      project_id: artifact.project_id ?? undefined,
      project_name: artifact.project_name ?? undefined,
      persona_applied: artifact.source.persona_applied,
      profile_projection_applied: Boolean(artifact.source.profile_projection_id),
    },
    raw_text_included: false,
  };
}

function titleFromArtifact(
  artifact: NewChatBriefingArtifact,
  now: Date,
): string {
  if (artifact.scope !== "general" || !artifact.title_variants) {
    return artifact.title;
  }
  return artifact.title_variants[timeOfDay(now)] || artifact.title;
}
