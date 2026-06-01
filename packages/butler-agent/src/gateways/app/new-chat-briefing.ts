import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  readNewChatBriefingArtifact,
  type NewChatBriefingArtifact,
  type NewChatBriefingLocale,
  type NewChatBriefingTitleBucket,
} from "../../agent/cognition/consolidation/new-chat-briefing.ts";
import { readFirstChatOnboardingState } from "../../personalization/onboarding.ts";
import type { NewChatBriefingSuggestion, NewChatBriefingView } from "./protocol.ts";

type AppLocale = "ko" | "en";

interface BuildNewChatBriefingInput {
  butlerData: string;
  preferredLocale: AppLocale;
  date?: string | null;
  now?: Date;
  project?: ProjectBriefingInput;
}

interface ConsolidationRunSummary {
  run_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
}

interface ProjectBriefingInput {
  id: string;
  displayName: string;
  documents?: unknown;
}

const GENERAL_FALLBACK: Record<AppLocale, {
  title: string;
  description: string;
  suggestions: NewChatBriefingSuggestion[];
}> = {
  ko: {
    title: "오늘의 일을 같이 펼쳐볼까요",
    description: "짧게 열어볼 만한 시작점 몇 가지가 있습니다.",
    suggestions: [
      {
        id: "daily-briefing",
        title: "오늘 볼 만한 소식",
        description: "날씨와 주요 이슈를 짧게 훑어두면 하루의 방향을 잡는 데 도움이 됩니다.",
        text: "오늘 볼 만한 날씨와 주요 이슈를 짧게 브리핑해줘.",
      },
      {
        id: "open-source-trends",
        title: "요즘 뜨는 오픈소스",
        description: "최근 주목받는 오픈소스 프로젝트를 살펴보고 영감을 얻을 수 있도록 정리해봐요.",
        text: "최근 주목받는 오픈소스 프로젝트를 이유와 활용처 중심으로 정리해줘.",
      },
      {
        id: "search-strategy",
        title: "검색어를 어떻게 나눌까",
        description: "넓은 질문을 몇 갈래로 나누면 빠르게 훑을 부분과 깊게 볼 부분을 더 잘 구분할 수 있습니다.",
        text: "넓은 검색 요청을 빠른 검색과 깊은 검색으로 나누는 기준을 정리해줘.",
      },
      {
        id: "web-standards-rendering",
        title: "브라우저마다 다르게 보이는 이유",
        description: "CSS 스펙과 실제 구현 차이를 같이 보면 UI 문제가 어디에서 생기는지 더 빨리 좁힐 수 있습니다.",
        text: "CSS 스펙과 브라우저별 렌더링 차이를 비교해서 설명해줘.",
      },
    ],
  },
  en: {
    title: "What should we open today?",
    description: "A few simple starting points are ready.",
    suggestions: [
      {
        id: "daily-briefing",
        title: "Worth a short look today",
        description: "A compact pass over weather and notable news can make the day easier to place.",
        text: "Give me a short briefing on today's weather and notable news.",
      },
      {
        id: "open-source-trends",
        title: "Open source getting attention",
        description: "Looking at projects gaining attention can surface useful ideas and patterns.",
        text: "Summarize recent open-source projects by why they are gaining attention and where they may be useful.",
      },
      {
        id: "search-strategy",
        title: "How to split the search",
        description: "Splitting a broad question helps separate quick scanning from deeper verification.",
        text: "Lay out a way to split broad research into quick search and deeper verification.",
      },
      {
        id: "web-standards-rendering",
        title: "Why browsers render differently",
        description: "Comparing CSS specs with browser behavior can make rendering issues easier to narrow down.",
        text: "Compare CSS specs with browser rendering differences.",
      },
    ],
  },
};

const ONBOARDING_FALLBACK: Record<AppLocale, {
  title: string;
  description: string;
  suggestions: NewChatBriefingSuggestion[];
}> = {
  ko: {
    title: "반갑습니다. 당신을 모시게 되어 기쁩니다.",
    description:
      "AI 에이전트 집사 버틀러를 선택해주셔서 감사합니다. 시작하기에 앞서 간단하게 당신에 대해 알려주세요.",
    suggestions: [
      {
        id: "butler-onboarding",
        title: "버틀러와 알아가기",
        description:
          "버틀러를 사용하기에 앞서 기본적인 설정을 진행합니다.",
        text: "버틀러를 사용하기에 앞서 기본적인 설정을 진행하자.",
      },
    ],
  },
  en: {
    title: "Pleased to meet you. It will be my honor to serve.",
    description:
      "Thank you for choosing Butler, your AI agent butler. Before we begin, please tell me a little about yourself.",
    suggestions: [
      {
        id: "butler-onboarding",
        title: "Get acquainted with Butler",
        description: "Set up the basics before using Butler.",
        text: "Let's set up the basics before I start using Butler.",
      },
    ],
  },
};

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

