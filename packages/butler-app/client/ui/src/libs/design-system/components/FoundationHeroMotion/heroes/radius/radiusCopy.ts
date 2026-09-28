import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { HeroLayout } from "../shared/grid";
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
    loupe: "×16",
    button: "Save", tag: "Draft",
    panelTitle: "Weekly report", panelBody: "Your summary is ready to share.",
    rename: "Rename", duplicate: "Duplicate", archive: "Archive",
    placeholder: "Ask Butler anything", more: "More", send: "Send",
    low: "low", medium: "medium", high: "high",
    height: "height",
  },
  ko: {
    title: "Radius",
    lead: [
      ["모서리", "표면이 클수록 모서리가 커집니다. 컨트롤 8, 패널 10, 팝오버 12, 컴포저는 더 둥글게."],
      ["중첩", "안쪽 모서리는 바깥 모서리보다 둥글지 않습니다."],
      ["높이", "부드러운 그림자 세 단계가 컨트롤·카드·창을 띄웁니다. 그 밖엔 뜨지 않습니다."],
    ] as IntroLead,
    loupe: "×16",
    button: "저장", tag: "초안",
    panelTitle: "주간 리포트", panelBody: "요약을 공유할 준비가 됐어요.",
    rename: "이름 바꾸기", duplicate: "복제", archive: "보관",
    placeholder: "Butler에게 무엇이든 물어보세요", more: "더 보기", send: "보내기",
    low: "낮음", medium: "중간", high: "높음",
    height: "높이",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type RadiusCopy = (typeof RADIUS_COPY)["en"];

/** The radius ladder the corner morphs through (px as in tokens.css), and who wears each. */
export const RADII = [
  { token: "--radius-control", px: 8, who: "control" }, { token: "--radius-panel", px: 10, who: "panel" },
  { token: "--radius-popover", px: 12, who: "popover" }, { token: "--radius-composer", px: 22, who: "composer" },
  { token: "--radius-pill", px: 999, who: "pill" },
] as const;

/** Elevation levels (SurfacePanel), the shadow token each uses, and how high it rises off the floor (canvas px). */
export const LEVELS = [
  { elevation: "low", token: "--shadow-control", rise: 14 }, { elevation: "medium", token: "--shadow-card", rise: 30 },
  { elevation: "high", token: "--shadow-window", rise: 56 },
] as const;

/** The corner specimen: drawn this many times larger, on a grid of one line per real pixel. */
export const LOUPE = 16;

/**
 * The corner specimen's geometry in its stage (canvas px): the corner point
 * the scene looks at, and the surface, tall enough that the pill (half its
 * height) is rounder than the composer.
 */
export const SPECIMEN: Record<HeroLayout, { stage: { w: number; h: number }; corner: { x: number; y: number }; surface: { w: number; h: number } }> = {
  wide: { stage: { w: 1040, h: 585 }, corner: { x: 250, y: 120 }, surface: { w: 1600, h: 800 } },
  tall: { stage: { w: 380, h: 640 }, corner: { x: 20, y: 80 }, surface: { w: 720, h: 1000 } },
};

/** A radius on the specimen (the pill is half the surface's shorter side). */
export const specimenRadius = (px: number, layout: HeroLayout) => Math.min(px * LOUPE, Math.min(SPECIMEN[layout].surface.w, SPECIMEN[layout].surface.h) / 2);
