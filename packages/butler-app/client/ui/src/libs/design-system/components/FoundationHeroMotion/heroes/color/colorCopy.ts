import type { FoundationHeroLang } from "../../FoundationHeroMotion";

/** Sample copy of the Color hero. Token names never translate; the explanations on the badges do. */
export const COLOR_COPY = {
  en: {
    title: "Color",
    lead: [
      ["Strategy", "Neutral surfaces carry the interface; one blue marks the action that matters."],
      ["Tone and manner", "Calm greys, soft contrast steps, color only where it means something."],
      ["Intent", "Green, amber and red speak for status alone, graded for contrast in both themes."],
    ] as Array<[string, string]>,
    topics: { contrast: "Contrast", action: "Action", status: "Status", states: "States" },
    cardTitle: "Release notes", cardBody: "Three changes landed this week.", cardMeta: "Updated 2 min ago",
    publish: "Publish", later: "Later", autoSave: "Auto-save",
    done: "Synced", attention: "Low disk", failed: "Failed", info: "Butler checks for updates daily.",
    readOnly: "Read only", focused: "you@example.com",
    why: {
      surface: "raised surface", heading: "headings", body: "supporting text", caption: "captions",
      primary: "the one action", line: "secondary action", accent: "on, selected",
      success: "done, healthy", warning: "needs attention", danger: "failed", info: "guidance",
      disabled: "unavailable", focus: "keyboard focus",
    },
  },
  ko: {
    title: "Color",
    lead: [
      ["전략", "중립 표면이 화면을 이끌고, 파란색 하나가 중요한 동작을 표시합니다."],
      ["톤앤매너", "차분한 회색과 부드러운 대비 단계. 의미가 있을 때만 색을 씁니다."],
      ["의도", "초록·주황·빨강은 상태만 말하며, 두 테마 모두에서 대비를 맞춥니다."],
    ] as Array<[string, string]>,
    topics: { contrast: "대비", action: "동작", status: "상태", states: "비활성·포커스" },
    cardTitle: "릴리스 노트", cardBody: "이번 주 세 가지가 바뀌었어요.", cardMeta: "2분 전 업데이트",
    publish: "게시", later: "나중에", autoSave: "자동 저장",
    done: "동기화됨", attention: "디스크 부족", failed: "실패", info: "Butler가 매일 업데이트를 확인합니다.",
    readOnly: "읽기 전용", focused: "you@example.com",
    why: {
      surface: "올린 표면", heading: "제목", body: "보조 텍스트", caption: "캡션",
      primary: "핵심 동작", line: "보조 동작", accent: "켜짐·선택",
      success: "완료·정상", warning: "주의 필요", danger: "실패", info: "안내",
      disabled: "사용할 수 없음", focus: "키보드 포커스",
    },
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type ColorCopy = (typeof COLOR_COPY)["en"];

/**
 * The swatch field, four to a row: surfaces, lines and the action colors, text,
 * status (each above its tint, the blue text above the info tint).
 */
export const SWATCHES = [
  "--color-surface-base", "--surface-raised", "--popover", "--color-disabled-bg",
  "--line", "--line-strong", "--primary", "--accent",
  "--text-primary", "--text-secondary", "--text-tertiary", "--color-text-disabled",
  "--color-success", "--color-warning", "--color-danger", "--color-accent-text",
  "--color-success-bg", "--color-warning-bg", "--color-danger-bg", "--color-info-bg",
] as const;

/** Columns of the swatch field (wide; the portrait field sets two). */
export const SWATCH_COLUMNS = 4;
