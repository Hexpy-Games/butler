import type {
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import { dispositionMaterialFingerprint } from "../work/index.ts";
import { digest } from "../identity/index.ts";
import { GuidedWorkCloseoutError } from "./guided-work-closeout-error.ts";
import type { GuidedToolJournal } from "../ports/index.ts";
import {
  abandonedChildResult, blockedChildResult, childCloseoutObservation, incompleteChildResult,
} from "./child-closeout-feedback.ts";
import { guidedWorkReportDecision, isFreshCurrentDisposition, type AcceptedWorkResult } from "./guided-work-report-decision.ts";
export { isFreshCurrentDisposition } from "./guided-work-report-decision.ts";

type GuidedTurnCloseoutInput = {
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  turnId: string;
  trackingMode: "ledger" | "local" | "none";
  responseLanguage: string;
  originalRequest: string;
  requiresTerminalResult?: boolean;
  /** Reads the recorded blocked_code of a child's blocked disposition. */
  toolJournal?: Pick<GuidedToolJournal, "list">;
};

type GuidedTurnCloseoutReview =
  | { status: "accepted"; text?: string }
  | { status: "continue"; observation: string };

/** Keeps the model-authored handoff reply without settling delegated Work. */
export function createGuidedDelegationTurnRelease(input: {
  reviewFinalCandidate(candidate: { text: string }): Promise<GuidedTurnCloseoutReview>;
  reconcileAfterLoop(text: string): Promise<string>;
  turnId: string;
  toolJournal: Pick<GuidedToolJournal, "list">;
  delegationTool: "delegate_to_steward";
}): {
  reviewFinalCandidate(candidate: { text: string }): Promise<GuidedTurnCloseoutReview>;
  reconcileAfterLoop(text: string): Promise<string>;
} {
  return {
    reviewFinalCandidate: async (candidate) => hasQueuedDelegation(input)
      ? { status: "accepted" }
      : input.reviewFinalCandidate(candidate),
    reconcileAfterLoop: async (text) => hasQueuedDelegation(input)
      ? text
      : input.reconcileAfterLoop(text),
  };
}

function hasQueuedDelegation(input: {
  turnId: string;
  toolJournal: Pick<GuidedToolJournal, "list">;
  delegationTool: "delegate_to_steward";
}): boolean {
  return input.toolJournal.list(input.turnId).some((record) => {
    const result = record.result;
    return record.toolName === input.delegationTool &&
      record.status === "completed" &&
      Boolean(result && typeof result === "object" &&
        Reflect.get(result, "ok") === true &&
        Reflect.get(result, "status") === "queued");
  });
}

/**
 * Delegated assignments keep executing until a terminal disposition. Ordinary
 * conversations retain the bounded reconciliation that permits an open reply.
 */
export function createGuidedTurnCloseout(input: GuidedTurnCloseoutInput): {
  reviewFinalCandidate(candidate: { text: string }): Promise<GuidedTurnCloseoutReview>;
  reconcileAfterLoop(text: string): Promise<string>;
  acceptedWorkResult(): Promise<AcceptedWorkResult | undefined>;
} {
  // A child's second text-only final settles incomplete: parent input, not failure.
  let settled: ReturnType<typeof incompleteChildResult> | undefined;
  let unboundCorrectionUsed = false;
  const reviewChildCandidate = async (text: string): Promise<GuidedTurnCloseoutReview> => {
    const bound = await loadBoundWork(input);
    if (bound?.status === "abandoned") {
      settled = { result: abandonedChildResult(bound), text: text.trim() || `Work ${bound.workId} was abandoned.` };
      return { status: "accepted", text: settled.text };
    }
    if (guidedWorkReportDecision(bound, input.turnId, true).status === "report") return { status: "accepted" };
    const claimed = bound
      ? await claimCloseoutCorrection(input, bound.workId)
      : !unboundCorrectionUsed && (unboundCorrectionUsed = true);
    if (claimed) {
      const candidateWorkId = bound ? undefined : await openWorkId(input);
      return { status: "continue", observation: childCloseoutObservation({ work: bound, candidateWorkId }) };
    }
    settled = incompleteChildResult(bound, text);
    return { status: "accepted", text: settled.text };
  };
  const acceptedWorkResult = async (): Promise<AcceptedWorkResult | undefined> => {
    if (settled) return settled.result;
    const bound = await loadBoundWork(input);
    const decision = guidedWorkReportDecision(bound, input.turnId, input.requiresTerminalResult ?? false);
    if (decision.status !== "report") return undefined;
    return input.requiresTerminalResult && bound && decision.result?.status === "blocked"
      ? blockedChildResult(bound, input.toolJournal?.list(input.turnId) ?? [])
      : decision.result;
  };
  return {
    acceptedWorkResult,
    async reviewFinalCandidate(candidate) {
      try {
        if (input.requiresTerminalResult) return await reviewChildCandidate(candidate.text);
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
      } catch (error) {
        if (!isOpenDispositionPublicationFailure(error)) throw error;
        return { status: "accepted" as const };
      }
    },

    async reconcileAfterLoop(text) {
      try {
        if (input.trackingMode === "none" && !input.requiresTerminalResult) return text;
        // A child reply is either terminal or already settled as incomplete for
        // the parent; the missing disposition is never a runtime failure.
        if (input.requiresTerminalResult) {
          if (settled || await acceptedWorkResult()) return settled?.text ?? text;
          settled = incompleteChildResult(await loadBoundWork(input), text);
          return settled.text;
        }
        const bound = await loadBoundWork(input);
        if (!bound) return text;
        if (isFreshCurrentDisposition(bound, input.turnId)) {
          return bound.latestDisposition?.runtimeOwnedOpen
            ? noticeCandidate(input, text)
            : text;
        }
        return await settleOpen(input, bound, text);
      } catch (error) {
        if (!isOpenDispositionPublicationFailure(error)) throw error;
        return text;
      }
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

async function openWorkId(input: GuidedTurnCloseoutInput): Promise<string | undefined> {
  try {
    return (await input.durableWork.loadContext(input.workScope))?.work.workId;
  } catch {
    return undefined;
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
    const current = await input.durableWork.boundWorkForTurn(input.turnId);
    if (!current || current.workId !== bound.workId) {
      throw new Error("Runtime-owned open Work binding changed before settlement");
    }
    const expectedMaterialFingerprint = dispositionMaterialFingerprint(current);
    let persisted: DurableWorkView;
    try {
      persisted = await input.durableWork.recordDisposition({
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
    } catch (error) {
      if (!isOpenDispositionPublicationFailure(error)) throw error;
      // Runtime-owned open is bookkeeping. The Work is already open, so a
      // publication failure must not discard an otherwise valid user answer.
      return candidate.trim();
    }
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

function isOpenDispositionPublicationFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const code = Reflect.get(current, "code");
    if (code === "project_ledger_effect_not_applied" ||
        code === "project_ledger_effect_uncertain") return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

function noticeCandidate(input: GuidedTurnCloseoutInput, candidate: string): string {
  const notice = closeoutCopy(input).notice;
  const content = candidate.trim();
  return content.startsWith(`${notice}\n\n`)
    ? content
    : `${notice}\n\n${content}`;
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
        notice: "진행 메모: 이 작업은 아직 열려 있으며 이어서 진행할 수 있습니다.",
      }
    : {
        summary: "The current Turn could not confirm completion, so the Work remains open.",
        nextCondition: "Review the current results and completion conditions, then record the Work disposition again.",
        notice: "Progress note: this work is still open and can be continued.",
      };
}
