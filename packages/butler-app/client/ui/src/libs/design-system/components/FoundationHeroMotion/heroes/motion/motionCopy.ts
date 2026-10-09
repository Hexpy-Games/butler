import { easeProgress, motionEasing, type MotionEasingName } from "../../../../lib/motion";
import { linearStops } from "../../easingPath";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import type { IntroLead } from "../shared/Intro";

/**
 * Copy of the Motion hero. The product strings are the app's own (butler-i18n
 * en/ko), so the turn reads exactly as in Butler. Token names never translate.
 */
export const MOTION_COPY = {
  en: {
    title: "Motion",
    lead: [
      ["Tempo", "Motion keeps a beat: every move starts on it."],
      ["Shape", "The curve decides where the time goes; exits run faster than entrances."],
      ["Restraint", "Reduced motion keeps the fades and drops the travel."],
    ] as IntroLead,
    jobs: { standard: "moving on screen", decelerate: "arriving", accelerate: "leaving", emphasized: "hero entrance", spring: "Switch thumb only" } as Record<MotionEasingName, string>,
    enter: "enter", exit: "exit", half: "½ speed", real: "real speed",
    add: "More options", attachments: "Attachments", documents: "Project documents", attach: "Attach file", attachImage: "Attach image",
    mode: "Response mode", normal: "Normal", plan: "Plan",
    ask: "Summarize this week", reply: "Three changes landed since Monday.",
    placeholder: "Ask Butler anything", send: "Send", stop: "Stop", more: "More options", askFirst: "Ask first", permission: "Permission",
    model: "GPT-5.1", effort: "medium", sent: "9:41 AM", generating: "Generating response · 0m 1s",
    worked: "Worked for 2s", done: "Response completed", copyMessage: "Copy message", copyResponse: "Copy assistant response",
    full: "Full", reduced: "Reduced", fullHow: "translate + opacity", reducedHow: "opacity only",
    lanes: ["Send", "Bubble", "Thinking", "Reply", "Done"],
    twinLanes: ["Bubble", "Reply"],
    field: "Send with Enter", fieldHint: "Shift+Enter starts a new line.",
  },
  ko: {
    title: "Motion",
    lead: [
      ["템포", "동작에는 박자가 있습니다. 모든 움직임은 박자에서 시작합니다."],
      ["모양", "곡선이 시간이 어디에 쓰일지 정합니다. 퇴장은 등장보다 빠릅니다."],
      ["절제", "동작 줄이기에서는 페이드만 남기고 이동은 뺍니다."],
    ] as IntroLead,
    jobs: { standard: "화면 안에서 이동", decelerate: "도착", accelerate: "떠남", emphasized: "주인공 등장", spring: "Switch 손잡이만" } as Record<MotionEasingName, string>,
    enter: "등장", exit: "퇴장", half: "½ 속도", real: "실제 속도",
    add: "추가 기능", attachments: "첨부", documents: "프로젝트 문서", attach: "파일 첨부", attachImage: "이미지 첨부",
    mode: "응답 방식", normal: "일반", plan: "계획",
    ask: "이번 주 요약해 줘", reply: "월요일 이후 세 가지가 바뀌었어요.",
    placeholder: "버틀러에게 무엇이든 물어보세요", send: "전송", stop: "중지", more: "추가 기능", askFirst: "먼저 확인", permission: "권한",
    model: "GPT-5.1", effort: "medium", sent: "오전 9:41", generating: "응답 생성 중 · 0분 1초",
    worked: "2초 동안 작업", done: "답변 완료", copyMessage: "메시지 복사", copyResponse: "답변 복사",
    full: "모든 동작", reduced: "동작 줄이기", fullHow: "translate + opacity", reducedHow: "opacity",
    lanes: ["전송", "말풍선", "생각 중", "답변", "완료"],
    twinLanes: ["말풍선", "답변"],
    field: "Enter로 보내기", fieldHint: "Shift+Enter는 줄을 바꿉니다.",
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
