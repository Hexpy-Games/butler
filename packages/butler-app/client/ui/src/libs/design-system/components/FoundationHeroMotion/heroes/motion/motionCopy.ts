import { easeProgress, motionDuration, motionEasing, type MotionDurationName, type MotionEasingName } from "../../../../lib/motion";
import { linearStops } from "../../easingPath";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/** Sample copy of the Motion hero. Token names and numbers never translate. */
export const MOTION_COPY = {
  en: {
    title: "Motion",
    lead: [
      ["Tempo", "Motion keeps a beat: every move lands on it or between."],
      ["Shape", "The curve decides where the time goes; exits run faster than entrances."],
      ["Restraint", "Reduced motion keeps the fades and drops the travel."],
    ] as IntroLead,
    jobs: { standard: "moving on screen", decelerate: "arriving", accelerate: "leaving", emphasized: "hero entrance", spring: "Switch thumb only" } as Record<MotionEasingName, string>,
    enter: "enter", exit: "exit", real: "real speed",
    rename: "Rename", duplicate: "Duplicate", archive: "Archive",
    ask: "Summarize this week", reply: "Three changes landed since Monday.", placeholder: "Ask Butler anything", send: "Send",
    saved: "Summary saved", full: "Full", reduced: "Reduced",
    lanes: ["Send", "Bubble", "Thinking", "Reply", "Check", "Notice"],
    autoSend: "Send on Enter", card: "Launch plan",
  },
  ko: {
    title: "Motion",
    lead: [
      ["템포", "동작에는 박자가 있습니다. 모든 움직임은 박자 위나 그 사이에 놓입니다."],
      ["모양", "곡선이 시간이 어디에 쓰일지 정합니다. 퇴장은 등장보다 빠릅니다."],
      ["절제", "동작 줄이기에서는 페이드만 남기고 이동은 뺍니다."],
    ] as IntroLead,
    jobs: { standard: "화면 안에서 이동", decelerate: "도착", accelerate: "떠남", emphasized: "주인공 등장", spring: "Switch 손잡이만" } as Record<MotionEasingName, string>,
    enter: "등장", exit: "퇴장", real: "실제 속도",
    rename: "이름 바꾸기", duplicate: "복제", archive: "보관",
    ask: "이번 주 요약해 줘", reply: "월요일 이후 세 가지가 바뀌었어요.", placeholder: "Butler에게 무엇이든 물어보세요", send: "보내기",
    saved: "요약을 저장했습니다", full: "모든 동작", reduced: "동작 줄이기",
    lanes: ["보내기", "말풍선", "생각 중", "답장", "완료", "알림"],
    autoSend: "Enter로 보내기", card: "출시 계획",
  },
} satisfies Record<FoundationHeroLang, unknown>;

export type MotionCopy = (typeof MOTION_COPY)["en"];

/** The five curves, in lane order. */
export const EASES: MotionEasingName[] = ["standard", "decelerate", "accelerate", "emphasized", "spring"];

/** Ghost frames per run (every tenth of the time, both ends included). */
export const GHOSTS = 11;

/**
 * Eased progress at a time fraction, from the live --motion-ease-* token;
 * linear() curves (the spring) are read stop by stop, so the overshoot shows.
 */
export function progress(name: MotionEasingName, t: number): number {
  const value = motionEasing(name).trim();
  if (!value.startsWith("linear(")) return easeProgress(name, t);
  const stops = linearStops(value.slice(7, -1));
  if (!stops) return t;
  const next = stops.findIndex(([x]) => x >= t);
  if (next <= 0) return stops[Math.max(0, next)]![1];
  const [x0, y0] = stops[next - 1]!;
  const [x1, y1] = stops[next]!;
  return x1 === x0 ? y1 : y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
}

/** A duration token in ms, from the live tokens (a --motion-* name, or a token outside the named scale). */
export function ms(name: MotionDurationName | `--motion-${string}`, fallback = 140): number {
  if (!name.startsWith("--")) return motionDuration(name as MotionDurationName);
  const raw = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const match = /^(\d*\.?\d+)(ms|s)$/u.exec(raw);
  return match ? Number(match[1]) * (match[2] === "s" ? 1000 : 1) : fallback;
}
