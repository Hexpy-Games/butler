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
      ["Elevation", "Three soft shadows: a pressed control, a dragged card, a window over content."],
    ] as IntroLead,
    loupe: "×16",
    button: "Save", tag: "Draft",
    panelTitle: "Weekly report", panelBody: "Your summary is ready to share.",
    rename: "Rename", duplicate: "Duplicate", archive: "Archive",
    placeholder: "Ask Butler anything", more: "More", send: "Send",
    period: "Period", day: "Day", week: "Week", month: "Month",
    cards: [["Weekly report", "Your summary is ready to share."], ["Design review", "Notes from Tuesday."], ["Release notes", "A draft for 2.4."]],
    shareTitle: "Share report", shareBody: "Anyone with the link can view it.", cancel: "Cancel", share: "Share",
    press: "A control you press", drag: "A card you drag", over: "A window over content",
  },
  ko: {
    title: "Radius",
    lead: [
      ["모서리", "표면이 클수록 모서리가 커집니다. 컨트롤 8, 패널 10, 팝오버 12, 컴포저는 더 둥글게."],
      ["중첩", "안쪽 모서리는 바깥 모서리보다 둥글지 않습니다."],
      ["높이", "부드러운 그림자 세 단계: 누른 컨트롤, 끌어 옮기는 카드, 콘텐츠 위의 창."],
    ] as IntroLead,
    loupe: "×16",
    button: "저장", tag: "초안",
    panelTitle: "주간 리포트", panelBody: "요약을 공유할 준비가 됐어요.",
    rename: "이름 바꾸기", duplicate: "복제", archive: "보관",
    placeholder: "Butler에게 무엇이든 물어보세요", more: "더 보기", send: "보내기",
    period: "기간", day: "일", week: "주", month: "월",
    cards: [["주간 리포트", "요약을 공유할 준비가 됐어요."], ["디자인 리뷰", "화요일 회의 메모."], ["릴리스 노트", "2.4 초안."]],
    shareTitle: "리포트 공유", shareBody: "링크가 있으면 누구나 볼 수 있어요.", cancel: "취소", share: "공유",
    press: "누르는 컨트롤", drag: "끌어 옮기는 카드", over: "콘텐츠 위에 뜨는 창",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type RadiusCopy = (typeof RADIUS_COPY)["en"];

/** The radius ladder the corner morphs through (px as in tokens.css), and who wears each. */
export const RADII = [
  { token: "--radius-control", px: 8, who: "control" }, { token: "--radius-panel", px: 10, who: "panel" },
  { token: "--radius-popover", px: 12, who: "popover" }, { token: "--radius-composer", px: 22, who: "glass" },
  { token: "--radius-pill", px: 999, who: "pill" },
] as const;

/** The three shadows in use, lowest first: the moment each is cast (a scene each) and its token. */
export const LEVELS = [
  { when: "press", token: "--shadow-control" }, { when: "drag", token: "--shadow-drag-lift" }, { when: "over", token: "--shadow-window" },
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
  tall: { stage: { w: 380, h: 640 }, corner: { x: 20, y: 240 }, surface: { w: 720, h: 1000 } },
};

/** A radius on the specimen (the pill is half the surface's shorter side). */
export const specimenRadius = (px: number, layout: HeroLayout) => Math.min(px * LOUPE, Math.min(SPECIMEN[layout].surface.w, SPECIMEN[layout].surface.h) / 2);
