import {
  asRecord,
  firstContinuationCandidateId,
} from "./managed-harness-state.ts";

export function submitOpening(
  context: unknown,
  chooseContinuation: boolean,
) {
  const common = {
    requestObligation: "고객 응대 원칙을 조사해 운영 가이드를 작성한다",
    summary: "요청의 목표와 완료 조건을 먼저 정리하겠습니다.",
    rationale: "원래 의도를 보존한 계획이 필요한 관리 작업입니다.",
    nextStep: "관련 스펙을 확인하고 Work와 Task를 구성하겠습니다.",
  };
  if (!chooseContinuation) {
    return {
      kind: "managed_continuation",
      requiredResultKind: "target_change",
      ...common,
    };
  }
  return {
    kind: "managed_program_continuation",
    requiredResultKind: "durable_work",
    continuationCandidateId: firstContinuationCandidateId(asRecord(context)),
    ...common,
  };
}

export function continuationReviewDecision(
  state: Record<string, unknown>,
  chooseContinuation: boolean,
) {
  if (!chooseContinuation) return {};
  return {
    continuationDecision: {
      kind: "bind",
      continuationCandidateId: firstContinuationCandidateId(state),
    },
  };
}
