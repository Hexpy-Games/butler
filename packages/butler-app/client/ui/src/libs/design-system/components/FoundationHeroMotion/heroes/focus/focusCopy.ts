import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Focus ring hero; the shell uses the app's own strings. Token names, key names and numbers never translate. */
export const FOCUS_COPY = {
  en: {
    title: "Focus", title2: "ring",
    lead: [
      ["One ring", "Every focusable control shows the same accent ring, shaped to its own corner."],
      ["The route", "Tab walks the page in reading order; arrow keys walk inside a group."],
      ["Back", "Shift+Tab walks the route back, stop by stop."],
    ] as IntroLead,
    continue: "Continue", name: "Butler", week: "Week", month: "Month", autoSave: "Auto-save",
    app: "Butler", newChat: "New chat", search: "Search", views: "Views", all: "All", recent: "Recent", running: "Running",
    chat: "Weekly review", chatMeta: "now", settings: "Settings",
    ask: "What changed this week?", reply: "Three changes landed since Monday: the sidebar density, the composer toolbar and the release notes.",
    placeholder: "Ask Butler anything", typed: "Summarize them", more: "More", access: "Ask first", model: "GPT-5.1", send: "Send",
    summary: "Summary", activity: "Activity", filesTab: "Files", open: "Open",
    roving: "roving focus", regions: ["sidebar", "list", "composer"],
  },
  ko: {
    title: "Focus", title2: "ring",
    lead: [
      ["하나의 링", "포커스를 받는 모든 컨트롤은 같은 강조색 링을 보이고, 각자의 모서리를 따릅니다."],
      ["경로", "Tab은 읽는 순서대로 영역을 옮기고, 방향키는 한 그룹 안을 걷습니다."],
      ["되돌아가기", "Shift+Tab은 경로를 한 정거장씩 되짚습니다."],
    ] as IntroLead,
    continue: "계속", name: "Butler", week: "주", month: "월", autoSave: "자동 저장",
    app: "Butler", newChat: "새 대화", search: "검색", views: "대화 보기", all: "전체보기", recent: "최신", running: "진행중",
    chat: "주간 회고", chatMeta: "지금", settings: "설정",
    ask: "이번 주에 뭐가 바뀌었어?", reply: "월요일 이후 세 가지가 바뀌었어요. 사이드바 밀도, 컴포저 도구 막대, 릴리스 노트입니다.",
    placeholder: "Butler에게 무엇이든 물어보세요", typed: "요약해 줘", more: "추가 기능", access: "먼저 확인", model: "GPT-5.1", send: "전송",
    summary: "요약", activity: "활동", filesTab: "파일", open: "열기",
    roving: "roving focus", regions: ["사이드바", "목록", "컴포저"],
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type FocusCopy = (typeof FOCUS_COPY)["en"];
