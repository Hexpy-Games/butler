import { expect, test } from "bun:test";
import type { SharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { progressRowFromSharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { projectTurnProgressToEvents as projectTurnProgress } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { createGuidedActivityProjection } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { normalizeProgressSummaryRow } from
  "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-normalizer.ts";
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
    text: "전체 완료 조건을 다시 확인했습니다.",
    toolCalls: [{
      name: "record_work_review",
      args: {
        subject: "completion",
        verdict: "accept",
        summary: "원 요청, 계획, 검사 결과와 실제 산출물이 모두 일치합니다.",
        next_stage: "reporting",
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
      next_stage: "reporting",
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

test("ordinary empty tool batches group repeated run_command purposes once", async () => {
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
  const summary = "작업공간의 현재 변경 상태를 확인합니다.";
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
    title: "명령 실행",
    summary,
  })]);
  expect(updates[0]?.title).not.toBe(updates[0]?.summary);
});

test("different run_command purposes are not coalesced into one activity", async () => {
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
      args: { command: "git status --short", summary: "작업공간 변경 상태를 확인합니다." },
    },
    {
      name: "run_command",
      args: { command: "git diff --check", summary: "변경 내용의 공백 오류를 검증합니다." },
    },
  ];
  projection.observeToolBatch({ text: "", toolCalls: calls });
  for (const call of calls) {
    await projection.observeTool({ ...call, effectiveToolName: call.name });
  }

  expect(updates).toEqual([
    expect.objectContaining({
      title: "명령 실행",
      summary: "작업공간 변경 상태를 확인합니다.",
    }),
    expect.objectContaining({
      title: "명령 실행",
      summary: "변경 내용의 공백 오류를 검증합니다.",
    }),
  ]);
  expect(updates[0]?.activityId).not.toBe(updates[1]?.activityId);
  expect(updates[0]?.title).not.toBe(updates[0]?.summary);
  expect(updates[1]?.title).not.toBe(updates[1]?.summary);
  expect(updates[0]?.summary).not.toBe(updates[1]?.summary);
});

test("progressive run_command projects its nested summary and keeps full-summary groups distinct", async () => {
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
  const prefix = "x".repeat(140);
  const first = {
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: { command: "pwd", summary: `${prefix}A` },
    },
  };
  const second = {
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: { command: "pwd", summary: `${prefix}B` },
    },
  };
  for (const call of [first, second]) {
    projection.observeToolBatch({ text: "", toolCalls: [call] });
    await projection.observeTool({
      ...call,
      effectiveToolName: "run_command",
    });
  }

  expect(updates).toHaveLength(2);
  expect(updates[0]?.summary).toBe(prefix);
  expect(updates[1]?.summary).toBe(prefix);
  expect(updates[0]?.activityId).not.toBe(updates[1]?.activityId);
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
  const summary = "작업공간의 현재 상태를 확인합니다.";
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
    title: "명령 실행",
    summary,
  });
  expect(updates[0]?.title).not.toBe(updates[0]?.summary);
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

test("an open Work final message stays partial while validated completion reports", async () => {
  const updates: Array<{
    displayStage?: string;
    title: string;
    summary: string;
  }> = [];
  const progress = {
    stateChanged() {},
    phaseActivityChanged(update: (typeof updates)[number]) {
      updates.push(update);
    },
  };
  await createGuidedActivityProjection({
    turnId: "turn-open-final",
    managedInitially: true,
    progress,
  }).publishFinal("시간 안에 확인한 사실만 안내합니다.", {
    managed: true,
    completed: false,
    completionValidated: false,
    currentStage: "execution",
  });
  await createGuidedActivityProjection({
    turnId: "turn-open-reporting-final",
    managedInitially: true,
    progress,
  }).publishFinal("보고 단계지만 완료 검증은 아직 없습니다.", {
    managed: true,
    completed: false,
    completionValidated: false,
    currentStage: "reporting",
  });
  await createGuidedActivityProjection({
    turnId: "turn-completed-final",
    managedInitially: true,
    progress,
  }).publishFinal("모든 완료 조건을 확인했습니다.", {
    managed: true,
    completed: true,
    completionValidated: true,
    currentStage: "reporting",
  });

  expect(updates).toEqual([
    expect.objectContaining({
      displayStage: "execution",
      title: "부분 결과 안내",
    }),
    expect.objectContaining({
      displayStage: "reporting",
      title: "부분 결과 안내",
    }),
    expect.objectContaining({
      displayStage: "reporting",
      title: "결과 보고",
    }),
  ]);
});

test("Plan and result subjects stay in Review while a checkpoint can display Validation", async () => {
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
  expect(await acceptedActivity("record_work_checkpoint", {
    next_stage: "validation",
    public_summary: "전체 완료 조건을 확인합니다.",
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
    turnId: `turn-${name}-${String(args.subject ?? args.next_stage)}`,
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
