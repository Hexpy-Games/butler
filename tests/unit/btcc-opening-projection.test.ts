import { expect, test } from "bun:test";
import { publishOpeningDecision, publishTurnProgress } from
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
    continuationMode: "managed_request",
    route: "managed",
    fulfillment: {
      requestObligation: "요청한 프로젝트 변경을 구현한다",
      requiredResultKind: "target_change",
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
    activityId: "phase-activity:planning-round-2",
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
      semanticBlockId: "phase-activity:planning-round-2",
    },
  }]);
});

test("projects each operation into its exact model-authored activity block", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await observer.operationChanged?.({
    turnId: "turn-phase-activity",
    semanticState: "task_execution",
    activityId: "phase-activity:execution-round-7",
    requestId: "read-current-file",
    publicTitle: "현재 파일을 확인합니다",
    capabilityRef: "read_file",
    status: "completed",
  });

  expect(events[0]?.payload?.semanticBlockId)
    .toBe("phase-activity:execution-round-7");
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

test("distinguishes provider product correction from connection recovery", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await observer.operationalNoticeChanged?.({
    turnId: "turn-product-correction",
    semanticState: "feedback_planning",
    status: "recovering",
    code: "provider_phase_submission_invalid",
    activationKind: "automatic_provider_recovery",
  });

  expect(events[0]?.payload?.note).toBe(
    "모델 출력 형식을 바로잡고 있습니다",
  );
});

test("keeps runtime remediation out of the public conversation", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await observer.operationalNoticeChanged?.({
    turnId: "turn-runtime-remediation",
    semanticState: "task_review",
    status: "interrupted",
    code: "provider_phase_submission_invalid",
    activationKind: "runtime_remediation",
  });

  expect(events).toEqual([]);
});

test("projects one runtime-owned waiting state for a selected-model round", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await observer.modelRoundWaiting?.({
    turnId: "turn-model-wait",
    semanticState: "planning",
    checkpointId: "checkpoint-planning",
  });

  const row = progressRowFromSharedTurnEvent({
    id: "model-wait-event",
    turnSequence: 8,
    createdAt: "2026-07-24T12:00:00.000Z",
    kind: events[0]!.kind,
    payload: events[0]!.payload,
  });
  expect(row).toMatchObject({
    kind: "message",
    safe_label: "모델 응답을 기다리고 있습니다",
    bridge_phase: "model_round_waiting",
    semantic_block_id: "planning",
  });
});

test("projects canonical Work Ledger tasks without deriving labels or lifecycle", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await observer.workProgressChanged?.({
    turnId: "turn-work",
    turnRevision: 8,
    programId: "program-1",
    tasks: [
      {
        taskId: "task-1",
        taskTitle: "Implement the canonical projection",
        taskOrder: 1,
        taskState: "reviewing",
        workId: "work-1",
        workTitle: "Synchronize Work progress",
        workState: "active",
      },
    ],
  });

  const row = progressRowFromSharedTurnEvent({
    id: "event-work",
    turnSequence: 4,
    createdAt: "2026-07-27T00:00:00.000Z",
    kind: events[0]!.kind,
    payload: events[0]!.payload,
  });
  expect(row).toMatchObject({
    id: "task-1",
    kind: "todo",
    safe_label: "Implement the canonical projection",
    state: "reviewing",
    bridge_phase: "btcc_work_ledger",
    work_stream_id: "work-1",
    semantic_block_id: "work-ledger-program-1",
    safe_order: 1,
    safe_detail_rows: [{
      id: "work",
      kind: "work",
      safe_label: "Work",
      safe_value: "Synchronize Work progress",
      state: "active",
    }],
  });
});

test("committed BTCC successor publishes the installed Planning graph", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });
  const work = {
    workLogicalId: "work-1",
    outcome: "Deliver the Work projection",
  };
  const task = {
    taskLogicalId: "task-1",
    workLogicalId: "work-1",
    intendedOutcome: "Publish accepted Task state",
    executionOrdinal: 1,
  };

  await publishTurnProgress(observer, {
    turnId: "turn-work",
    revision: 9,
    semanticState: "task_review",
    managed: {
      program: {
        planningState: "reviewed",
        programId: "program-1",
        works: [{ work, status: "active" }],
        tasks: [{ task, status: "result_submitted" }],
      },
    },
  } as never);

  expect(events.map((event) => event.kind)).toEqual([
    "tool.progress",
    "assistant.public_note",
  ]);
  expect(events[0]?.payload).toMatchObject({
    todoId: "task-1",
    safeLabel: "Publish accepted Task state",
    state: "reviewing",
    workstreamId: "work-1",
  });
});
