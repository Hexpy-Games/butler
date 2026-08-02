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
      title: "작업 구상",
      summary: "두 입력을 비교해 검증된 보고서를 만듭니다.",
    }),
    expect.objectContaining({
      displayStage: "planning",
      summary: "두 입력을 비교해 검증된 보고서를 만듭니다.",
      nextStep: "두 입력을 확인하고 공통점을 비교합니다.",
    }),
  ]);
  expect(updates[0]?.activityId).toBeDefined();
  expect(updates[1]?.activityId).toBeDefined();
  expect(updates[0]?.activityId).not.toBe(updates[1]?.activityId);
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
