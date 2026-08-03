import { expect, test } from "bun:test";
import type { SharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { progressRowFromSharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import {
  applyWorkActionUpdates,
  type DurableWorkService,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { publishOperation } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-progress.ts";
import { publishWorkProgress } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-work-runtime.ts";
import { activityContent } from
  "../../packages/butler-agent/src/agent/btcc/projection/guided-activity-content.ts";
import { publicToolTitle } from
  "../../packages/butler-agent/src/agent/btcc/projection/guided-activity-content.ts";
import { projectTurnProgressToEvents } from
  "../../packages/butler-agent/src/agent/btcc/projection/turn-progress.ts";
import { projectTurnActivity } from
  "../../packages/butler-app/client/ui/src/app/conversation-progress/activity.ts";

test("a freshly admitted Turn publishes an honest visible progress block", async () => {
  const events: SharedTurnEvent[] = [];
  const progress = projectTurnProgressToEvents(async (event) => {
    events.push({
      id: "event-admitted",
      turnSequence: 1,
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload,
    });
  });

  await progress.stateChanged({
    turnId: "turn-admitted",
    semanticState: "admitted",
    turnRevision: 1,
  });

  expect(events).toEqual([
    expect.objectContaining({
      kind: "assistant.public_note",
      payload: expect.objectContaining({
        note: "요청을 확인하고 있습니다",
        btccState: "admitted",
      }),
    }),
  ]);
});

test("model-round waiting is visible before every provider request and ends on return", async () => {
  const order: string[] = [];
  const updates: Array<{ turnId: string; requestId: string; status: string }> = [];
  let round = 0;

  const result = await runBtccAgentLoop({
    turnId: "turn-model-wait",
    prompt: "Answer usefully.",
    tools: [],
    progress: {
      stateChanged() {},
      modelRoundWaitingChanged(update) {
        updates.push(update);
        order.push(update.status === "started" ? "start" : "end");
      },
    },
    modelRound: {
      async runRound() {
        order.push("provider");
        round += 1;
        return round === 1 ? { toolCalls: [] } : { text: "done", toolCalls: [] };
      },
    },
    executeTool: async () => null,
  });

  expect(result.finalText).toBe("done");
  expect(order).toEqual(["start", "provider", "end", "start", "provider", "end"]);
  expect(updates).toEqual([
    { turnId: "turn-model-wait", requestId: "btcc-model-round-0", status: "started" },
    { turnId: "turn-model-wait", requestId: "btcc-model-round-0", status: "completed" },
    { turnId: "turn-model-wait", requestId: "btcc-model-round-1", status: "started" },
    { turnId: "turn-model-wait", requestId: "btcc-model-round-1", status: "completed" },
  ]);

  const events: SharedTurnEvent[] = [];
  const projectedProgress = projectTurnProgressToEvents(async (event) => {
    events.push({
      id: `event-${events.length + 1}`,
      turnSequence: events.length + 1,
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload,
    });
  });
  await projectedProgress.modelRoundWaitingChanged?.({
    turnId: "turn-model-wait",
    requestId: "btcc-model-round-2",
    status: "started",
  });
  await projectedProgress.modelRoundWaitingChanged?.({
    turnId: "turn-model-wait",
    requestId: "btcc-model-round-2",
    status: "completed",
  });
  expect(progressRowFromSharedTurnEvent(events[0]!)).toMatchObject({
    state: "running",
    bridge_phase: "model_round_waiting",
    tool_call_id: "btcc-model-round-2",
  });
  expect(progressRowFromSharedTurnEvent(events[1]!)).toMatchObject({
    state: "delivered",
    bridge_phase: "model_round_waiting",
    tool_call_id: "btcc-model-round-2",
  });
});

test("run_command operation projects structured intent without exposing raw command text", async () => {
  const events: SharedTurnEvent[] = [];
  const progress = projectTurnProgressToEvents(async (event) => {
    events.push({
      id: `event-${events.length + 1}`,
      turnSequence: events.length + 1,
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload,
    });
  });

  await publishOperation(progress, {
    turnId: "turn-operation-detail",
    activityId: "activity-operation-detail",
    requestId: "command-1",
    toolName: "run_command",
    args: {
      command: "curl -H 'Authorization: Bearer secret' -u user:password https://example.test",
      cwd: "/workspace/private-client/acquisition-secret",
      state_effect: "validation",
      validation_suite: "focused-check",
    },
    status: "started",
  });

  const payload = events[0]?.payload ?? {};
  const row = progressRowFromSharedTurnEvent(events[0]!);
  expect(payload.safeLabel).toBe("검증 명령");
  expect(payload.safeLabel).not.toBe("작업 실행");
  expect([...String(payload.safeLabel)].length).toBeLessThanOrEqual(32);
  expect(payload.inputLabel).toBe("검증 명령");
  expect(JSON.stringify(payload)).not.toContain("secret");
  expect(JSON.stringify(payload)).not.toContain("password");
  expect(JSON.stringify(payload)).not.toContain("Authorization");
  expect(JSON.stringify(payload)).not.toContain("private-client");
  expect(payload.detailRows).toEqual(expect.arrayContaining([
    expect.objectContaining({ safe_label: "Command", safe_value: "검증 명령" }),
  ]));
  expect(row).toMatchObject({
    safe_label: "검증 명령",
    safe_input_label: "검증 명령",
    bridge_phase: "btcc_operation",
    safe_detail_rows: expect.arrayContaining([
      expect.objectContaining({ safe_label: "Command", safe_value: "검증 명령" }),
    ]),
  });
  const activity = activityContent(
    { name: "run_command", args: { command: "git status --short" } },
    [{ name: "run_command", args: { command: "git status --short" } }],
    "",
  );
  expect(activity.title).not.toBe(activity.summary);
});

test("progressive tool discovery and dispatch keep distinct product-facing titles", () => {
  expect(publicToolTitle("tool_search")).toBe("사용 가능한 도구 찾기");
  expect(publicToolTitle("tool_describe")).toBe("도구 사용법 확인");
  expect(publicToolTitle("tool_call", {
    id: "native:project_ledger_create",
    arguments: {},
  })).toBe("프로젝트 기록 변경");
  expect(publicToolTitle("tool_call", {
    id: "native:project_ledger_show",
    arguments: {},
  })).toBe("프로젝트 기록 확인");
});

test("structured action updates preserve prior completion and compact work titles with full detail", async () => {
  const description = "Read every relevant workspace file, compare the observed runtime path, and report the verified result with all important context.";
  const plan = {
    planRevisionId: "plan-1",
    revision: 1,
    objective: "Verify the requested runtime path.",
    actions: [
      { actionKey: "Inspect relevant workspace files", description, dependencyKeys: [] },
      { actionKey: "Verify the requested result", description: "Run the focused verification and report the result.", dependencyKeys: ["Inspect relevant workspace files"] },
    ],
    checks: [],
    originTurnId: "turn-work-progress",
    createdAt: "2026-08-03T00:00:00.000Z",
  };
  const prior = [
    { actionKey: "Inspect relevant workspace files", status: "done" as const },
    { actionKey: "Verify the requested result", status: "pending" as const },
  ];
  const updated = applyWorkActionUpdates(
    { currentPlan: plan, actionProgress: prior },
    [{ actionKey: "Verify the requested result", status: "active" }],
  );
  expect(updated).toEqual([
    { actionKey: "Inspect relevant workspace files", status: "done" },
    { actionKey: "Verify the requested result", status: "active" },
  ]);

  const events: SharedTurnEvent[] = [];
  const progress = projectTurnProgressToEvents(async (event) => {
    events.push({
      id: `event-${events.length + 1}`,
      turnSequence: events.length + 1,
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload,
    });
  });
  const boundWork = {
        workId: "work-progress",
        objective: plan.objective,
        status: "open",
        currentPlan: plan,
        actionProgress: updated,
      };
  const service = {
    async boundWorkForTurn() {
      return boundWork;
    },
  } as unknown as DurableWorkService;
  await publishWorkProgress(progress, "turn-work-progress", 1, service);

  const rows = events
    .map(progressRowFromSharedTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  expect(rows).toEqual([
    expect.objectContaining({
      state: "completed",
      safe_detail_rows: expect.arrayContaining([
        expect.objectContaining({ safe_label: "Task", safe_value: description }),
      ]),
    }),
    expect.objectContaining({ state: "active" }),
  ]);
  expect(rows[0]?.safe_label).not.toBe(description);
  expect(rows[0]?.safe_label).toBe("Inspect relevant workspace files");
  expect(rows.every((row) => row.safe_label.length <= 32)).toBe(true);

  const stageRows = projectTurnActivity([
    {
      id: "execution",
      kind: "message",
      state: "running",
      safe_label: "현재 실행 중",
      work_decision_source: "model-authored",
      work_decision_summary: "현재 실행 중",
      activity_stage: "execution",
      turn_event_sequence: 20,
    },
    {
      id: "planning",
      kind: "message",
      state: "running",
      safe_label: "계획 중",
      work_decision_source: "model-authored",
      work_decision_summary: "계획 중",
      activity_stage: "planning",
      turn_event_sequence: 10,
    },
  ]);
  expect(stageRows.semanticState).toBe("execution");

  const mixedRows = projectTurnActivity([
    {
      id: "legacy-planning",
      kind: "message",
      state: "running",
      safe_label: "이전 계획",
      work_decision_source: "model-authored",
      work_decision_summary: "이전 계획",
      activity_stage: "planning",
    },
    {
      id: "current-execution",
      kind: "message",
      state: "running",
      safe_label: "현재 실행",
      work_decision_source: "model-authored",
      work_decision_summary: "현재 실행",
      activity_stage: "execution",
      turn_event_sequence: 30,
    },
  ]);
  expect(mixedRows.semanticState).toBe("execution");
});

test("Plan action keys are immediate stable checklist summaries while notes remain outcomes", async () => {
  const events: SharedTurnEvent[] = [];
  const progress = projectTurnProgressToEvents(async (event) => {
    events.push({
      id: `event-${events.length + 1}`,
      turnSequence: events.length + 1,
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload,
    });
  });
  const actionProgress: Array<{
    actionKey: string;
    status: "pending" | "active" | "done" | "blocked" | "skipped";
    note?: string;
  }> = [
    { actionKey: "현재 적용 경로 확인", status: "active" },
    { actionKey: "원인 수정", status: "pending" },
    { actionKey: "변경 결과 검증", status: "pending" },
    { actionKey: "운영 환경 반영", status: "pending" },
  ];
  const boundWork = {
        workId: "work-opaque-keys",
        objective: "요청한 변경을 완료한다.",
        status: "open",
        currentPlan: {
          planRevisionId: "plan-opaque-keys",
          revision: 1,
          objective: "요청한 변경을 완료한다.",
          actions: [
            { actionKey: "현재 적용 경로 확인", description: "현재 사용자 프로필 적용 경로를 확인한다.", dependencyKeys: [] },
            { actionKey: "원인 수정", description: "확인된 문제의 원인을 수정한다.", dependencyKeys: ["현재 적용 경로 확인"] },
            { actionKey: "변경 결과 검증", description: "수정된 동작이 요청을 만족하는지 검증한다.", dependencyKeys: ["원인 수정"] },
            { actionKey: "운영 환경 반영", description: "검증된 변경을 운영 환경에 반영한다.", dependencyKeys: ["변경 결과 검증"] },
          ],
          checks: [],
          originTurnId: "turn-opaque-keys",
          createdAt: "2026-08-03T00:00:00.000Z",
        },
        actionProgress,
      };
  const service = {
    async boundWorkForTurn() {
      return boundWork;
    },
  } as unknown as DurableWorkService;

  await publishWorkProgress(progress, "turn-opaque-keys", 1, service);
  const initialRows = events
    .map(progressRowFromSharedTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  expect(initialRows.map((row) => row.safe_label)).toEqual([
    "현재 적용 경로 확인",
    "원인 수정",
    "변경 결과 검증",
    "운영 환경 반영",
  ]);
  expect(initialRows.map((row) => row.safe_label)).not.toContain("작업 1");

  boundWork.actionProgress[0] = {
    actionKey: "현재 적용 경로 확인",
    status: "done",
    note: "적용 경로가 확인되었습니다.",
  };
  await publishWorkProgress(progress, "turn-opaque-keys", 2, service);
  const updatedRows = events
    .slice(initialRows.length)
    .map(progressRowFromSharedTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  expect(updatedRows.map((row) => row.safe_label)).toEqual(
    initialRows.map((row) => row.safe_label),
  );
  expect(events[initialRows.length]?.payload?.detailRows).toContainEqual(
    expect.objectContaining({
      kind: "task_outcome",
      safe_value: "적용 경로가 확인되었습니다.",
    }),
  );
});
