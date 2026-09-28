import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Spacing hero. Token names and numbers never translate. */
export const SPACING_COPY = {
  en: {
    title: "Spacing",
    lead: [
      ["Base", "Every space is a multiple of 4px on one baseline grid."],
      ["Scale", "Named steps xs to 4xl; components take the names, never raw pixels."],
      ["Rhythm", "Tight inside a group, wider between groups, widest between sections."],
    ] as IntroLead,
    comfortable: "comfortable", compact: "compact",
    topics: { inset: "Inset", stack: "Stack", inline: "Inline", section: "Section rhythm" },
    name: "Name", nameValue: "Butler", workspace: "Workspace", workspaceValue: "Studio",
    cardTitle: "Release notes", cardBody: "Three changes landed this week.",
    cancel: "Cancel", save: "Save",
    sync: "Sync on launch", syncHint: "Fetch changes when Butler opens.", sounds: "Play sounds", soundsHint: "A soft chime when a task ends.",
  },
  ko: {
    title: "Spacing",
    lead: [
      ["기준", "모든 간격은 하나의 기준 격자 위에서 4px의 배수입니다."],
      ["스케일", "xs부터 4xl까지 이름 붙은 단계. 컴포넌트는 픽셀 대신 이름을 씁니다."],
      ["리듬", "묶음 안은 촘촘하게, 묶음 사이는 넓게, 섹션 사이는 가장 넓게."],
    ] as IntroLead,
    comfortable: "여유", compact: "촘촘",
    topics: { inset: "안쪽 여백", stack: "세로 쌓기", inline: "가로 배치", section: "섹션 리듬" },
    name: "이름", nameValue: "Butler", workspace: "워크스페이스", workspaceValue: "스튜디오",
    cardTitle: "릴리스 노트", cardBody: "이번 주 세 가지가 바뀌었어요.",
    cancel: "취소", save: "저장",
    sync: "시작할 때 동기화", syncHint: "Butler를 열 때 변경 사항을 가져옵니다.", sounds: "소리 재생", soundsHint: "작업이 끝나면 부드러운 알림음을 냅니다.",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type SpacingCopy = (typeof SPACING_COPY)["en"];

/** The named scale (px as in tokens.css; the steps are drawn with the live tokens). */
export const STEPS: Array<[name: string, px: number]> = [["xs", 4], ["sm", 8], ["md", 12], ["lg", 16], ["xl", 20], ["2xl", 24], ["3xl", 32], ["4xl", 40]];