function viewFromArtifact(
  artifact: NewChatBriefingArtifact,
  now: Date,
): NewChatBriefingView {
  return {
    moment: artifact.scope === "general" && artifact.title_variants
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

function firstChatOnboardingPending(butlerData: string): boolean {
  return readFirstChatOnboardingState(butlerData).status !== "complete";
}

function onboardingFallbackView(input: {
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

function generalFallbackView(input: {
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

function projectFallbackView(input: {
  project: ProjectBriefingInput;
  locale: AppLocale;
  now: Date;
  consolidationRunId: string | null;
}): NewChatBriefingView {
  const name = userFacingProjectName(input.project.displayName);
  return {
    moment: input.locale === "ko" ? "프로젝트" : "Project",
    title: input.locale === "ko"
      ? `${name}에서 이어갈 일을 살펴볼까요`
      : `What should we continue in ${name}?`,
    description: input.locale === "ko"
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

function projectFallbackSuggestions(
  projectName: string,
  locale: AppLocale,
): NewChatBriefingSuggestion[] {
  if (locale === "en") {
    return [
      {
        id: "review-commits",
        title: "Check the risky parts first",
        description: "Recent changes can show the verification points worth looking at before continuing.",
        text: "Review recent changes for risks and missing validation.",
      },
      {
        id: "today-plan",
        title: "Set today's order",
        description: "Open work is easier to continue when it is arranged into a small sequence.",
        text: "Turn today's remaining work into an execution order.",
      },
      {
        id: "project-blockers",
        title: "Mark what is stuck",
        description: `Narrowing the stalled points in ${projectName} keeps the next step clearer.`,
        text: `Find the blocked points in ${projectName}.`,
      },
      {
        id: "briefing-seed",
        title: "Bring back the loose notes",
        description: "Ideas and notes can become usable cards before they drift out of view.",
        text: "Turn leftover ideas into work cards.",
      },
    ];
  }
  return [
    {
      id: "review-commits",
      title: "위험한 부분 먼저 보기",
      description: "최근 변경사항에서 놓친 검증과 되돌아볼 지점을 찾습니다.",
      text: "최근 변경사항의 위험과 빠진 검증을 훑어줘",
    },
    {
      id: "today-plan",
      title: "오늘의 순서 세우기",
      description: "열린 일들을 실행 가능한 순서로 다시 얇게 펼칩니다.",
      text: "오늘 이어갈 일을 실행 순서로 정리해줘",
    },
    {
      id: "project-blockers",
      title: "막힌 곳에 표시하기",
      description: `${projectName} 안에서 결정이 멈춘 지점을 좁힙니다.`,
      text: `${projectName}에서 막힌 지점을 찾아줘`,
    },
    {
      id: "briefing-seed",
      title: "남겨둔 생각 꺼내기",
      description: "아이디어와 메모를 다음 행동으로 옮길 수 있게 접습니다.",
      text: "남겨둔 아이디어를 작업 카드로 바꿔줘",
    },
  ];
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

function latestConsolidationRun(
  butlerData: string,
  sourceDate?: string | null,
): ConsolidationRunSummary | null {
  const runsDir = join(butlerData, "cognition", "consolidation", "runs");
  if (!existsSync(runsDir)) return null;
  return readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(runsDir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map(({ path }) => readJsonFile<ConsolidationRunSummary>(path))
    .find((run) => {
      if (!run || run.status !== "completed") return false;
      if (!sourceDate) return true;
      return datePart(run.completed_at) === sourceDate ||
        datePart(run.started_at) === sourceDate;
    }) ?? null;
}

function userFacingProjectName(projectName: string): string {
  return projectName === "butler" ? "Butler" : projectName;
}

function formatMoment(date: Date, locale: NewChatBriefingLocale): string {
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function timeOfDay(date: Date): NewChatBriefingTitleBucket {
  const hour = date.getHours();
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

function datePart(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/u.test(value)) return null;
  return value.slice(0, 10);
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
