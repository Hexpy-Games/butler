import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Focus ring hero. Token names, key names and numbers never translate. */
export const FOCUS_COPY = {
  en: {
    title: "Focus ring",
    lead: [
      ["One ring", "Every focusable control shows the same accent ring on :focus-visible."],
      ["Keyboard", "Tab moves it forward through the order, Shift+Tab walks it back."],
      ["Shape", "Two pixels wide, it follows each control's own corner radius."],
    ] as IntroLead,
    topics: { button: "Button", field: "Field", toggle: "Switch", tabs: "Tabs" },
    continue: "Continue", name: "Butler", sidebar: "Sidebar", week: "Week", month: "Month",
    summary: "Summary", files: "Files", workers: "Workers", email: "you@example.com",
  },
  ko: {
    title: "Focus ring",
    lead: [
      ["하나의 링", "포커스를 받는 모든 컨트롤은 :focus-visible에서 같은 강조색 링을 보입니다."],
      ["키보드", "Tab은 순서대로 앞으로, Shift+Tab은 뒤로 링을 옮깁니다."],
      ["모양", "2픽셀 두께로, 각 컨트롤의 모서리 반경을 그대로 따릅니다."],
    ] as IntroLead,
    topics: { button: "버튼", field: "입력", toggle: "스위치", tabs: "탭" },
    continue: "계속", name: "Butler", sidebar: "사이드바", week: "주", month: "월",
    summary: "요약", files: "파일", workers: "작업자", email: "you@example.com",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type FocusCopy = (typeof FOCUS_COPY)["en"];

/** The focus tokens the field lists. */
export const RING_TOKENS: Array<[token: string, value: string]> = [
  ["--focus-ring", "0 0 0 2px"], ["--focus-ring-width", "2px"], ["--focus-ring-color", "--color-action-primary"],
];
