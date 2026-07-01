import type { NewChatBriefingSuggestion } from "../../interface/protocol/app-protocol.ts";
import type { AppLocale } from "./briefing-types.ts";

export function projectFallbackSuggestions(
  projectName: string,
  locale: AppLocale,
): NewChatBriefingSuggestion[] {
  if (locale === "en") return englishProjectFallbackSuggestions(projectName);
  return koreanProjectFallbackSuggestions(projectName);
}

function englishProjectFallbackSuggestions(
  projectName: string,
): NewChatBriefingSuggestion[] {
  return [
    {
      id: "review-commits",
      title: "Check the risky parts first",
      description:
        "Recent changes can show the verification points worth looking at before continuing.",
      text: "Review recent changes for risks and missing validation.",
    },
    {
      id: "today-plan",
      title: "Set today's order",
      description:
        "Open work is easier to continue when it is arranged into a small sequence.",
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
      description:
        "Ideas and notes can become usable cards before they drift out of view.",
      text: "Turn leftover ideas into work cards.",
    },
  ];
}

function koreanProjectFallbackSuggestions(
  projectName: string,
): NewChatBriefingSuggestion[] {
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
