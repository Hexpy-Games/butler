import type { ShowcaseRenderContext } from "../../showcase";
import type { StackDeckLabels } from "../StackDeck";
import type { StepSortableLabels } from "./stepSortableLabels";
import type { StepSortableChain, StepSortableItem } from "./stepSortableModel";

export type DemoStatus = "running" | "review" | "pending" | "held" | "done" | "failed";

export interface DemoTask extends StepSortableItem {
  status: DemoStatus;
  /** The one-line progress of a running task. */
  progress?: string;
  time?: string;
}

/** Story copy (the work-tab mockup's tasks). */
export const STEP_DEMO_COPY = {
  "en-US": {
    chains: ["Report", "Research"], more: (count: number) => `+${count} more`, menuLabel: (title: string) => `${title} menu`,
    menu: ["Start now", "Unstack", "Delete"], after: (title: string) => `After ${title}`, join: "Run together", newStep: "New step",
    status: { running: "Running", review: "In review", pending: "Waiting", held: "Paused", done: "Done", failed: "Failed" },
    titles: ["Write the report", "Turn it into slides", "Make a summary", "Write the talk script", "Research competitors", "Send the summary email"],
    progress: ["Drafting chapter 3", "Reading 7 sources"], time: ["12 min", "4 min"],
  },
  "ko-KR": {
    chains: ["보고서", "조사"], more: (count: number) => `외 ${count}건`, menuLabel: (title: string) => `‘${title}’ 메뉴`,
    menu: ["지금 시작", "묶음 풀기", "삭제"], after: (title: string) => `${title} 끝나면`, join: "함께 진행", newStep: "새 단계로",
    status: { running: "진행 중", review: "검토 중", pending: "대기", held: "멈춤", done: "완료", failed: "실패" },
    titles: ["보고서 작성", "PPT로 정리", "요약본 만들기", "발표 대본 쓰기", "경쟁사 자료 조사", "요약 메일 보내기"],
    progress: ["3장 초안 쓰는 중", "자료 7건 읽는 중"], time: ["12분", "4분"],
  },
} as const;

/** Korean announcements and deck names, as a product container passes them. */
export const KO_STEP_LABELS: Partial<StepSortableLabels> = {
  instructions: "스페이스나 엔터로 들고, 위아래 화살표로 단계 사이나 단계 위로 옮긴 뒤 다시 스페이스나 엔터로 놓습니다. 취소하려면 Esc를 누릅니다.",
  roleDescription: "옮길 수 있는 작업",
  grip: (item) => `‘${item}’ 옮기기`,
  stack: (front, count) => `${front} 외 ${count - 1}건`,
  lifted: (item, chain, step) => `‘${item}’ 옮기는 중입니다. ${chain}, ${step}단계.`,
  newStep: (item, chain, step) => `‘${item}’: ${chain}의 새 ${step}단계.`,
  join: (item, chain, step) => `‘${item}’: ${chain} ${step}단계와 함께 진행.`,
  dropped: (item, chain, step) => `‘${item}’을(를) ${chain} ${step}단계로 옮겼습니다.`,
  cancelled: (item) => `‘${item}’ 옮기기를 취소했습니다.`,
  unchanged: (item) => `‘${item}’은(는) 그대로입니다.`,
};
export const KO_DECK_LABELS: Partial<StackDeckLabels> = {
  expand: (count, front) => `${front} 외 ${count - 1}건, 펼치기`,
  fold: (item) => `${item}, 접기`,
};

/** Chains as codes: "a" one task, "b+c" a 묶음; `!` running, `~` in review, `?` held, `.` done, `x` failed. */
export type DemoShape = string[][];

const STATUS_CODES: Array<[string, DemoStatus]> = [["!", "running"], ["~", "review"], ["?", "held"], [".", "done"], ["x", "failed"]];

export function demoChains(locale: ShowcaseRenderContext["locale"], shape: DemoShape): StepSortableChain<DemoTask>[] {
  const copy = STEP_DEMO_COPY[locale];
  let live = 0;
  const task = (code: string): DemoTask => {
    const status = STATUS_CODES.find(([mark]) => code.slice(1).includes(mark))?.[1] ?? "pending";
    const running = status === "running" || status === "review";
    const extra = running ? { progress: copy.progress[live % 2], time: copy.time[live++ % 2] } : {};
    return { id: code[0]!, label: copy.titles[code.charCodeAt(0) - 97]!, status, running, done: status === "done", ...extra };
  };
  return shape.map((steps, index) => ({
    id: `chain-${index}`, label: copy.chains[index]!, title: shape.length > 1 ? copy.chains[index] : undefined,
    steps: steps.map((step) => step.split("+").map(task)),
  }));
}
