import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Sizing hero. Token names and numbers never translate. */
export const SIZING_COPY = {
  en: {
    title: "Sizing",
    lead: [
      ["Heights", "Four control heights, 24 to 34; every control sits on one of them."],
      ["Hit targets", "Small controls keep a 30px target; touch grows it to 44."],
      ["Chrome", "Titlebar and sidebar rows take fixed, named measures."],
    ] as IntroLead,
    pointer: "pointer", touch: "touch", offRail: "32 · off the rails",
    tag: "Filter", more: "More", save: "Save", search: "Search", query: "Weekly report", find: "Find",
    title2: "Butler", subtitle: "Workspace", newChat: "New chat", settings: "Settings",
    auto: "Automatic", autoSend: "Send on Enter",
    chats: "Chats", projects: "Projects", files: "Files",
  },
  ko: {
    title: "Sizing",
    lead: [
      ["높이", "24부터 34까지 네 가지 컨트롤 높이. 모든 컨트롤은 그중 하나에 놓입니다."],
      ["누를 영역", "작은 컨트롤도 30px 영역을 지키고, 터치에서는 44로 커집니다."],
      ["크롬", "타이틀바와 사이드바 행은 이름 붙은 고정 치수를 씁니다."],
    ] as IntroLead,
    pointer: "포인터", touch: "터치", offRail: "32 · 레일 밖",
    tag: "필터", more: "더 보기", save: "저장", search: "검색", query: "주간 리포트", find: "찾기",
    title2: "Butler", subtitle: "워크스페이스", newChat: "새 대화", settings: "설정",
    auto: "자동", autoSend: "Enter로 보내기",
    chats: "대화", projects: "프로젝트", files: "파일",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type SizingCopy = (typeof SIZING_COPY)["en"];

/** The four rails (px as in tokens.css; lanes are drawn with the live tokens). */
export const RAILS = [
  { name: "xs", px: 24 }, { name: "sm", px: 28 }, { name: "md", px: 30 }, { name: "lg", px: 34 },
] as const;

/** Hit targets: pointer and touch (px as in tokens.css). */
export const HIT = { pointer: 30, touch: 44 } as const;

/** The icon buttons' own size (Button icon-xs, --control-height-xs). */
export const ICON = 24;
