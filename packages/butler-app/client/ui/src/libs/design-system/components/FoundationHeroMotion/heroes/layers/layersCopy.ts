import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Layers hero. Token names and numbers never translate. */
export const LAYERS_COPY = {
  en: {
    title: "Layers",
    lead: [
      ["Order", "One named stacking order, from sticky headers to the drag ghost."],
      ["Separation", "Each layer lifts over the one below with its own surface and shadow."],
      ["Flat", "Depth reads through stacking, dimming and shadow, never tilt."],
    ] as IntroLead,
    separate: "separate", page: "page",
    topics: { sticky: "Sticky header", drawer: "Drawer", dialog: "Dialog", tooltip: "Tooltip" },
    inbox: "Inbox", today: "Today", yesterday: "Yesterday", weekly: "Weekly report", plan: "Launch plan", notes: "Meeting notes",
    chats: "Chats", projects: "Projects", files: "Files",
    dialogTitle: "Move to project", project: "Project", pick: "Design system", other: "Research",
    settings: "Settings", tip: "Open settings",
  },
  ko: {
    title: "Layers",
    lead: [
      ["순서", "고정 헤더부터 드래그 고스트까지, 이름 붙은 하나의 쌓임 순서."],
      ["분리", "각 층은 자기 표면과 그림자로 아래층 위에 떠오릅니다."],
      ["평면", "깊이는 기울기가 아니라 쌓임·어둡게 하기·그림자로 읽힙니다."],
    ] as IntroLead,
    separate: "분리", page: "페이지",
    topics: { sticky: "고정 헤더", drawer: "서랍", dialog: "대화상자", tooltip: "툴팁" },
    inbox: "받은 편지함", today: "오늘", yesterday: "어제", weekly: "주간 리포트", plan: "출시 계획", notes: "회의록",
    chats: "대화", projects: "프로젝트", files: "파일",
    dialogTitle: "프로젝트로 이동", project: "프로젝트", pick: "디자인 시스템", other: "리서치",
    settings: "설정", tip: "설정 열기",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type LayersCopy = (typeof LAYERS_COPY)["en"];

/** The stacking order, low to high. */
export const Z = ["sticky", "drawer", "overlay", "dialog", "popover", "tooltip", "drag"] as const;

/** A z token's live value (the order is read from tokens.css at render). */
export function zValue(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(`--z-${name}`).trim();
}
