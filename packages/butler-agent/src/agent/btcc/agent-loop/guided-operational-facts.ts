import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import type {
  DurableWorkContext,
  DurableWorkView,
} from "../work/index.ts";
import type { GuidedEffectJournalRecord } from "../effects/index.ts";
import {
  isDurableWorkCompletionValidationCurrent,
  isDurableWorkResultReviewCurrent,
} from "./durable-work-context.ts";
const FACT_VALUE_LIMIT = 480;

export type OperationalFacts = {
  originalRequest: string;
  responseLanguage?: string;
  work: DurableWorkContext | DurableWorkView | null;
  toolCalls: GuidedToolJournalRecord[];
  effects: GuidedEffectJournalRecord[];
};

export function guidedOperationalReportPrompt(input: OperationalFacts): string {
  return [
    "The main execution did not produce a final answer.",
    "Give the user one concise, natural, truthful answer using only the user-safe facts below.",
    "Clearly separate what completed, what remains, and any limitation.",
    "Do not mention Work records, internal stages, tools, journals, effects, ids, counts, schemas, or raw errors.",
    "Do not claim that an unlisted action happened. Do not call tools.",
    "",
    `Original request: ${input.originalRequest}`,
    ...operationalReportFactLines(input),
  ].join("\n");
}

export function guidedOperationalFallback(input: OperationalFacts): string {
  const korean = prefersKorean(input.responseLanguage) ?? /[가-힣]/.test(input.originalRequest);
  const work = workView(input.work);
  const summary = latestUserSafeSummary(work);
  const nextStep = work?.latestCheckpoint?.nextStep?.trim();
  if (korean) {
    return [
      work?.status === "completed"
        ? "요청한 작업은 완료됐습니다. 다만 결과 설명 작성을 마치지 못했습니다."
        : "작업을 진행했지만 답변 생성을 마치지 못했습니다.",
      ...(summary ? [`현재까지 확인된 내용: ${compact(summary)}`] : []),
      ...(nextStep ? [`다음 작업: ${compact(nextStep)}`] : []),
      work
        ? "진행 내용은 저장되어 있어 모델 연결이 복구되면 이어갈 수 있습니다."
        : "완료되지 않은 작업을 완료로 처리하지 않았습니다.",
    ].join("\n");
  }
  return [
    work?.status === "completed"
      ? "The requested work is complete, but I could not finish writing the result explanation."
      : "I made progress on the request but could not finish generating the answer.",
    ...(summary ? [`Confirmed so far: ${compact(summary)}`] : []),
    ...(nextStep ? [`Next step: ${compact(nextStep)}`] : []),
    work
      ? "The progress is saved and can continue after the model connection recovers."
      : "I did not mark unfinished work as complete.",
  ].join("\n");
}

function prefersKorean(value: string | undefined): boolean | null {
  const language = value?.trim().toLocaleLowerCase("en-US");
  if (!language) return null;
  if (/^(ko|kor|korean)$|한국|한국어/u.test(language)) return true;
  if (/^(en|eng|english)$/u.test(language)) return false;
  return null;
}

function operationalReportFactLines(input: OperationalFacts): string[] {
  const work = workView(input.work);
  const facts: string[] = [];
  if (work) {
    facts.push(
      work.status === "completed"
        ? "- The requested work is recorded as complete."
        : "- The requested work is not recorded as complete.",
    );
    facts.push(`- User-visible objective: ${compact(work.objective)}`);
    if (work.latestCheckpoint?.publicSummary) {
      facts.push(`- Latest user-safe progress: ${compact(work.latestCheckpoint.publicSummary)}`);
    }
    if (work.latestCheckpoint?.nextStep) {
      facts.push(`- Next useful step: ${compact(work.latestCheckpoint.nextStep)}`);
    }
    appendReviewSummary(facts, work);
  }
  return [
    "Known user-safe facts:",
    ...(facts.length > 0
      ? facts
      : ["- No user-safe completion summary was recorded."]),
  ];
}

function appendReviewSummary(
  lines: string[],
  work: DurableWorkContext["work"] | DurableWorkView,
): void {
  if (work?.latestResultReview) {
    const current = isDurableWorkResultReviewCurrent(work);
    lines.push(
      `- ${current ? "Current" : "Outdated"} result summary: ` +
        compact(work.latestResultReview.summary),
    );
  }
  if (work?.latestCompletionValidation) {
    const current = isDurableWorkCompletionValidationCurrent(work);
    lines.push(
      `- ${current ? "Current" : "Outdated"} completion summary: ` +
        compact(work.latestCompletionValidation.summary),
    );
  }
}

function latestUserSafeSummary(
  work: DurableWorkContext["work"] | DurableWorkView | null,
): string | null {
  if (!work) return null;
  return work.latestCheckpoint?.publicSummary?.trim() ||
    (work.latestCompletionValidation && isDurableWorkCompletionValidationCurrent(work)
      ? work.latestCompletionValidation.summary.trim()
      : "") ||
    (work.latestResultReview && isDurableWorkResultReviewCurrent(work)
      ? work.latestResultReview.summary.trim()
      : "") ||
    null;
}

function workView(input: OperationalFacts["work"]): DurableWorkView | null {
  return input && "work" in input ? input.work : input;
}

function compact(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length <= FACT_VALUE_LIMIT
    ? oneLine
    : `${oneLine.slice(0, FACT_VALUE_LIMIT - 1)}…`;
}
