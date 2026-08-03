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
import { safeCommandActionLabel } from
  "../../packages/butler-agent/src/agent/output/progress/arguments.ts";
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
import { runCommandToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/run-command/run_command/definition.ts";
import { prepareBtccToolCall } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-execution.ts";

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

test("run_command operation projects the model-authored action label without parsing command text", async () => {
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
      summary: "실행: curl 상태 확인",
      cwd: "/workspace/private-client/acquisition-secret",
      state_effect: "validation",
      validation_suite: "focused-check",
    },
    status: "started",
  });

  const payload = events[0]?.payload ?? {};
  const row = progressRowFromSharedTurnEvent(events[0]!);
  expect(payload.safeLabel).toBe("실행: curl 상태 확인");
  expect(payload.safeLabel).not.toBe("작업 실행");
  expect([...String(payload.safeLabel)].length).toBeLessThanOrEqual(32);
  expect(payload.inputLabel).toBe("실행: curl 상태 확인");
  expect(JSON.stringify(payload)).not.toContain("secret");
  expect(JSON.stringify(payload)).not.toContain("password");
  expect(JSON.stringify(payload)).not.toContain("Authorization");
  expect(JSON.stringify(payload)).not.toContain("private-client");
  expect(payload.detailRows).toEqual(expect.arrayContaining([
    expect.objectContaining({
      safe_label: "Command",
      safe_value: "실행: curl 상태 확인",
    }),
  ]));
  expect(row).toMatchObject({
    safe_label: "실행: curl 상태 확인",
    safe_input_label: "실행: curl 상태 확인",
    bridge_phase: "btcc_operation",
    safe_detail_rows: expect.arrayContaining([
      expect.objectContaining({
        safe_label: "Command",
        safe_value: "실행: curl 상태 확인",
      }),
    ]),
  });
  if (!row) throw new Error("run_command progress row was not projected");
  const parameters = runCommandToolDefinition.parameters as {
    properties: Record<string, {
      type?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      description?: string;
    }>;
    required: string[];
  };
  expect(parameters.required).toContain("summary");
  expect(parameters.properties.summary).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 32,
  });
  expect(parameters.properties.summary?.description).toContain("model-authored");
  expect(parameters.properties.summary?.description).toContain("실행: git commit");
  const activity = activityContent(
    {
      name: "run_command",
      args: {
        command: "git commit -m 'release' && git push origin main",
        summary: "커밋 후 푸시",
      },
    },
    [{
      name: "run_command",
      args: {
        command: "git commit -m 'release' && git push origin main",
        summary: "커밋 후 푸시",
      },
    }],
    "",
  );
  expect(activity.title).toBe("커밋 후 푸시");
  expect(activity.summary).toBe("커밋 후 푸시");
});

test("run_command public summaries use canonical public-text sanitization", async () => {
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
    turnId: "turn-command-summary-safety",
    activityId: "activity-command-summary-safety",
    requestId: "command-summary-safety",
    toolName: "run_command",
    args: {
      command: "curl -H 'Authorization: Bearer private-token' /Users/alice/private/report.json",
      summary: "실행: curl token=private-token",
    },
    status: "started",
  });

  const row = progressRowFromSharedTurnEvent(events[0]!);
  expect(row?.safe_input_label).toContain("실행: curl");
  expect(row?.safe_input_label).not.toContain("private-token");
  expect(row?.safe_input_label).not.toContain("Authorization");
  expect(safeCommandActionLabel({
    summary: "Inspect /Users/alice/private/report.json",
  })).toBe("");
});

