import type { NewChatBriefingView } from "../../interface/protocol/app-protocol.ts";
import {
  GENERAL_FALLBACK,
  ONBOARDING_FALLBACK,
} from "./fallback-copy.ts";
import {
  formatMoment,
  userFacingProjectName,
} from "./briefing-format.ts";
import { projectFallbackSuggestions } from "./project-fallback-suggestions.ts";
import type {
  AppLocale,
  ProjectBriefingInput,
} from "./briefing-types.ts";

export function onboardingFallbackView(input: {
  locale: AppLocale;
  now: Date;
}): NewChatBriefingView {
  const fallback = ONBOARDING_FALLBACK[input.locale];
  return {
    moment: input.locale === "ko" ? "온보딩" : "Onboarding",
    title: fallback.title,
    description: fallback.description,
    suggestions: fallback.suggestions,
    source: fallbackSource({
      scope: "onboarding",
      locale: input.locale,
      now: input.now,
      consolidationRunId: null,
    }),
    raw_text_included: false,
  };
}

export function generalFallbackView(input: {
  locale: AppLocale;
  now: Date;
  consolidationRunId: string | null;
}): NewChatBriefingView {
  const fallback = GENERAL_FALLBACK[input.locale];
  return {
    moment: formatMoment(input.now, input.locale),
    title: fallback.title,
    description: fallback.description,
    suggestions: fallback.suggestions,
    source: fallbackSource({
      scope: "general",
      locale: input.locale,
      now: input.now,
      consolidationRunId: input.consolidationRunId,
    }),
    raw_text_included: false,
  };
}

export function projectFallbackView(input: {
  project: ProjectBriefingInput;
  locale: AppLocale;
  now: Date;
  consolidationRunId: string | null;
}): NewChatBriefingView {
  const name = userFacingProjectName(input.project.displayName);
  return {
    moment: input.locale === "ko" ? "프로젝트" : "Project",
    title:
      input.locale === "ko"
        ? `${name}에서 이어갈 일을 살펴볼까요`
        : `What should we continue in ${name}?`,
    description:
      input.locale === "ko"
        ? `${name}에서 열어볼 만한 시작점 몇 가지가 있습니다.`
        : `A few ${name} starting points are ready.`,
    suggestions: projectFallbackSuggestions(name, input.locale),
    source: fallbackSource({
      scope: "project",
      locale: input.locale,
      now: input.now,
      consolidationRunId: input.consolidationRunId,
      projectId: input.project.id,
      projectName: name,
    }),
    raw_text_included: false,
  };
}

function fallbackSource(input: {
  scope: "general" | "project" | "onboarding";
  locale: AppLocale;
  now: Date;
  consolidationRunId: string | null;
  projectId?: string;
  projectName?: string;
}): NewChatBriefingView["source"] {
  return {
    scope: input.scope,
    content_origin: "heuristic_fallback",
    consolidation_run_id: input.consolidationRunId,
    generated_at: input.now.toISOString(),
    locale: input.locale,
    project_id: input.projectId,
    project_name: input.projectName,
    persona_applied: false,
    profile_projection_applied: false,
  };
}
