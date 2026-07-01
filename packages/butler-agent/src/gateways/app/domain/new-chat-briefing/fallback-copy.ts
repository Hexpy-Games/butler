import type { AppLocale, BriefingFallbackCopy } from "./briefing-types.ts";

export const GENERAL_FALLBACK: Record<AppLocale, BriefingFallbackCopy> = {
  ko: {
    title: "오늘의 일을 같이 펼쳐볼까요",
    description: "짧게 열어볼 만한 시작점 몇 가지가 있습니다.",
    suggestions: [
      {
        id: "daily-briefing",
        title: "오늘 볼 만한 소식",
        description:
          "주요 이슈와 공개 자료를 짧게 훑어두면 하루의 방향을 잡는 데 도움이 됩니다.",
        text: "오늘 볼 만한 주요 이슈와 공개 자료를 짧게 브리핑해줘.",
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
    ],
  },
  en: {
    title: "What should we open today?",
    description: "A few simple starting points are ready.",
    suggestions: [
      {
        id: "daily-briefing",
        title: "Worth a short look today",
        description:
          "A compact pass over notable news and public sources can make the day easier to place.",
        text: "Give me a short briefing on today's notable news and public sources.",
      },
      {
        id: "open-source-trends",
        title: "Open source getting attention",
        description:
          "Looking at projects gaining attention can surface useful ideas and patterns.",
        text: "Summarize recent open-source projects by why they are gaining attention and where they may be useful.",
      },
      {
        id: "search-strategy",
        title: "How to split the search",
        description:
          "Splitting a broad question helps separate quick scanning from deeper verification.",
        text: "Lay out a way to split broad research into quick search and deeper verification.",
      },
      {
        id: "web-standards-rendering",
        title: "Why browsers render differently",
        description:
          "Comparing CSS specs with browser behavior can make rendering issues easier to narrow down.",
        text: "Compare CSS specs with browser rendering differences.",
      },
    ],
  },
};

export const ONBOARDING_FALLBACK: Record<AppLocale, BriefingFallbackCopy> = {
  ko: {
    title: "반갑습니다. 당신을 모시게 되어 기쁩니다.",
    description:
      "AI 에이전트 집사 버틀러를 선택해주셔서 감사합니다. 시작하기에 앞서 간단하게 당신에 대해 알려주세요.",
    suggestions: [
      {
        id: "butler-onboarding",
        title: "버틀러와 알아가기",
        description: "버틀러를 사용하기에 앞서 기본적인 설정을 진행합니다.",
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
