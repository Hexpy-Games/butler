import { expect, test } from "bun:test";
import type { SharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { progressRowFromSharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { projectTurnProgressToEvents as projectTurnProgress } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { createGuidedActivityProjection, publicToolTitle } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { normalizeProgressSummaryRow } from
  "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-normalizer.ts";
import { progressRowFromAppOutbound } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/app-transport-projection.ts";
import { safeCommandActionLabel } from
  "../../packages/butler-agent/src/agent/output/progress/arguments.ts";
import { dedupeProgressRows } from
  "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-merge.ts";
import { projectTurnActivity } from
  "../../packages/butler-app/client/ui/src/app/conversation-progress/activity.ts";

test("gateway projection keeps display stage separate and groups its completed tool", async () => {
  const events: SharedTurnEvent[] = [];
  const progress = projectTurnProgress(async (event) => {
    events.push({
      id: `event-${events.length + 1}`,
      turnSequence: events.length + 1,
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload,
    });
  });

  await progress.phaseActivityChanged?.({
    turnId: "turn-activity",
    semanticState: "admitted",
    activityId: "guided-activity:opaque-group",
    displayStage: "review",
    title: "결과 검토",
    summary: "실제 결과를 요청과 대조했습니다.",
  });
  expectNoUndefinedValues(events[0]?.payload);
  await progress.operationChanged?.({
    turnId: "turn-activity",
    semanticState: "admitted",
    activityId: "guided-activity:opaque-group",
    requestId: "review-call",
    publicTitle: "결과 검토 기록",
    capabilityRef: "record_work_review",
    status: "started",
  });
  await progress.operationChanged?.({
    turnId: "turn-activity",
    semanticState: "admitted",
    activityId: "guided-activity:opaque-group",
    requestId: "review-call",
    publicTitle: "결과 검토 기록",
    capabilityRef: "record_work_review",
    status: "completed",
  });

  const rows = dedupeProgressRows(events.flatMap((event) => {
    const row = progressRowFromSharedTurnEvent(event);
    return row ? [normalizeProgressSummaryRow(row)] : [];
  }));
  const projected = projectTurnActivity(rows);

  expect(projected.phaseActivities).toEqual([
    expect.objectContaining({
      phase: "review",
      summary: "실제 결과를 요청과 대조했습니다.",
      rationale: undefined,
      nextStep: undefined,
      operations: [expect.objectContaining({
        tool_call_id: "review-call",
        state: "delivered",
      })],
    }),
  ]);
  expect(projected.semanticState).toBe("review");
});

test("completion review projects a distinct validation activity without another model call", async () => {
  const updates: Array<{ displayStage?: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-validation",
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });

  projection.observeToolBatch({
    text: "",
    toolCalls: [{
      name: "record_work_review",
      args: {
        subject: "completion",
        verdict: "accept",
        summary: "원 요청, 계획, 검사 결과와 실제 산출물이 모두 일치합니다.",
      },
    }],
  });
  const binding = await projection.observeTool({
    name: "record_work_review",
    effectiveToolName: "record_work_review",
    args: {
      subject: "completion",
      verdict: "accept",
      summary: "원 요청, 계획, 검사 결과와 실제 산출물이 모두 일치합니다.",
    },
  });

  expect(updates).toEqual([]);
  await projection.publishAccepted(binding);
  expect(updates).toEqual([expect.objectContaining({
    displayStage: "validation",
    title: "완료 검토",
    summary: "원 요청, 계획, 검사 결과와 실제 산출물이 모두 일치합니다.",
  })]);
});

test("accepted completion projects the model-authored reporting direction after validation", async () => {
  const updates: Array<{
    displayStage?: string;
    title: string;
    summary: string;
  }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-report-direction",
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const args = {
    subject: "completion",
    verdict: "accept",
    summary: "원 요청과 검증 결과가 모두 일치합니다.",
  };
  projection.observeToolBatch({
    text: "변경 내용, 검증 결과, 운영 반영 순서로 정리해 보고합니다.",
    toolCalls: [{ name: "record_work_review", args }],
  });
  const binding = await projection.observeTool({
    name: "record_work_review",
    effectiveToolName: "record_work_review",
    args,
  });

  await projection.publishAccepted(binding);

  expect(updates).toEqual([
    expect.objectContaining({
      displayStage: "validation",
      title: "완료 검토",
      summary: "원 요청과 검증 결과가 모두 일치합니다.",
    }),
    expect.objectContaining({
      displayStage: "reporting",
      title: "결과 보고",
      summary: "변경 내용, 검증 결과, 운영 반영 순서로 정리해 보고합니다.",
    }),
  ]);
});

test("the first Plan projects distinct conception and planning activities from one accepted call", async () => {
  const updates: Array<{
    activityId?: string;
    displayStage?: string;
    title: string;
    summary: string;
  }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-conception-planning",
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const args = {
    objective: "두 입력을 비교해 검증된 보고서를 만듭니다.",
    actions: [{
      action_key: "compare",
      description: "두 입력을 확인하고 공통점을 비교합니다.",
    }],
    checks: ["보고서가 두 입력과 공통점을 포함합니다."],
  };
  projection.observeToolBatch({
    text: "요청의 목표와 필요한 결과를 파악했습니다.",
    toolCalls: [{ name: "replace_work_plan", args }],
  });
  const binding = await projection.observeTool({
    name: "replace_work_plan",
    effectiveToolName: "replace_work_plan",
    args,
  });

  expect(updates).toEqual([]);
  await projection.publishAccepted(binding);
  expect(updates).toEqual([
    expect.objectContaining({
      displayStage: "conception",
      title: "요청 의도 확인",
      summary: "요청의 목표와 범위를 확인했습니다: 두 입력을 비교해 검증된 보고서를 만듭니다.",
    }),
    expect.objectContaining({
      displayStage: "planning",
      title: "실행 계획 수립",
      summary: "두 입력을 비교해 검증된 보고서를 만듭니다.",
      nextStep: "두 입력을 확인하고 공통점을 비교합니다.",
    }),
  ]);
  expect(updates[0]?.activityId).toBeDefined();
  expect(updates[1]?.activityId).toBeDefined();
  expect(updates[0]?.activityId).not.toBe(updates[1]?.activityId);
});

test("first Plan uses an opaque action target but preserves a human-readable action key", async () => {
  const projectNextStep = async (args: Record<string, unknown>) => {
    const updates: Array<{ nextStep?: string }> = [];
    const projection = createGuidedActivityProjection({
      turnId: "turn-plan-action-display",
      progress: {
        stateChanged() {},
        phaseActivityChanged(update) {
          updates.push(update);
        },
      },
    });
    projection.observeToolBatch({
      text: "",
      toolCalls: [{ name: "replace_work_plan", args }],
    });
    const binding = await projection.observeTool({
      name: "replace_work_plan",
      effectiveToolName: "replace_work_plan",
      args,
    });
    await projection.publishAccepted(binding);
    return updates[1]?.nextStep;
  };
  const target = "workspace:command-result-file-with-a-long-name.txt";
  const opaqueKey = "write_marker_with_required_command";
  const humanKey = "운영 환경 반영";
  const boundedTarget = `${[...target].slice(0, 31).join("")}…`;

  await expect(projectNextStep({
    objective: "요청한 변경을 완료합니다.",
    actions: [{
      action_key: opaqueKey,
      description: opaqueKey,
      effect: { capability: "workspace.file", target },
    }],
    checks: [],
  })).resolves.toBe(boundedTarget);
  await expect(projectNextStep({
    objective: "요청한 변경을 완료합니다.",
    actions: [{
      action_key: humanKey,
      description: humanKey,
      effect: { capability: "workspace.file", target: "workspace:release.md" },
    }],
    checks: [],
  })).resolves.toBe(humanKey);
});

test("ordinary empty tool batches group repeated model-authored command labels once", async () => {
  const updates: Array<{ title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-grouped-tools",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const summary = "실행: 상태 확인";
  const calls = [
    { name: "run_command", args: { command: "pwd", summary } },
    { name: "run_command", args: { command: "git status", summary } },
    { name: "run_command", args: { command: "git diff", summary } },
  ];
  projection.observeToolBatch({ text: "", toolCalls: calls });
  for (const call of calls) {
    await projection.observeTool({ ...call, effectiveToolName: call.name });
  }

  expect(updates).toEqual([expect.objectContaining({
    title: summary,
    summary,
  })]);
});

test("different model-authored command labels remain under one activity", async () => {
  const updates: Array<{ activityId?: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-distinct-command-purposes",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const calls = [
    {
      name: "run_command",
      args: { command: "git status --short", summary: "실행: git status" },
    },
    {
      name: "run_command",
      args: { command: "git diff --check", summary: "검증: git diff" },
    },
  ];
  projection.observeToolBatch({ text: "", toolCalls: calls });
  const bindings = [];
  for (const call of calls) {
    bindings.push(await projection.observeTool({
      ...call,
      effectiveToolName: call.name,
    }));
  }

  expect(updates).toEqual([expect.objectContaining({
    title: "실행: git status",
    summary: "실행: git status",
  })]);
  expect(new Set(bindings.map((binding) => binding.activityId)).size).toBe(1);
  expect(safeCommandActionLabel(calls[1]!.args)).toBe(
    "검증: git diff",
  );
});

test("progressive run_command keeps model-authored nested labels under one activity", async () => {
  const updates: Array<{ activityId: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-progressive-command-summary",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const firstLabel = "실행: pwd";
  const secondLabel = "실행: pwd 재확인";
  const first = {
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: { command: "pwd", summary: firstLabel },
    },
  };
  const second = {
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: { command: "pwd", summary: secondLabel },
    },
  };
  const bindings = [];
  for (const call of [first, second]) {
    projection.observeToolBatch({ text: "", toolCalls: [call] });
    bindings.push(await projection.observeTool({
      ...call,
      effectiveToolName: "run_command",
    }));
  }

  expect(updates).toHaveLength(1);
  expect(updates[0]?.summary).toBe(firstLabel);
  expect(new Set(bindings.map((binding) => binding.activityId)).size).toBe(1);
  expect(safeCommandActionLabel(second.args.arguments)).toBe(secondLabel);
});

test("ordinary tools across model rounds inherit the accepted checkpoint activity", async () => {
  const updates: Array<{ activityId?: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-semantic-activity-anchor",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const checkpointArgs = {
    public_summary: "프로필 연결 정책과 표현 경로를 한 작업으로 수정합니다.",
    next_step: "관련 구현을 확인하고 수정한 뒤 검증합니다.",
    action_updates: [{
      action_key: "프로필 연결 정책과 표현 경로 수정",
      status: "active",
    }],
  };
  projection.observeToolBatch({
    text: "",
    toolCalls: [{ name: "record_work_checkpoint", args: checkpointArgs }],
  });
  const checkpoint = await projection.observeTool({
    name: "record_work_checkpoint",
    effectiveToolName: "record_work_checkpoint",
    args: checkpointArgs,
  });
  await projection.publishAccepted(checkpoint);

  const rounds = [
    [
      { name: "read_file", args: { requests: [{ path: "one.ts" }] } },
      { name: "grep_files", args: { pattern: "profile" } },
    ],
    [{ name: "project_ledger_create", args: { kind: "spec", id: "SPEC-1" } }],
    [{ name: "grep_files", args: { pattern: "decision" } }],
    [{ name: "read_file", args: { requests: [{ path: "two.ts" }] } }],
    [{ name: "edit_file", args: { path: "two.ts" } }],
    [{
      name: "run_command",
      args: { command: "bun test", summary: "수정한 정책 경로를 검증합니다." },
    }],
  ];
  const operationBindings = [];
  for (const calls of rounds) {
    projection.observeToolBatch({ text: "", toolCalls: calls });
    for (const call of calls) {
      operationBindings.push(await projection.observeTool({
        ...call,
        effectiveToolName: call.name,
      }));
    }
  }

  expect(updates).toEqual([expect.objectContaining({
    activityId: checkpoint.activityId,
    title: "프로필 연결 정책과 표현 경로 수정",
    summary: checkpointArgs.public_summary,
  })]);
  expect(operationBindings.every(
    (binding) => binding.activityId === checkpoint.activityId,
  )).toBe(true);
});

test("the active model-authored action owns prose summaries and deterministic operation labels", async () => {
  const updates: Array<{ activityId?: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-overarching-execution-activity",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const actionTitle = "검색 인덱스와 턴 판정 개선";
  const reviewArgs = {
    subject: "plan",
    verdict: "accept",
    summary: "검색 인덱스와 턴 판정을 함께 고치는 실행 계획을 승인합니다.",
    action_updates: [{ action_key: actionTitle, status: "active" }],
  };
  projection.observeToolBatch({
    text: "계획의 범위와 검증 기준을 확인했습니다.",
    toolCalls: [{ name: "record_work_review", args: reviewArgs }],
  });
  const review = await projection.observeTool({
    name: "record_work_review",
    effectiveToolName: "record_work_review",
    args: reviewArgs,
  });
  await projection.publishAccepted(review);

  const first = {
    name: "read_file",
    args: { requests: [{ path: "src/games/word-chain/game-handler.ts" }] },
  };
  const fullSummary =
    "냥, 답변 경로부터 확인하고 검색 인덱스와 턴 판정을 함께 수정한 뒤 전체 검증까지 진행하겠다냐.";
  projection.observeToolBatch({
    text: fullSummary,
    toolCalls: [first],
  });
  const firstBinding = await projection.observeTool({
    ...first,
    effectiveToolName: first.name,
  });

  const edit = {
    name: "edit_file",
    args: { path: "src/games/word-chain/game-handler.ts" },
  };
  projection.observeToolBatch({
    text: "조사: XML 구조와 크기",
    toolCalls: [edit],
  });
  const editBinding = await projection.observeTool({
    ...edit,
    effectiveToolName: edit.name,
  });

  expect(updates).toEqual([
    expect.objectContaining({
      title: "계획 검토",
      summary: reviewArgs.summary,
    }),
    expect.objectContaining({
      title: actionTitle,
      summary: fullSummary,
    }),
  ]);
  expect(editBinding.activityId).toBe(firstBinding.activityId);
  expect(updates[1]?.title).not.toContain("냥, 답변 경로부터");
  expect(updates[1]?.summary).toBe(fullSummary);
  expect(publicToolTitle(edit.name, edit.args)).toBe("수정: game-handler.ts");
});

test("unanchored empty ordinary rounds reuse one fallback activity across tool mixtures", async () => {
  const updates: Array<{ activityId?: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-fallback-activity-anchor",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const bindings = [];
  for (const call of [
    { name: "read_file", args: { requests: [{ path: "one.ts" }] } },
    { name: "grep_files", args: { pattern: "profile" } },
    { name: "read_file", args: { requests: [{ path: "two.ts" }] } },
  ]) {
    projection.observeToolBatch({ text: "", toolCalls: [call] });
    bindings.push(await projection.observeTool({
      ...call,
      effectiveToolName: call.name,
    }));
  }

  expect(updates).toHaveLength(1);
  expect(new Set(bindings.map((binding) => binding.activityId)).size).toBe(1);
});

test("unanchored assistant prose remains a full summary and never becomes the activity title", async () => {
  const updates: Array<{ title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-unanchored-prose-summary",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const summary = "냥, 우선 실제 구현 경로와 현재 상태를 충분히 확인한 뒤 필요한 변경과 검증을 이어가겠다냐.";
  const call = {
    name: "read_file",
    args: { requests: [{ path: "src/games/word-chain/game-handler.ts" }] },
  };
  projection.observeToolBatch({ text: summary, toolCalls: [call] });
  await projection.observeTool({ ...call, effectiveToolName: call.name });

  expect(updates).toEqual([expect.objectContaining({
    title: "읽기: game-handler.ts",
    summary,
  })]);
});

test("complete safe model activity text survives event, App, and UI projection", async () => {
  const longSummary = `시작-${"모델이 작성한 공개 진행 내용을 모두 보존합니다. ".repeat(18)}-끝`;
  const longRationale = `이유-${"사용자에게 작업 맥락을 빠짐없이 보여줍니다. ".repeat(16)}-끝`;
  const longNextStep = `다음-${"같은 의미 활동 아래에서 후속 도구를 실행합니다. ".repeat(15)}-끝`;
  expect(longSummary.length).toBeGreaterThan(240);

  const events: SharedTurnEvent[] = [];
  const progress = projectTurnProgress(async (event) => {
    events.push({
      id: `event-long-${events.length + 1}`,
      turnSequence: events.length + 1,
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload,
    });
  });
  await progress.phaseActivityChanged?.({
    turnId: "turn-complete-public-text",
    semanticState: "admitted",
    activityId: "guided-activity:complete-public-text",
    displayStage: "execution",
    title: "전체 진행 내용 표시",
    summary: longSummary,
    rationale: longRationale,
    nextStep: longNextStep,
  });

  const sharedRow = progressRowFromSharedTurnEvent(events[0]!);
  if (!sharedRow) throw new Error("Expected a shared progress row.");
  const normalized = normalizeProgressSummaryRow(sharedRow);
  const projected = projectTurnActivity([normalized]);
  expect(projected.phaseActivities[0]).toMatchObject({
    summary: longSummary,
    rationale: longRationale,
    nextStep: longNextStep,
  });

  const transportRow = progressRowFromAppOutbound(
    "app-long-public-text",
    { text: "" },
    {
      kind: "tool_progress",
      activityKind: "message",
      state: "running",
      safeLabel: "전체 진행 내용 표시",
      decisionTitle: "전체 진행 내용 표시",
      decisionSummary: longSummary,
      decisionRationale: longRationale,
      decisionNextStep: longNextStep,
      decisionSource: "model-authored",
    },
    "2026-08-03T15:30:00.000Z",
  );
  if (!transportRow) throw new Error("Expected an App transport row.");
  expect(normalizeProgressSummaryRow(transportRow)).toMatchObject({
    work_decision_summary: longSummary,
    work_decision_rationale: longRationale,
    work_decision_next_step: longNextStep,
  });
});

test("progressive dispatch activity adopts the effective tool title and summary", async () => {
  const updates: Array<{ title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-progressive-project-ledger",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const args = {
    id: "native:project_ledger_create",
    arguments: { kind: "spec", id: "SPEC-EXAMPLE" },
  };

  projection.observeToolBatch({
    text: "",
    toolCalls: [{ name: "tool_call", args }],
  });
  await projection.observeTool({
    name: "tool_call",
    effectiveToolName: "project_ledger_create",
    args,
  });

  expect(updates).toEqual([expect.objectContaining({
    title: "프로젝트 기록 변경",
    summary: "프로젝트 기록을 변경하고 있습니다.",
  })]);
});

test("consecutive empty batches with the same ordinary purpose reuse one activity", async () => {
  const updates: Array<{ activityId?: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-reused-command-activity",
    managedInitially: true,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const bindings = [];
  const summary = "실행: 상태 확인";
  for (const command of ["pwd", "git status", "git diff"]) {
    const call = { name: "run_command", args: { command, summary } };
    projection.observeToolBatch({ text: "", toolCalls: [call] });
    bindings.push(await projection.observeTool({
      ...call,
      effectiveToolName: call.name,
    }));
  }

  expect(updates).toHaveLength(1);
  expect(new Set(bindings.map((binding) => binding.activityId)).size).toBe(1);
  expect(updates[0]).toMatchObject({
    title: summary,
    summary,
  });
});

test("long Plan objectives remain in detail while every title stays within 32 characters", async () => {
  const objective = "사용자의 긴 목표와 검증 기준을 빠짐없이 보존하면서 실제 제품 경로를 끝까지 검증합니다.";
  const updates: Array<{ title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: "turn-long-plan",
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  const args = {
    objective,
    actions: [{ action_key: "verify", description: "제품 경로를 검증합니다." }],
    checks: ["실제 결과를 확인합니다."],
  };
  projection.observeToolBatch({
    text: "목표를 확인했습니다.",
    toolCalls: [{ name: "replace_work_plan", args }],
  });
  const binding = await projection.observeTool({
    name: "replace_work_plan",
    effectiveToolName: "replace_work_plan",
    args,
  });
  await projection.publishAccepted(binding);

  expect(updates[1]?.summary).toBe(objective);
  expect(updates.every((update) => [...update.title].length <= 32)).toBe(true);
  expect(updates.every((update) => update.title !== update.summary)).toBe(true);
});

test("final delivery has no activity API that can duplicate the answer body", () => {
  const projection = createGuidedActivityProjection({
    turnId: "turn-final-delivery",
    managedInitially: true,
  });

  expect(projection).not.toHaveProperty("publishFinal");
});

test("Review subjects project their entered Review or Validation activity", async () => {
  expect(await acceptedActivity("record_work_review", {
    subject: "plan",
    verdict: "accept",
    summary: "계획을 검토했습니다.",
  })).toEqual(expect.objectContaining({
    displayStage: "review",
    title: "계획 검토",
  }));
  expect(await acceptedActivity("record_work_review", {
    subject: "result",
    verdict: "accept",
    summary: "실행 결과를 검토했습니다.",
  })).toEqual(expect.objectContaining({
    displayStage: "review",
    title: "결과 검토",
  }));
  expect(await acceptedActivity("record_work_review", {
    subject: "completion",
    verdict: "accept",
    summary: "전체 완료 조건을 확인합니다.",
  })).toEqual(expect.objectContaining({
    displayStage: "validation",
    summary: "전체 완료 조건을 확인합니다.",
  }));
});

async function acceptedActivity(
  name: string,
  args: Record<string, unknown>,
): Promise<{ displayStage?: string; title: string; summary: string }> {
  const updates: Array<{ displayStage?: string; title: string; summary: string }> = [];
  const projection = createGuidedActivityProjection({
    turnId: `turn-${name}-${String(args.subject ?? name)}`,
    progress: {
      stateChanged() {},
      phaseActivityChanged(update) {
        updates.push(update);
      },
    },
  });
  projection.observeToolBatch({ text: "", toolCalls: [{ name, args }] });
  const binding = await projection.observeTool({
    name,
    effectiveToolName: name,
    args,
  });
  await projection.publishAccepted(binding);
  const update = updates[0];
  if (!update) throw new Error("Expected an accepted activity update.");
  return update;
}

function expectNoUndefinedValues(value: unknown): void {
  expect(value).not.toBeUndefined();
  if (Array.isArray(value)) {
    for (const item of value) expectNoUndefinedValues(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      expectNoUndefinedValues(nested);
    }
  }
}