test("run_command model-authored action label is enforced by the native tool-call schema boundary", () => {
  const missingSummary = prepareBtccToolCall(
    { tools: [runCommandToolDefinition] },
    {
      id: "run-command-missing-summary",
      name: "run_command",
      arguments: { command: "pwd" },
      rawArguments: JSON.stringify({ command: "pwd" }),
    },
  );
  expect(missingSummary.validationError).toContain(
    "requires argument: summary",
  );

  const valid = prepareBtccToolCall(
    { tools: [runCommandToolDefinition] },
    {
      id: "run-command-with-summary",
      name: "run_command",
      arguments: {
        command: "pwd",
        summary: "실행: pwd",
      },
      rawArguments: JSON.stringify({
        command: "pwd",
        summary: "실행: pwd",
      }),
    },
  );
  expect(valid.validationError).toBeNull();

  const whitespaceOnly = prepareBtccToolCall(
    { tools: [runCommandToolDefinition] },
    {
      id: "run-command-whitespace-summary",
      name: "run_command",
      arguments: { command: "pwd", summary: " \n\t" },
      rawArguments: JSON.stringify({ command: "pwd", summary: " \n\t" }),
    },
  );
  expect(whitespaceOnly.validationError).toContain("summary");
  expect(whitespaceOnly.validationError).toContain("invalid arguments");

  const sentence = "실행할 Git 커밋 명령의 목적과 결과를 사용자에게 자세하게 설명합니다.";
  const tooLong = prepareBtccToolCall(
    { tools: [runCommandToolDefinition] },
    {
      id: "run-command-long-label",
      name: "run_command",
      arguments: { command: "git commit", summary: sentence },
      rawArguments: JSON.stringify({ command: "git commit", summary: sentence }),
    },
  );
  expect(tooLong.validationError).toContain("summary");
  expect(tooLong.validationError).toContain("length <= 32");

  const multiline = prepareBtccToolCall(
    { tools: [runCommandToolDefinition] },
    {
      id: "run-command-multiline-label",
      name: "run_command",
      arguments: { command: "git push", summary: "실행: git push\norigin 반영" },
      rawArguments: JSON.stringify({
        command: "git push",
        summary: "실행: git push\norigin 반영",
      }),
    },
  );
  expect(multiline.validationError).toContain("summary");
  expect(multiline.validationError).toContain("invalid arguments");
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
  expect(publicToolTitle("run_command", {
    command: "opaque command text",
    summary: "실행: git commit",
  })).toBe("실행: git commit");
  expect(publicToolTitle("tool_call", {
    id: "native:run_command",
    arguments: {
      command: "opaque command text",
      summary: "커밋 후 푸시",
    },
  })).toBe("커밋 후 푸시");
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
            {
              actionKey: "현재 적용 경로 확인",
              description: "현재 사용자 프로필 적용 경로를 확인한다.",
              dependencyKeys: [],
              effect: { capability: "workspace.file", target: "workspace:profile.md" },
            },
            {
              actionKey: "원인 수정",
              description: "확인된 문제의 원인을 수정한다.",
              dependencyKeys: ["현재 적용 경로 확인"],
              effect: { capability: "workspace.file", target: "workspace:fix.md" },
            },
            {
              actionKey: "변경 결과 검증",
              description: "수정된 동작이 요청을 만족하는지 검증한다.",
              dependencyKeys: ["원인 수정"],
              effect: { capability: "workspace.file", target: "workspace:verify.md" },
            },
            {
              actionKey: "운영 환경 반영",
              description: "검증된 변경을 운영 환경에 반영한다.",
              dependencyKeys: ["변경 결과 검증"],
              effect: { capability: "workspace.file", target: "workspace:release.md" },
            },
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

test("opaque Work action identifiers use their authored effect targets only in public progress", async () => {
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
  const opaqueKey = "write_marker_with_required_command";
  const humanKey = "운영 환경 반영";
  const target = "workspace:command-result-file-with-a-long-name.txt";
  const boundWork = {
    workId: "work-public-action-target",
    objective: "요청한 변경을 완료합니다.",
    status: "open",
    currentPlan: {
      planRevisionId: "plan-public-action-target",
      revision: 1,
      objective: "요청한 변경을 완료합니다.",
      actions: [
        {
          actionKey: opaqueKey,
          description: opaqueKey,
          dependencyKeys: [],
          effect: { capability: "workspace.file", target },
        },
        {
          actionKey: humanKey,
          description: humanKey,
          dependencyKeys: [opaqueKey],
          effect: { capability: "workspace.file", target: "workspace:release.md" },
        },
      ],
      checks: [],
      originTurnId: "turn-public-action-target",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    actionProgress: [
      { actionKey: opaqueKey, status: "active" as const },
      { actionKey: humanKey, status: "pending" as const },
    ],
  };
  const service = {
    async boundWorkForTurn() {
      return boundWork;
    },
  } as unknown as DurableWorkService;

  await publishWorkProgress(progress, "turn-public-action-target", 1, service);
  const rows = events
    .map(progressRowFromSharedTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const boundedTarget = `${[...target].slice(0, 31).join("")}…`;

  expect(rows.map((row) => row.safe_label)).toEqual([boundedTarget, humanKey]);
  expect(rows[0]?.safe_label).not.toBe(opaqueKey);
  expect([...rows[0]!.safe_label].length).toBe(32);
  expect(boundWork.currentPlan.actions.map((action) => action.actionKey))
    .toEqual([opaqueKey, humanKey]);
});

test("legacy generic Work action tokens use stored effect targets only for public titles", async () => {
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
  const actionKeys = ["inspect", "plan", "implement", "validate", "release", "closeout"];
  const targets = [
    "작업공간 상태를 확인합니다.",
    "변경 계획을 정리합니다.",
    "원인 수정 내용을 적용합니다.",
    "변경 결과를 검증합니다.",
    "검증된 변경을 반영합니다.",
    "결과와 후속 조치를 마무리합니다.",
  ];
  const boundWork = {
    workId: "work-legacy-action-tokens",
    objective: "요청한 변경을 완료합니다.",
    status: "open",
    currentPlan: {
      planRevisionId: "plan-legacy-action-tokens",
      revision: 1,
      objective: "요청한 변경을 완료합니다.",
      actions: actionKeys.map((actionKey, index) => ({
        actionKey,
        description: actionKey,
        dependencyKeys: index === 0 ? [] : [actionKeys[index - 1]!],
        effect: {
          capability: "workspace.file",
          target: targets[index]!,
        },
      })),
      checks: [],
      originTurnId: "turn-legacy-action-tokens",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    actionProgress: actionKeys.map((actionKey) => ({
      actionKey,
      status: actionKey === "release"
        ? "active" as const
        : actionKey === "closeout"
          ? "pending" as const
          : "done" as const,
    })),
  };
  const service = {
    async boundWorkForTurn() {
      return boundWork;
    },
  } as unknown as DurableWorkService;

  await publishWorkProgress(progress, "turn-legacy-action-tokens", 1, service);
  const rows = events
    .map(progressRowFromSharedTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  expect(rows.map((row) => row.safe_label)).toEqual(targets);
  expect(rows.map((row) => row.safe_label)).not.toEqual(actionKeys);
  expect(rows.find((row) => row.safe_label === targets[4])?.state).toBe("active");
  expect(rows.find((row) => row.safe_label === targets[5])?.state).toBe("planned");
  expect(boundWork.currentPlan.actions.map((action) => action.actionKey))
    .toEqual(actionKeys);
});

test("legacy generic Work keys prefer meaningful descriptions through publishWorkProgress", async () => {
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
  const actions = [
    {
      actionKey: "inspect",
      description: "validate",
      dependencyKeys: [],
      effect: { capability: "workspace.file", target: "workspace:secret.md" },
    },
    {
      actionKey: "validate",
      description: "Validate the focused result",
      dependencyKeys: ["inspect"],
      effect: { capability: "workspace.file", target: "workspace:result.md" },
    },
  ];
  const boundWork = {
    workId: "work-legacy-description-priority",
    objective: "요청한 변경을 완료합니다.",
    status: "open",
    currentPlan: {
      planRevisionId: "plan-legacy-description-priority",
      revision: 1,
      objective: "요청한 변경을 완료합니다.",
      actions,
      checks: [],
      originTurnId: "turn-legacy-description-priority",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    actionProgress: [
      { actionKey: "inspect", status: "done" as const },
      { actionKey: "validate", status: "active" as const },
    ],
  };
  const service = {
    async boundWorkForTurn() {
      return boundWork;
    },
  } as unknown as DurableWorkService;

  await publishWorkProgress(progress, "turn-legacy-description-priority", 1, service);
  const rows = events
    .map(progressRowFromSharedTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  expect(rows.map((row) => row.safe_label)).toEqual([
    "workspace:secret.md",
    "Validate the focused result",
  ]);
  expect(rows.map((row) => row.state)).toEqual(["completed", "active"]);
  expect(rows.map((row) => row.safe_detail_rows?.find((detail) => detail.kind === "task_description")?.safe_value))
    .toEqual([
      "validate",
      "Validate the focused result",
    ]);
});

test("public progress preserves durable action status without runtime reinterpretation", async () => {
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
  const actionKeys = ["inspect", "plan", "implement", "validate", "release", "closeout"];
  const boundWork = {
    workId: "work-legacy-reopened-release",
    objective: "요청한 변경을 완료합니다.",
    status: "open",
    currentPlan: {
      planRevisionId: "plan-legacy-reopened-release",
      revision: 1,
      objective: "요청한 변경을 완료합니다.",
      actions: actionKeys.map((actionKey, index) => ({
        actionKey,
        description: actionKey,
        dependencyKeys: index === 0 ? [] : [actionKeys[index - 1]!],
        effect: {
          capability: "workspace.file",
          target: `대상 ${index + 1}`,
        },
      })),
      checks: [],
      originTurnId: "turn-legacy-reopened-release",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    actionProgress: actionKeys.map((actionKey) => ({
      actionKey,
      status: actionKey === "release"
        ? "active" as const
        : actionKey === "closeout"
          ? "done" as const
          : "done" as const,
    })),
  };
  const service = {
    async boundWorkForTurn() {
      return boundWork;
    },
  } as unknown as DurableWorkService;

  await publishWorkProgress(progress, "turn-legacy-reopened-release", 1, service);
  const rows = events
    .map(progressRowFromSharedTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  expect(rows.find((row) => row.safe_label === "대상 5")?.state).toBe("active");
  expect(rows.find((row) => row.safe_label === "대상 6")?.state).toBe("completed");
  expect(boundWork.actionProgress.find((action) => action.actionKey === "closeout")?.status)
    .toBe("done");
});

test("legacy target compatibility does not treat arbitrary slugs as stage tokens", async () => {
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
    workId: "work-arbitrary-slug",
    objective: "요청한 작업을 진행합니다.",
    status: "open",
    currentPlan: {
      planRevisionId: "plan-arbitrary-slug",
      revision: 1,
      objective: "요청한 작업을 진행합니다.",
      actions: [{
        actionKey: "audit",
        description: "audit",
        dependencyKeys: [],
        effect: {
          capability: "workspace.file",
          target: "임의 토큰에 대한 효과 대상",
        },
      }],
      checks: [],
      originTurnId: "turn-arbitrary-slug",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    actionProgress: [{ actionKey: "audit", status: "pending" as const }],
  };
  const service = {
    async boundWorkForTurn() {
      return boundWork;
    },
  } as unknown as DurableWorkService;

  await publishWorkProgress(progress, "turn-arbitrary-slug", 1, service);
  const row = events
    .map(progressRowFromSharedTurnEvent)
    .find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  expect(row?.safe_label).toBe("audit");
  expect(row?.safe_label).not.toBe("임의 토큰에 대한 효과 대상");
});
