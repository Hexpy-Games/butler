import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Layout hero. Token names, numbers and mode names never translate. */
export const LAYOUT_COPY = {
  en: {
    title: "Layout",
    lead: [
      ["Frame", "One page frame: columns, a gutter, a max width, the titlebar and safe areas."],
      ["Modes", "One shell in three modes, expanded to compact; the sidebar becomes a drawer."],
      ["Platform", "Breakpoints are constants in responsive.ts; insets come from the device."],
    ] as IntroLead,
    source: "responsive.ts",
    menu: "Menu", device: "device insets",
    app: "Butler", chats: "Chats", projects: "Projects", files: "Files",
    cards: ["Weekly report", "Launch plan", "Meeting notes"],
    notes: ["Updated today", "3 tasks left", "Shared with 4"],
  },
  ko: {
    title: "Layout",
    lead: [
      ["프레임", "하나의 페이지 프레임: 열, 거터, 최대 너비, 타이틀바와 안전 영역."],
      ["모드", "하나의 셸, 세 가지 모드. 좁아지면 사이드바는 서랍이 됩니다."],
      ["플랫폼", "중단점은 responsive.ts의 상수이고, 여백은 기기가 정합니다."],
    ] as IntroLead,
    source: "responsive.ts",
    menu: "메뉴", device: "기기 여백",
    app: "Butler", chats: "대화", projects: "프로젝트", files: "파일",
    cards: ["주간 리포트", "출시 계획", "회의록"],
    notes: ["오늘 업데이트", "남은 작업 3개", "4명과 공유"],
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type LayoutCopy = (typeof LAYOUT_COPY)["en"];

/** The widths the handle drags the frame through, and each one's mode (responsive.ts: compactMax 640, mediumMax 1023). */
export const WIDTHS = [
  { px: 1280, mode: "expanded", columns: 3 },
  { px: 1023, mode: "medium", columns: 2 },
  { px: 640, mode: "compact", columns: 1 },
  { px: 375, mode: "compact", columns: 1 },
] as const;

export const MODES = ["expanded", "medium", "compact"] as const;

/** A token's live value from tokens.css, read at render. */
export function tokenValue(token: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

/** The device height every width is shown at (px). */
export const DEVICE_H = 720;

/** Canvas px per device px of the resizing window, per canvas. */
export const ZOOM = { wide: 0.6, tall: 0.26 } as const;
