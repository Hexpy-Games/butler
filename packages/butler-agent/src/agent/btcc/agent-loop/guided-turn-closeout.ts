import type {
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import { dispositionMaterialFingerprint } from "../work/index.ts";
import type { GuidedToolJournal } from "../ports/index.ts";
import { digest } from "../identity/index.ts";
import { GuidedWorkCloseoutError } from "./guided-work-closeout-error.ts";
import { isDurableWorkTool } from "../work/index.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";

type GuidedTurnCloseoutInput = {
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  toolJournal: GuidedToolJournal;
  turnId: string;
  trackingMode: "ledger" | "local" | "none";
  responseLanguage: string;
  originalRequest: string;
};

type GuidedTurnCloseoutReview =
  | { status: "accepted"; text?: string }
  | { status: "continue"; observation: string };

type GuidedToolResultFinalizer = NonNullable<
  BtccAgentLoopInput["finalTextFromToolResult"]
>;

/** Releases a successful delegation Turn without settling its parent Work. */
export function createGuidedDelegationTurnRelease(input: {
  reconcileAfterLoop(text: string): Promise<string>;
  responseLanguage: string;
  originalRequest: string;
}): {
  finalTextFromToolResult(fallback?: GuidedToolResultFinalizer): GuidedToolResultFinalizer;
  reconcileAfterLoop(text: string): Promise<string>;
} {
  let released = false;
  return {
    finalTextFromToolResult: (fallback) => async (result) => {
      if (result.toolCall.name === "delegate_to_steward" && result.toolResult.ok) {
        released = true;
        return delegationReleaseCopy(input);
      }
      return await fallback?.(result) ?? null;
    },
    reconcileAfterLoop: async (text) => released
      ? text
      : input.reconcileAfterLoop(text),
  };
}

/**
 * A disposition is a closeout declaration only while it still describes the
 * current durable Work snapshot.  Result/checkpoint/review/action/effect
 * writes change the material fingerprint, so a same-Turn declaration cannot
 * silently settle a Work after later progress.
 */
export function isFreshCurrentDisposition(
  work: DurableWorkView | null,
  turnId: string,
): boolean {
  if (!work || work.status === "abandoned") return true;
  const disposition = work.latestDisposition;
  return Boolean(
    disposition &&
    disposition.originTurnId === turnId &&
    disposition.disposition === work.status &&
    disposition.materialFingerprint &&
    disposition.materialFingerprint === dispositionMaterialFingerprint(work),
  );
}

/**
 * Owns the bounded final-candidate reconciliation policy. A bound Work that
 * has no fresh disposition from this Turn gets one extra model opportunity;
 * a still-missing declaration is settled as a durable open disposition and
 * disclosed before the candidate is delivered.
 */
export function createGuidedTurnCloseout(input: GuidedTurnCloseoutInput): {
  reviewFinalCandidate(candidate: { text: string }): Promise<GuidedTurnCloseoutReview>;
  reconcileAfterLoop(text: string): Promise<string>;
} {
  return {
    async reviewFinalCandidate(candidate) {
      if (input.trackingMode === "none") {
        return { status: "accepted" as const };
      }
      const bound = await loadBoundWork(input);
      if (!bound) {
        return { status: "accepted" as const };
      }
      if (isFreshCurrentDisposition(bound, input.turnId)) {
        return bound.latestDisposition?.runtimeOwnedOpen
          ? { status: "accepted" as const, text: noticeCandidate(input, candidate.text) }
          : { status: "accepted" as const };
      }
      if (!await claimCloseoutCorrection(input, bound.workId)) {
        return {
          status: "accepted" as const,
          text: await settleOpen(input, bound, candidate.text),
        };
      }
      return {
        status: "continue" as const,
        observation: [
          "Before reporting the final answer, call record_work_disposition for the explicitly bound Work.",
          "Choose completed, open, or blocked with a concise summary and valid action/evidence details, then report.",
        ].join(" "),
      };
    },

    async reconcileAfterLoop(text) {
      if (input.trackingMode === "none") return text;
      const bound = await loadBoundWork(input);
      if (!bound) return text;
      if (isFreshCurrentDisposition(bound, input.turnId)) {
        return bound.latestDisposition?.runtimeOwnedOpen
          ? noticeCandidate(input, text)
          : text;
      }
      return settleOpen(input, bound, text);
    },
  };
}

async function claimCloseoutCorrection(
  input: GuidedTurnCloseoutInput,
  workId: string,
): Promise<boolean> {
  try {
    return await input.durableWork.claimCloseoutCorrection({
      ...input.workScope,
      workId,
    });
  } catch (error) {
    throw new GuidedWorkCloseoutError(error);
  }
}

async function loadBoundWork(
  input: GuidedTurnCloseoutInput,
): Promise<DurableWorkView | null> {
  try {
    return await input.durableWork.boundWorkForTurn(input.turnId);
  } catch (error) {
    throw new GuidedWorkCloseoutError(error);
  }
}

async function settleOpen(
  input: GuidedTurnCloseoutInput,
  bound: DurableWorkView,
  candidate: string,
): Promise<string> {
  const copy = closeoutCopy(input);
  try {
    await claimCloseoutCorrection(input, bound.workId);
    await backfillCloseoutResults(input);
    const current = await input.durableWork.boundWorkForTurn(input.turnId);
    if (!current || current.workId !== bound.workId) {
      throw new Error("Runtime-owned open Work binding changed before settlement");
    }
    const expectedMaterialFingerprint = dispositionMaterialFingerprint(current);
    const persisted = await input.durableWork.recordDisposition({
      ...input.workScope,
      mutationCallId: digest(
        `btcc-guided-work-runtime-open.v2\0${input.turnId}\0${bound.workId}\0${expectedMaterialFingerprint}`,
      ),
      workId: bound.workId,
      disposition: "open",
      summary: copy.summary,
      actionUpdates: [],
      remainingActions: [],
      nextCondition: copy.nextCondition,
      evidenceRefs: [],
      followups: [],
      expectedMaterialFingerprint,
      runtimeOwnedOpenGeneration: { version: 1 },
    });
    if (persisted.status === "completed" &&
        isFreshCurrentDisposition(persisted, input.turnId)) {
      return candidate.trim();
    }
    if (!isFreshCurrentDisposition(persisted, input.turnId) ||
        persisted.status !== "open") {
      throw new Error("Runtime-owned open disposition was not current");
    }
  } catch (error) {
    throw new GuidedWorkCloseoutError(error);
  }
  return noticeCandidate(input, candidate);
}

function noticeCandidate(input: GuidedTurnCloseoutInput, candidate: string): string {
  const notice = closeoutCopy(input).notice;
  const content = candidate.trim();
  return content.startsWith(`${notice}\n\n`)
    ? content
    : `${notice}\n\n${content}`;
}

async function backfillCloseoutResults(
  input: GuidedTurnCloseoutInput,
): Promise<void> {
  for (const record of input.toolJournal.list(input.turnId)) {
    if (record.status !== "completed" || isDurableWorkTool(record.toolName)) continue;
    await input.durableWork.attachToolResult({
      ...input.workScope,
      mutationCallId: digest(`btcc-guided-work-result-attach.v1\0${record.callId}`),
      toolCallId: record.callId,
    });
  }
}

function closeoutCopy(input: GuidedTurnCloseoutInput): {
  summary: string;
  nextCondition: string;
  notice: string;
} {
  const korean = /[가-힣]/u.test(input.responseLanguage) ||
    /(?:korean|ko(?:rea)?)/iu.test(input.responseLanguage) ||
    /[가-힣]/u.test(input.originalRequest);
  return korean
    ? {
        summary: "현재 Turn의 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
        nextCondition: "현재 결과와 완료 조건을 확인한 뒤 Work 종료 상태를 다시 기록해야 합니다.",
        notice: "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
      }
    : {
        summary: "The current Turn could not confirm completion, so the Work remains open.",
        nextCondition: "Review the current results and completion conditions, then record the Work disposition again.",
        notice: "Work completion could not be confirmed, so the Work remains open.",
      };
}

function delegationReleaseCopy(input: {
  responseLanguage: string;
  originalRequest: string;
}): string {
  const korean = /[가-힣]/u.test(input.responseLanguage) ||
    /(?:korean|ko(?:rea)?)/iu.test(input.responseLanguage) ||
    /[가-힣]/u.test(input.originalRequest);
  return korean ? "위임 작업을 시작했습니다." : "Delegated work started.";
}
