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
    pointer: "pointer", touch: "touch", offRail: "off the rails",
    tag: "Filter", period: "Period", day: "Day", week: "Week", model: "Model", auto: "Automatic", find: "Find", send: "Send", save: "Save", cancel: "Cancel",
    product: "Butler", session: "Weekly report", project: "Workspace", local: "Local",
    sessionMenu: "Session menu", rightPanel: "Show right panel", showSidebar: "Show sidebar", hideSidebar: "Hide sidebar",
    newConversation: "New conversation", search: "Search", general: "General",
  },
  ko: {
    title: "Sizing",
    lead: [
      ["높이", "24부터 34까지 네 가지 컨트롤 높이. 모든 컨트롤은 그중 하나에 놓입니다."],
      ["누를 영역", "작은 컨트롤도 30px 영역을 지키고, 터치에서는 44로 커집니다."],
      ["크롬", "타이틀바와 사이드바 행은 이름 붙은 고정 치수를 씁니다."],
    ] as IntroLead,
    pointer: "포인터", touch: "터치", offRail: "레일 밖",
    tag: "필터", period: "기간", day: "일", week: "주", model: "모델", auto: "자동", find: "찾기", send: "보내기", save: "저장", cancel: "취소",
    product: "Butler", session: "주간 리포트", project: "워크스페이스", local: "로컬",
    sessionMenu: "세션 메뉴", rightPanel: "오른쪽 패널 보기", showSidebar: "사이드바 보기", hideSidebar: "사이드바 숨기기",
    newConversation: "새 대화", search: "검색", general: "일반",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type SizingCopy = (typeof SIZING_COPY)["en"];

/** The four rails (px as in tokens.css; lanes are drawn with the live tokens). */
export const RAILS = [
  { name: "xs", px: 24 }, { name: "sm", px: 28 }, { name: "md", px: 30 }, { name: "lg", px: 34 },
] as const;

/** Hit targets: pointer and touch (px as in tokens.css). */
export const HIT = { pointer: 30, touch: 44 } as const;
