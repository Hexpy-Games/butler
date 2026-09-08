import type { NewChatBriefingView } from "../../interface/protocol/app-protocol.ts";
import { getAppCopy, appLocaleFromLanguage } from "../../../../../../butler-i18n/src/index.ts";
import {
  formatMoment,
  userFacingProjectName,
} from "./briefing-format.ts";
import type {
  AppLocale,
  ProjectBriefingInput,
} from "./briefing-types.ts";

export function onboardingFallbackView(input: {
  locale: AppLocale;
  now: Date;
}): NewChatBriefingView {
  const fallback = getAppCopy(appLocaleFromLanguage(input.locale)).briefing.onboarding;
  return {
    moment: getAppCopy(appLocaleFromLanguage(input.locale)).briefing.onboardingMoment,
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
  const fallback = getAppCopy(appLocaleFromLanguage(input.locale)).briefing.general;
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
    moment: getAppCopy(appLocaleFromLanguage(input.locale)).briefing.projectMoment,
    title:
      getAppCopy(appLocaleFromLanguage(input.locale)).briefing.projectTitle(name),
    description:
      getAppCopy(appLocaleFromLanguage(input.locale)).briefing.projectDescription(name),
    suggestions: getAppCopy(appLocaleFromLanguage(input.locale)).briefing.projectSuggestions(name),
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
