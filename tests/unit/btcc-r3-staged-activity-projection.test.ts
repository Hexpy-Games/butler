import { expect, test } from "bun:test";
import type { SharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { progressRowFromSharedTurnEvent } from
  "../../packages/butler-progress-projection/src/index.ts";
import { projectTurnProgress } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/project-turn-progress.ts";
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
