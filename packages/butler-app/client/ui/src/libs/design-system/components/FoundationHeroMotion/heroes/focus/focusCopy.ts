import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Focus ring hero. Token names, key names and numbers never translate. */
export const FOCUS_COPY = {
  en: {
    title: "Focus", title2: "ring",
    lead: [
      ["One ring", "Every focusable control shows the same accent ring, shaped to its own corner."],
      ["The route", "Tab walks the page in reading order; arrow keys walk inside a group."],
      ["Back", "Shift+Tab walks the route back, stop by stop."],
    ] as IntroLead,
    continue: "Continue", name: "Butler", week: "Week", month: "Month", autoSave: "Auto-save",
    chats: "Chats", projects: "Projects", files: "Files",
    ask: "What changed this week?", reply: "Three changes landed since Monday.",
    placeholder: "Ask Butler anything", typed: "Summarize…", send: "Send",
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
    chats: "대화", projects: "프로젝트", files: "파일",
    ask: "이번 주에 뭐가 바뀌었어?", reply: "월요일 이후 세 가지가 바뀌었어요.",
    placeholder: "Butler에게 무엇이든 물어보세요", typed: "요약해 줘…", send: "보내기",
    summary: "요약", activity: "활동", filesTab: "파일", open: "열기",
    roving: "roving focus", regions: ["사이드바", "목록", "컴포저"],
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type FocusCopy = (typeof FOCUS_COPY)["en"];

/** The ring's gap outside a control (px): the ring sits on the control's edge, drawn by --focus-ring. */
export const RING_PAD = 0;
