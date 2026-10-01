import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Spacing hero. Token names and numbers never translate. */
export const SPACING_COPY = {
  en: {
    title: "Spacing",
    lead: [
      ["Base", "Every space is a count of 4px blocks."],
      ["Scale", "Named steps xs to 4xl; components take the names, never raw pixels."],
      ["Rhythm", "Tight inside a group, wider between groups, widest between sections."],
    ] as IntroLead,
    unit: "4px, the base unit",
    comfortable: "comfortable", compact: "compact",
    general: "General", notifications: "Notifications",
    sync: "Sync on launch", syncHint: "Fetch changes when Butler opens.", sounds: "Play sounds", soundsHint: "A soft chime when a task ends.",
    badge: "Show badge", badgeHint: "Count unread replies on the icon.",
    inGroup: "in a group", betweenRows: "between rows", betweenSections: "between sections",
    cardTitle: "Release notes", cardBody: "Three changes landed this week.",
    cancel: "Cancel", save: "Save",
  },
  ko: {
    title: "Spacing",
    lead: [
      ["기준", "모든 간격은 4px 블록을 센 개수입니다."],
      ["스케일", "xs부터 4xl까지 이름 붙은 단계. 컴포넌트는 픽셀 대신 이름을 씁니다."],
      ["리듬", "묶음 안은 촘촘하게, 묶음 사이는 넓게, 섹션 사이는 가장 넓게."],
    ] as IntroLead,
    unit: "4px, 기준 단위",
    comfortable: "여유", compact: "촘촘",
    general: "일반", notifications: "알림",
    sync: "시작할 때 동기화", syncHint: "Butler를 열 때 변경 사항을 가져옵니다.", sounds: "소리 재생", soundsHint: "작업이 끝나면 부드러운 알림음을 냅니다.",
    badge: "배지 표시", badgeHint: "읽지 않은 답장 수를 아이콘에 표시합니다.",
    inGroup: "묶음 안", betweenRows: "행 사이", betweenSections: "섹션 사이",
    cardTitle: "릴리스 노트", cardBody: "이번 주 세 가지가 바뀌었어요.",
    cancel: "취소", save: "저장",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type SpacingCopy = (typeof SPACING_COPY)["en"];

/** The named scale (px as in tokens.css; the steps are drawn with the live tokens). */
export const STEPS: Array<[name: string, px: number]> = [["xs", 4], ["sm", 8], ["md", 12], ["lg", 16], ["xl", 20], ["2xl", 24], ["3xl", 32], ["4xl", 40]];

/** One block: --space-xs. */
export const UNIT = 4;

/**
 * The measured spaces of a settings section (px as in tokens.css; the
 * highlights are drawn with the live tokens): the header gap, the card's
 * inset (top and bottom), the gap between fields and the gap between sections.
 */
export const GAPS = {
  hg: { token: "--settings-section-header-gap", px: 12 },
  pt: { token: "--settings-section-padding", px: 24 },
  fg: { token: "--settings-field-gap", px: 20 },
  pb: { token: "--settings-section-padding", px: 24 },
  sg: { token: "--settings-section-gap", px: 40 },
} as const;

export type GapId = keyof typeof GAPS;

/** The compact card inset (tokens.css: compact settings only tighten the section card inset). */
export const COMPACT_PAD = 16;
