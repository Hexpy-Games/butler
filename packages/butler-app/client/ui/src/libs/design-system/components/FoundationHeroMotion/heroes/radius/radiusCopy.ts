import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Radius and elevation hero. Token names and numbers never translate. */
export const RADIUS_COPY = {
  en: {
    title: "Radius",
    lead: [
      ["Corners", "Radius grows with the surface: controls 8, panels 10, popovers 12, the composer rounder still."],
      ["Nesting", "An inner corner is never rounder than the corner around it."],
      ["Elevation", "Three soft shadows lift controls, cards and windows; nothing else floats."],
    ] as IntroLead,
    topics: { controls: "Controls", surface: "Surface", overlay: "Overlay", composer: "Composer" },
    day: "Day", week: "Week", month: "Month", autoSave: "Auto-save",
    panelTitle: "Weekly report", panelBody: "Your summary is ready to share.",
    rename: "Rename", duplicate: "Duplicate", archive: "Archive",
    placeholder: "Ask Butler anything", more: "More", send: "Send",
    low: "low", medium: "medium", high: "high",
  },
  ko: {
    title: "Radius",
    lead: [
      ["모서리", "표면이 클수록 모서리가 커집니다. 컨트롤 8, 패널 10, 팝오버 12, 컴포저는 더 둥글게."],
      ["중첩", "안쪽 모서리는 바깥 모서리보다 둥글지 않습니다."],
      ["높이", "부드러운 그림자 세 단계가 컨트롤·카드·창을 띄웁니다. 그 밖엔 뜨지 않습니다."],
    ] as IntroLead,
    topics: { controls: "컨트롤", surface: "표면", overlay: "오버레이", composer: "컴포저" },
    day: "일", week: "주", month: "월", autoSave: "자동 저장",
    panelTitle: "주간 리포트", panelBody: "요약을 공유할 준비가 됐어요.",
    rename: "이름 바꾸기", duplicate: "복제", archive: "보관",
    placeholder: "Butler에게 무엇이든 물어보세요", more: "더 보기", send: "보내기",
    low: "낮음", medium: "중간", high: "높음",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type RadiusCopy = (typeof RADIUS_COPY)["en"];

/** The radius ladder the square morphs through (px as in tokens.css; drawn with the live tokens). */
export const RADII = [
  { token: "--radius-control", value: "8" }, { token: "--radius-panel", value: "10" }, { token: "--radius-popover", value: "12" },
  { token: "--radius-composer", value: "22" }, { token: "--radius-pill", value: "999" },
] as const;

/** Elevation levels (SurfacePanel) and the shadow token each uses. */
export const LEVELS = [
  { elevation: "low", token: "--shadow-control" }, { elevation: "medium", token: "--shadow-card" }, { elevation: "high", token: "--shadow-window" },
] as const;
