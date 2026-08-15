import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import type {
  DurableWorkContext,
  DurableWorkView,
} from "../work/index.ts";
import type { GuidedEffectJournalRecord } from "../effects/index.ts";
import {
  hasSafeAppliedEffect,
  safeProgressFacts,
  safeToolFacts,
  safeWorkFact,
} from "./guided-operational-fact-safety.ts";

export type OperationalFacts = {
  originalRequest: string;
  responseLanguage?: string;
  work: DurableWorkContext | DurableWorkView | null;
  /** Each Work fact carries its own current-Turn provenance. */
  workFacts?: OperationalWorkFacts;
  toolCalls: GuidedToolJournalRecord[];
  effects: GuidedEffectJournalRecord[];
  /** Presentation-only summaries captured from this Turn's progress observer. */
  currentTurnProgress?: readonly string[];
};

export type OperationalWorkFacts = {
  status?: DurableWorkView["status"];
  objective?: string;
  checkpointSummary?: string;
  checkpointNextStep?: string;
  resultSummary?: string;
  completionSummary?: string;
  dispositionSummary?: string;
  blockers?: readonly string[];
};

export type GuidedOperationalFactsSources = {
  turnId: string;
  readBoundWork: () => Promise<DurableWorkView | null>;
  listToolCalls: () => GuidedToolJournalRecord[];
  listEffectsForWork: (workId: string) => GuidedEffectJournalRecord[];
  readProgress: () => readonly string[];
  responseLanguage?: string;
};

export function operationalWorkFacts(
  work: DurableWorkView | null | undefined,
  turnId: string,
): OperationalWorkFacts | undefined {
  if (!work) return undefined;
  const facts: OperationalWorkFacts = {};
  if (work.origin.turnId === turnId) {
    const objective = safeWorkFact(work.objective);
    if (objective) facts.objective = objective;
  }
  if (work.latestCheckpoint?.originTurnId === turnId) {
    const summary = safeWorkFact(work.latestCheckpoint.publicSummary);
    if (summary) facts.checkpointSummary = summary;
    const nextStep = safeWorkFact(work.latestCheckpoint.nextStep);
    if (nextStep) facts.checkpointNextStep = nextStep;
  }
  if (work.latestResultReview?.originTurnId === turnId) {
    const summary = safeWorkFact(work.latestResultReview.summary);
    if (summary) facts.resultSummary = summary;
  }
  if (work.latestCompletionValidation?.originTurnId === turnId) {
    const summary = safeWorkFact(work.latestCompletionValidation.summary);
    if (summary) facts.completionSummary = summary;
  }
  if (work.latestDisposition?.originTurnId === turnId) {
    const summary = safeWorkFact(work.latestDisposition.summary);
    if (summary) facts.dispositionSummary = summary;
    facts.status = work.status;
  }
  const blockers = (work.effectBlockers ?? [])
    .filter((blocker) => blocker.sourceTurnId === turnId)
    .map((blocker) => safeWorkFact(blocker.detail))
    .filter((detail): detail is string => Boolean(detail));
  if (blockers.length > 0) facts.blockers = [...new Set(blockers)];
  return Object.values(facts).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  )
    ? facts
    : undefined;
}

/**
 * Loads the durable and Turn-local sources used by operational fallback.
 *
 * The join is deliberately kept here rather than in the Turn orchestrator so
 * that every fallback path applies the same field-level provenance and effect
 * receipt eligibility rules.
 */
export async function loadGuidedOperationalFacts(
  input: GuidedOperationalFactsSources,
): Promise<Omit<OperationalFacts, "originalRequest">> {
  const work = await input.readBoundWork();
  const toolCalls = input.listToolCalls();
  const workFacts = operationalWorkFacts(work, input.turnId);
  return {
    work,
    ...(workFacts ? { workFacts } : {}),
    toolCalls,
    effects: work
      ? currentTurnEffectRecords(toolCalls, input.listEffectsForWork(work.workId))
      : [],
    currentTurnProgress: input.readProgress(),
    responseLanguage: input.responseLanguage,
  };
}

