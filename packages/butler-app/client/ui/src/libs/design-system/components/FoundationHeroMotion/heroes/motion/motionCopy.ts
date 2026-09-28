import type { MotionDurationName, MotionEasingName } from "../../../../lib/motion";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Motion hero. Token names and numbers never translate. */
export const MOTION_COPY = {
  en: {
    title: "Motion",
    lead: [
      ["Entrances", "Short and decelerating: things arrive fast and settle."],
      ["Exits", "Faster than they came, on the accelerating curve."],
      ["Restraint", "Reduced motion keeps the fades and drops the travel."],
    ] as IntroLead,
    full: "full motion", reduced: "reduced motion", saved: "Settings saved",
    topics: { menu: "Menu", dialog: "Dialog", toast: "Toast", press: "Press" },
    rename: "Rename", duplicate: "Duplicate", archive: "Archive",
    dialogTitle: "Archive this chat?", dialogBody: "You can restore it from the archive.", cancel: "Cancel", confirm: "Archive",
    toastTitle: "Conversation archived", send: "Send",
  },
  ko: {
    title: "Motion",
    lead: [
      ["등장", "짧고 감속하며: 빠르게 도착해 자리를 잡습니다."],
      ["퇴장", "들어올 때보다 빠르게, 가속 곡선으로 떠납니다."],
      ["절제", "동작 줄이기에서는 페이드만 남기고 이동은 뺍니다."],
    ] as IntroLead,
    full: "모든 동작", reduced: "동작 줄이기", saved: "설정을 저장했습니다",
    topics: { menu: "메뉴", dialog: "대화상자", toast: "토스트", press: "누르기" },
    rename: "이름 바꾸기", duplicate: "복제", archive: "보관",
    dialogTitle: "이 대화를 보관할까요?", dialogBody: "보관함에서 다시 꺼낼 수 있어요.", cancel: "취소", confirm: "보관",
    toastTitle: "대화를 보관했습니다", send: "보내기",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type MotionCopy = (typeof MOTION_COPY)["en"];

export const EASES: MotionEasingName[] = ["standard", "decelerate", "accelerate", "emphasized", "spring"];

/** Entrance and exit pairs of the duration scale. */
export const DURATIONS: Array<[enter: MotionDurationName, exit: MotionDurationName | null]> = [
  ["fast", "exit-fast"], ["base", "exit-base"], ["slow", "exit-slow"], ["menu", "exit-menu"], ["deliberate", null],
];

/** The field's plots and their size (poster px): a dot runs each curve across it. */
export const PLOT = 64;

/** Each build replays its component's motion three times slower than real time, so the eye can follow it. */
export const SLOW = 3;
