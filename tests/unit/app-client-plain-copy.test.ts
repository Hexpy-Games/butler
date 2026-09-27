import { expect, test } from "bun:test";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";

type Copy = ReturnType<typeof getAppCopy>;

const locales = ["en-US", "ko-KR"] as const;

/** Agent internals that the default UI must not name. */
const INTERNAL_TERMS = [/Steward/u, /Ledger/u, /원장/u, /Gateway/u, /Worker/iu, /automation/iu, /자동화/u];
/** Skill writing waits for #222. */
const SKILL_TERMS = [/skill/iu, /스킬/u];

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function offending(texts: string[], terms: RegExp[]): string[] {
  return texts.filter((text) => terms.some((term) => term.test(text)));
}

/** Copy on screens every user sees before turning on developer mode. */
function defaultSurfaceCopy(copy: Copy): string[] {
  return strings([
    copy.inspector.tabs.summary,
    copy.inspector.tabs.artifacts,
    copy.inspector.tabs.automations,
    copy.automations.inspector.empty,
    copy.interfacePanels.progress,
    copy.interfacePanels.noProgress,
    copy.interfacePanels.noPlans,
    copy.interfacePanels.noSpecs,
    copy.composer.gitMissingTitle,
    copy.composer.gitMissingMessage,
    copy.interfaceFeedback.stewardStopFailed,
    copy.interfaceFeedback.stewardResumeFailed,
    copy.projectSignpost,
    copy.projectStatistics,
  ]);
}

function suggestionCopy(copy: Copy, projectName: string) {
  return {
    general: copy.briefing.general.suggestions,
    project: copy.briefing.projectSuggestions(projectName),
  };
}

for (const locale of locales) {
  test(`default surfaces avoid agent internal names (${locale})`, () => {
    expect(offending(defaultSurfaceCopy(getAppCopy(locale)), INTERNAL_TERMS)).toEqual([]);
  });

  test(`starter suggestions are everyday tasks without skills or internals (${locale})`, () => {
    const { general, project } = suggestionCopy(getAppCopy(locale), "Garden");
    for (const suggestions of [general, project]) {
      expect(suggestions.length).toBeGreaterThanOrEqual(4);
      expect(suggestions.length).toBeLessThanOrEqual(6);
      const texts = strings(suggestions.map(({ title, description, text }) => ({ title, description, text })));
      expect(offending(texts, [...INTERNAL_TERMS, ...SKILL_TERMS])).toEqual([]);
      for (const suggestion of suggestions) {
        expect(suggestion.title.trim()).not.toBe("");
        expect(suggestion.description.trim()).not.toBe("");
        expect(suggestion.text.trim()).not.toBe("");
      }
    }
    expect(project.some((suggestion) => `${suggestion.description} ${suggestion.text}`.includes("Garden"))).toBe(true);
  });
}

test("starter suggestions keep locale parity", () => {
  const shape = (locale: (typeof locales)[number]) => {
    const { general, project } = suggestionCopy(getAppCopy(locale), "Garden");
    return [general, project].map((suggestions) =>
      suggestions.map((suggestion) => [suggestion.id, suggestion.template === true]),
    );
  };
  expect(shape("ko-KR")).toEqual(shape("en-US"));
});

test("starter suggestions cover the everyday tasks Butler can do", () => {
  const { general, project } = suggestionCopy(getAppCopy("en-US"), "Garden");
  expect(general.map((suggestion) => suggestion.id)).toEqual([
    "summarize-document",
    "draft-reply",
    "morning-briefing",
    "plan-week",
    "explain-simply",
  ]);
  expect(project.map((suggestion) => suggestion.id)).toEqual([
    "folder-tour",
    "organize-files",
    "recent-changes",
    "remaining-work",
    "project-blockers",
  ]);
  // A morning briefing is a schedule, named in the product's own terms.
  const morning = general.find((suggestion) => suggestion.id === "morning-briefing")!;
  expect(`${morning.title} ${morning.description}`).toMatch(/schedule/iu);
  const koMorning = getAppCopy("ko-KR").briefing.general.suggestions.find((suggestion) => suggestion.id === "morning-briefing")!;
  expect(`${koMorning.title} ${koMorning.description}`).toContain("예약 작업");
  // Suggestions that need the user's own input fill the composer instead of sending.
  expect(general.filter((suggestion) => suggestion.template).map((suggestion) => suggestion.id)).toEqual([
    "summarize-document",
    "draft-reply",
    "morning-briefing",
    "explain-simply",
  ]);
  expect(project.filter((suggestion) => suggestion.template).map((suggestion) => suggestion.id)).toEqual([
    "organize-files",
  ]);
});

test("the Korean dashboard Work tab is translated", () => {
  expect(getAppCopy("ko-KR").projectSignpost.work).toBe("작업");
});
