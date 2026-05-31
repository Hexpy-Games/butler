import type { NewChatBriefingSuggestion } from "@/app/types.ts";

export const GENERAL_FALLBACK_SUGGESTIONS: NewChatBriefingSuggestion[] = [
  {
    id: "daily-briefing",
    title: "오늘 볼 만한 소식",
    description:
      "날씨와 주요 이슈를 짧게 훑어두면 하루의 방향을 잡는 데 도움이 됩니다.",
    text: "오늘 볼 만한 날씨와 주요 이슈를 짧게 브리핑해줘.",
  },
  {
    id: "open-source-trends",
    title: "요즘 뜨는 오픈소스",
    description:
      "최근 주목받는 오픈소스 프로젝트를 살펴보고 영감을 얻을 수 있도록 정리해봐요.",
    text: "최근 주목받는 오픈소스 프로젝트를 이유와 활용처 중심으로 정리해줘.",
  },
  {
    id: "search-strategy",
    title: "검색어를 어떻게 나눌까",
    description:
      "넓은 질문을 몇 갈래로 나누면 빠르게 훑을 부분과 깊게 볼 부분을 더 잘 구분할 수 있습니다.",
    text: "넓은 검색 요청을 빠른 검색과 깊은 검색으로 나누는 기준을 정리해줘.",
  },
  {
    id: "web-standards-rendering",
    title: "브라우저마다 다르게 보이는 이유",
    description:
      "CSS 스펙과 실제 구현 차이를 같이 보면 UI 문제가 어디에서 생기는지 더 빨리 좁힐 수 있습니다.",
    text: "CSS 스펙과 브라우저별 렌더링 차이를 비교해서 설명해줘.",
  },
];

export function skillFallbackSuggestions(
  projectName: string,
): NewChatBriefingSuggestion[] {
  return [
    {
      id: "recent-skill",
      title: "반복된 부탁 찾기",
      description: "최근 대화에서 다시 설명한 절차와 취향을 골라냅니다.",
      text: "최근 대화에서 스킬로 만들어보면 유용한 게 어떤 게 있을까?",
    },
    {
      id: "useful-skill",
      title: "쓸모의 형태 정하기",
      description: "작은 자동화로 남길지, 스킬로 굳힐지 기준을 세웁니다.",
      text: "유용한 스킬이 뭐가 있을까?",
    },
    {
      id: "skill-candidates",
      title: "후보를 작업 카드로",
      description: "흩어진 반복 작업을 바로 검토할 수 있는 목록으로 만듭니다.",
      text: "최근 반복한 일을 스킬 후보로 골라줘",
    },
    {
      id: "project-skill",
      title: projectName ? "프로젝트 규칙 남기기" : "내 방식 남기기",
      description: projectName
        ? `${projectName}에서 반복되는 운영 방식을 정리합니다.`
        : "자주 하는 일을 다음에도 바로 꺼낼 수 있게 정리합니다.",
      text: projectName
        ? "이 프로젝트에 맞는 반복 작업을 스킬로 정리해줘"
        : "내가 자주 하는 반복 작업을 스킬로 정리해줘",
    },
  ];
}

export function projectFallbackSuggestions(
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
