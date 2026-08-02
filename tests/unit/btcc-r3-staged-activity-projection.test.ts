import { expect, test } from "bun:test";
import type { SharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { progressRowFromSharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { projectTurnProgress } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/project-turn-progress.ts";
import { createGuidedActivityProjection } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-activity-projection.ts";
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

test("ordinary empty tool batches group repeated public labels once", async () => {
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
  const calls = [
    { name: "run_command", args: { command: "pwd" } },
    { name: "run_command", args: { command: "git status" } },
    { name: "run_command", args: { command: "git diff" } },
  ];
  projection.observeToolBatch({ text: "", toolCalls: calls });
  for (const call of calls) {
    await projection.observeTool({ ...call, effectiveToolName: call.name });
  }

  expect(updates).toEqual([expect.objectContaining({
    title: "명령 실행",
    summary: "작업 공간에서 필요한 명령을 실행하고 있습니다.",
  })]);
  expect(updates[0]!.title).not.toBe(updates[0]!.summary);
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
  for (const command of ["pwd", "git status", "git diff"]) {
    const call = { name: "run_command", args: { command } };
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
    summary: "작업 공간에서 필요한 명령을 실행하고 있습니다.",
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
