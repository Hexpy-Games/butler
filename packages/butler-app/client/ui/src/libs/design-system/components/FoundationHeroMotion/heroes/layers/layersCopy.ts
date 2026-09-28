import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Layers hero. Token names and numbers never translate. */
export const LAYERS_COPY = {
  en: {
    title: "Layers",
    lead: [
      ["Order", "One named stacking order, from sticky headers to the drag ghost."],
      ["Separation", "Each layer lifts over the one below with its own surface and shadow."],
      ["Depth", "Depth comes from order, dimming and shadow."],
    ] as IntroLead,
    app: "Butler", inbox: "Inbox", weekly: "Weekly report", plan: "Launch plan", notes: "Meeting notes", today: "Today",
    chats: "Chats", projects: "Projects", files: "Files",
    dialogTitle: "Move to project", project: "Project", pick: "Design system", other: "Research",
    settings: "Settings", tip: "Open settings",
  },
  ko: {
    title: "Layers",
    lead: [
      ["순서", "고정 헤더부터 드래그 고스트까지, 이름 붙은 하나의 쌓임 순서."],
      ["분리", "각 층은 자기 표면과 그림자로 아래층 위에 떠오릅니다."],
      ["깊이", "깊이는 순서, 어둡게 하기, 그림자에서 나옵니다."],
    ] as IntroLead,
    app: "Butler", inbox: "받은 편지함", weekly: "주간 리포트", plan: "출시 계획", notes: "회의록", today: "오늘",
    chats: "대화", projects: "프로젝트", files: "파일",
    dialogTitle: "프로젝트로 이동", project: "프로젝트", pick: "디자인 시스템", other: "리서치",
    settings: "설정", tip: "설정 열기",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type LayersCopy = (typeof LAYERS_COPY)["en"];

/** The stacking order, low to high: the page, then each named layer (its z token). */
export const SHEETS = ["page", "sticky", "drawer", "overlay", "dialog", "popover", "tooltip", "drag"] as const;
export type Sheet = (typeof SHEETS)[number];

/** A z token's live value (the order is read from tokens.css at render). */
export function zValue(name: string): string {
  if (typeof document === "undefined" || name === "page") return "0";
  return getComputedStyle(document.documentElement).getPropertyValue(`--z-${name}`).trim() || "0";
}

/** Canvas px between exploded sheets. */
export const GAP = 34;
