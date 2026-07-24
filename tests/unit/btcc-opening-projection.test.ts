import { expect, test } from "bun:test";
import { publishOpeningDecision } from
  "../../packages/butler-agent/src/agent/btcc/turn/turn-progress.ts";
import { projectTurnProgress } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/project-turn-progress.ts";
import { progressRowFromSharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";

test("projects the committed model-authored Opening decision without rewriting it", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await publishOpeningDecision(observer, "turn-opening", 2, {
    kind: "opening_continuation",
    route: "managed",
    fulfillment: {
      requestObligation: "요청한 프로젝트 변경을 구현한다",
      completionMode: "managed_effect_or_artifact",
    },
    projection: {
      ref: { id: "opening-decision-1", sha256: "opening-sha-1" },
      summary: "요청의 목표와 완료 조건을 먼저 정리하겠습니다.",
      rationale: "원래 의도를 보존한 계획이 필요한 관리 작업입니다.",
      nextStep: "관련 스펙을 확인하고 Work와 Task를 구성하겠습니다.",
      contentSha256: "opening-content-sha-1",
    },
  });

  expect(events).toEqual([{
    kind: "assistant.decision",
    payload: {
      decisionId: "opening-decision-1",
      role: "opening",
      summary: "요청의 목표와 완료 조건을 먼저 정리하겠습니다.",
      rationale: "원래 의도를 보존한 계획이 필요한 관리 작업입니다.",
      nextStep: "관련 스펙을 확인하고 Work와 Task를 구성하겠습니다.",
      source: "model-authored",
      firstVisible: true,
      turnRevision: 2,
    },
  }]);
});

test("projects model-authored phase activity with intent and next step", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await observer.phaseActivityChanged?.({
    turnId: "turn-phase-activity",
    semanticState: "planning",
    summary: "수정할 모듈과 검증 경로를 확인하고 있습니다.",
    rationale: "기존 설계와 구현을 맞춘 최소 작업 범위를 정하기 위해 필요합니다.",
    nextStep: "확인 결과를 Work와 Task로 나누어 계획 후보를 작성합니다.",
  });

  expect(events).toEqual([{
    kind: "assistant.public_note",
    payload: {
      note: "수정할 모듈과 검증 경로를 확인하고 있습니다.",
      btccState: "planning",
      decisionSummary: "수정할 모듈과 검증 경로를 확인하고 있습니다.",
      decisionRationale: "기존 설계와 구현을 맞춘 최소 작업 범위를 정하기 위해 필요합니다.",
      decisionNextStep: "확인 결과를 Work와 Task로 나누어 계획 후보를 작성합니다.",
      decisionSource: "model-authored",
      semanticBlockId: "planning",
    },
  }]);
});

test("projects canonical phase identity and marks only active recovery as operational", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await observer.stateChanged({
    turnId: "turn-phase-handoff",
    semanticState: "planning_review",
    turnRevision: 5,
  });
  await observer.operationalNoticeChanged?.({
    turnId: "turn-phase-handoff",
    semanticState: "planning_review",
    status: "recovering",
    code: "provider_rate_limited",
    activationKind: "automatic_provider_recovery",
  });

  expect(events[0]?.payload?.semanticBlockId).toBe("planning_review");
  const recoveryRow = progressRowFromSharedTurnEvent({
    id: "recovery-event",
    turnSequence: 2,
    kind: events[1]!.kind,
    payload: events[1]!.payload,
  });
  expect(recoveryRow?.bridge_phase).toBe("operational_recovery");
  expect(recoveryRow?.semantic_block_id).toBe("planning_review");
});
