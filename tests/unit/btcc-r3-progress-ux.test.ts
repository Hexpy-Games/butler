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
import { projectTurnProgressToEvents } from
  "../../packages/butler-agent/src/agent/btcc/projection/turn-progress.ts";
import { projectTurnActivity } from
  "../../packages/butler-app/client/ui/src/app/conversation-progress/activity.ts";

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
      cwd: "/Users/yeonwoo/private-client/acquisition-secret",
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

test("structured action updates preserve prior completion and compact work titles with full detail", async () => {
  const description = "Read every relevant workspace file, compare the observed runtime path, and report the verified result with all important context.";
  const plan = {
    planRevisionId: "plan-1",
    revision: 1,
    objective: "Verify the requested runtime path.",
    actions: [
      { actionKey: "inspect", description, dependencyKeys: [] },
      { actionKey: "verify", description: "Run the focused verification and report the result.", dependencyKeys: ["inspect"] },
    ],
    checks: [],
    originTurnId: "turn-work-progress",
    createdAt: "2026-08-03T00:00:00.000Z",
  };
  const prior = [
    { actionKey: "inspect", status: "done" as const },
    { actionKey: "verify", status: "pending" as const },
  ];
  const updated = applyWorkActionUpdates(
    { currentPlan: plan, actionProgress: prior },
    [{ actionKey: "verify", status: "active" }],
  );
  expect(updated).toEqual([
    { actionKey: "inspect", status: "done" },
    { actionKey: "verify", status: "active" },
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
  const service = {
    async boundWorkForTurn() {
      return {
        workId: "work-progress",
        objective: plan.objective,
        status: "open",
        currentPlan: plan,
        actionProgress: updated,
      };
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
  expect(rows[0]?.safe_label).toBe("inspect");
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
