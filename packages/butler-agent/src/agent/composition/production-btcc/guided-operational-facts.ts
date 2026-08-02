import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import type {
  DurableWorkContext,
  DurableWorkView,
} from "../../btcc/durable-work/index.ts";
import type { GuidedEffectJournalRecord } from "../../btcc/effects/index.ts";
import {
  isDurableWorkCompletionValidationCurrent,
  isDurableWorkResultReviewCurrent,
} from "./durable-work-context.ts";
import { projectGuidedToolContext } from "./guided-tool-context-projection.ts";

const FACT_LIMIT = 12;
const FACT_VALUE_LIMIT = 480;

export type OperationalFacts = {
  originalRequest: string;
  work: DurableWorkContext | DurableWorkView | null;
  toolCalls: GuidedToolJournalRecord[];
  effects: GuidedEffectJournalRecord[];
};

export function guidedOperationalReportPrompt(input: OperationalFacts): string {
  return [
    "The normal execution window ended before a final answer was available.",
    "Give the user one concise, truthful answer using only the facts below.",
    "Clearly separate what completed, what remains, and any limitation.",
    "Do not claim that an unlisted action or effect happened. Do not call tools.",
    "",
    `Original request: ${input.originalRequest}`,
    ...factLines(input),
  ].join("\n");
}

export function guidedOperationalFallback(input: OperationalFacts): string {
  const korean = /[가-힣]/.test(input.originalRequest);
  const facts = fallbackFactLines(input);
  const work = workView(input.work);
  if (korean) {
    return [
      "요청을 끝까지 정리하는 과정에서 모델 연결 또는 실행 시간이 종료되었습니다.",
      facts.length > 0
        ? "현재까지 확인된 영속 기록:"
        : "실행 완료를 뒷받침하는 영속 기록은 없습니다.",
      ...facts,
      work?.status === "completed"
        ? "저장된 Work는 완료 상태이지만, 사용자용 최종 설명 생성이 중단되어 확인된 영속 기록만 전달합니다."
        : work
        ? "완료되지 않은 부분은 완료로 처리하지 않았으며, 저장된 Work에서 이어갈 수 있습니다."
        : "완료되지 않은 부분은 완료로 처리하지 않았습니다.",
    ].join("\n");
  }
  return [
    "The model connection or execution window ended before I could finish the answer.",
    facts.length > 0
      ? "Confirmed durable records:"
      : "No durable record confirms completed execution.",
    ...facts,
    work?.status === "completed"
      ? "The saved Work is complete, but generation of the user-facing final explanation stopped, so I am reporting only confirmed durable records."
      : work
      ? "I did not mark the unfinished part complete; the saved Work can be continued."
      : "I did not mark the unfinished part complete.",
  ].join("\n");
}

function factLines(input: OperationalFacts): string[] {
  const facts = reportFactLines(input);
  return [
    "Known durable facts:",
    ...(facts.length > 0
      ? facts
      : ["- No tool status, Work checkpoint, or persistent effect was confirmed."]),
  ];
}

function reportFactLines(input: OperationalFacts): string[] {
  const lines = fallbackFactLines(input);
  const toolDetails = projectGuidedToolContext(input.toolCalls, {
    maxRecords: FACT_LIMIT,
    maxRecordBytes: 1_600,
    maxTotalBytes: 9_000,
  });
  if (toolDetails.length > 0) {
    lines.push(
      "- Recent durable tool details (newest first): " + safeJson(toolDetails),
    );
  }
  return lines;
}

function fallbackFactLines(input: OperationalFacts): string[] {
  const lines = durableFactLines(input);
  const work = workView(input.work);
  if (work?.latestResultReview) {
    const current = isDurableWorkResultReviewCurrent(work);
    lines.push(
      `- Saved model result review${current ? "" : " (outdated)"}: ` +
        `${work.latestResultReview.verdict} — ` +
        compact(work.latestResultReview.summary),
    );
    for (const correction of work.latestResultReview.corrections.slice(0, 6)) {
      lines.push(`- Saved result correction: ${compact(correction)}`);
    }
  }
  if (work?.latestCompletionValidation) {
    const current = isDurableWorkCompletionValidationCurrent(work);
    lines.push(
      `- Saved completion validation${current ? "" : " (outdated)"}: ` +
        `${work.latestCompletionValidation.verdict} — ` +
        compact(work.latestCompletionValidation.summary),
    );
    for (const correction of work.latestCompletionValidation.corrections.slice(0, 6)) {
      lines.push(`- Saved completion correction: ${compact(correction)}`);
    }
  }
  return lines;
}

function durableFactLines(input: OperationalFacts): string[] {
  const lines: string[] = [];
  const work = workView(input.work);
  if (work) {
    lines.push(`- Work status: ${work.status}`);
    if (work.latestCheckpoint) {
      lines.push(
        `- Latest progress (${work.latestCheckpoint.stage}): ${compact(work.latestCheckpoint.publicSummary)}`,
      );
      lines.push(`- Next recorded step: ${compact(work.latestCheckpoint.nextStep)}`);
    }
  }
  if (input.toolCalls.length > 0) {
    const counts = new Map<GuidedToolJournalRecord["status"], number>();
    for (const call of input.toolCalls) {
      counts.set(call.status, (counts.get(call.status) ?? 0) + 1);
    }
    const breakdown = [...counts.entries()]
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    lines.push(`- Tool calls recorded: ${input.toolCalls.length} total (${breakdown})`);
  }
  for (const call of input.toolCalls.slice(-FACT_LIMIT)) {
    lines.push(`- Tool ${call.toolName}: ${call.status}`);
  }
  for (const effect of input.effects.slice(0, FACT_LIMIT)) {
    lines.push(
      `- Effect ${effect.capability} on ${compact(effect.sanitizedTarget)}: ${effect.status}`,
    );
  }
  return lines;
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}