export function currentTurnEffectRecords(
  toolCalls: readonly GuidedToolJournalRecord[],
  effects: readonly GuidedEffectJournalRecord[],
): GuidedEffectJournalRecord[] {
  const receiptIds = new Set<string>();
  for (const call of toolCalls) {
    if (call.status !== "completed") continue;
    const output = asRecord(call.result);
    const receipt = asRecord(output?.effect_receipt);
    if (typeof receipt?.receipt_id === "string") receiptIds.add(receipt.receipt_id);
  }
  return effects.filter((effect) => receiptIds.has(effect.receiptId));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function guidedOperationalFallback(input: OperationalFacts): string {
  const korean = prefersKorean(input.responseLanguage) ?? /[가-힣]/.test(input.originalRequest);
  const workFacts = resolveOperationalWorkFacts(input);
  const toolFacts = safeToolFacts(input.toolCalls, korean);
  const hasAppliedEffect = hasSafeAppliedEffect(input.effects);
  const progressFacts = safeProgressFacts(input.currentTurnProgress);
  const hasFacts = Boolean(
    workFacts || toolFacts.length > 0 || hasAppliedEffect || progressFacts.length > 0,
  );
  if (korean) {
    return [
      workFacts?.status === "completed"
        ? "요청한 작업은 완료됐습니다. 다만 결과 설명 작성을 마치지 못했습니다."
        : hasFacts
          ? "현재 요청을 처리했지만 답변 생성을 마치지 못했습니다."
          : "현재 요청을 완료하지 못했고 답변 생성을 마치지 못했습니다.",
      ...toolFacts.map((fact) => `현재 Turn에서 확인된 내용: ${fact}`),
      ...(hasAppliedEffect ? ["현재 Turn의 변경 결과를 확인했습니다."] : []),
      ...progressFacts.map((fact) => `현재 진행 내용: ${fact}`),
      ...(workFacts?.checkpointSummary
        ? [`현재까지 확인된 내용: ${workFacts.checkpointSummary}`]
        : []),
      ...(workFacts?.resultSummary
        ? [`현재 결과 검토: ${workFacts.resultSummary}`]
        : []),
      ...(workFacts?.completionSummary
        ? [`현재 완료 검증: ${workFacts.completionSummary}`]
        : []),
      ...(workFacts?.dispositionSummary
        ? [`현재 처리 결과: ${workFacts.dispositionSummary}`]
        : []),
      ...(workFacts?.checkpointNextStep
        ? [`다음 작업: ${workFacts.checkpointNextStep}`]
        : []),
      ...(workFacts?.blockers?.map((blocker) => `현재 제한: ${blocker}`) ?? []),
      workFacts
        ? "진행 내용은 저장되어 있어 모델 연결이 복구되면 이어갈 수 있습니다."
        : "완료되지 않은 작업을 완료로 처리하지 않았습니다.",
    ].join("\n");
  }
  return [
    workFacts?.status === "completed"
        ? "The requested work is complete, but I could not finish writing the result explanation."
      : hasFacts
        ? "I processed the request but could not finish generating the answer."
        : "I could not finish generating the answer because the request was not completed.",
    ...toolFacts.map((fact) => `Confirmed in this Turn: ${fact}`),
    ...(hasAppliedEffect ? ["A change from this Turn was confirmed."] : []),
    ...progressFacts.map((fact) => `Current progress: ${fact}`),
    ...(workFacts?.checkpointSummary
      ? [`Confirmed so far: ${workFacts.checkpointSummary}`]
      : []),
    ...(workFacts?.resultSummary
      ? [`Current result review: ${workFacts.resultSummary}`]
      : []),
    ...(workFacts?.completionSummary
      ? [`Current completion check: ${workFacts.completionSummary}`]
      : []),
    ...(workFacts?.dispositionSummary
      ? [`Current disposition: ${workFacts.dispositionSummary}`]
      : []),
    ...(workFacts?.checkpointNextStep
      ? [`Next step: ${workFacts.checkpointNextStep}`]
      : []),
    ...(workFacts?.blockers?.map((blocker) => `Current limitation: ${blocker}`) ?? []),
    workFacts
      ? "The progress is saved and can continue after the model connection recovers."
      : "I did not mark unfinished work as complete.",
  ].join("\n");
}

/**
 * Last-resort delivery after an internal Work identifier was found in a
 * candidate or fallback. It intentionally carries no request echo or source
 * facts so the identifier cannot be reintroduced through a second path.
 */
export function guidedOperationalRequestOnlyFallback(
  responseLanguage?: string,
  originalRequest?: string,
): string {
  const korean = prefersKorean(responseLanguage) ??
    (originalRequest ? /[가-힣]/u.test(originalRequest) : true);
  return korean
    ? "현재 요청을 완료하지 못했고 답변 생성을 마치지 못했습니다."
    : "I could not finish generating the answer because the request was not completed.";
}

export async function guidedOperationalFallbackAfterInternalId(input: {
  originalRequest: string;
  responseLanguage?: string;
  turnId: string;
  finalWork: DurableWorkView | null;
  internalWorkIds: readonly string[];
  listToolCalls: () => GuidedToolJournalRecord[];
  listEffectsForWork: (workId: string) => GuidedEffectJournalRecord[];
  readProgress: () => readonly string[];
}): Promise<string> {
  const facts = await loadGuidedOperationalFacts({
    turnId: input.turnId,
    readBoundWork: async () => input.finalWork,
    listToolCalls: input.listToolCalls,
    listEffectsForWork: input.listEffectsForWork,
    readProgress: input.readProgress,
    responseLanguage: input.responseLanguage,
  });
  const fallback = guidedOperationalFallback({
    originalRequest: input.originalRequest,
    ...facts,
  });
  return input.internalWorkIds.some((workId) => fallback.includes(workId))
    ? guidedOperationalRequestOnlyFallback(
        input.responseLanguage,
        input.originalRequest,
      )
    : fallback;
}

function prefersKorean(value: string | undefined): boolean | null {
  const language = value?.trim().toLocaleLowerCase("en-US");
  if (!language) return null;
  if (/^(ko|kor|korean)$|한국|한국어/u.test(language)) return true;
  if (/^(en|eng|english)$/u.test(language)) return false;
  return null;
}

function resolveOperationalWorkFacts(
  input: OperationalFacts,
): OperationalWorkFacts | undefined {
  if (input.workFacts) return input.workFacts;
  const context = input.work;
  if (!isDurableWorkContext(context)) return undefined;
  return operationalWorkFacts(context.work, context.originalRequest.turnId);
}

function isDurableWorkContext(
  work: OperationalFacts["work"],
): work is DurableWorkContext {
  if (!work) return false;
  return "work" in work && "originalRequest" in work;
}
