import { expect, test } from "bun:test";
import type { DurableWorkContext } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import {
  isDurableWorkCompletionValidationCurrent,
  renderDurableWorkContext,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-context.ts";
import { guidedOperationalFallback } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-facts.ts";

test("Managed continuation distinguishes result Review from current completion Validation", () => {
  const context = validationContext();
  const rendered = renderDurableWorkContext(context) ?? "";

  expect(isDurableWorkCompletionValidationCurrent(context.work)).toBe(true);
  expect(rendered).toContain("Current stage: validation");
  expect(rendered).toContain("Allowed next stages: reporting");
  expect(rendered).toContain("Optional stage focus: validate the whole Work");
  expect(rendered).not.toContain("Required stage focus:");
  expect(rendered).toContain("Latest result review: accept — The artifact passed its checks.");
  expect(rendered).toContain(
    "Latest completion validation: accept — The whole Work satisfies the original request.",
  );
  expect(rendered).toContain("Use optional Reviews or Validation when they help");

  const fallback = guidedOperationalFallback({
    originalRequest: context.originalRequest.content,
    work: context,
    toolCalls: [],
    effects: [],
  });
  expect(fallback).toContain("답변 생성을 마치지 못했습니다");
  expect(fallback).toContain("The whole Work satisfies the original request.");
  expect(fallback).not.toContain("Saved completion validation");
});

test("completion Validation is marked outdated when later results change its binding", () => {
  const context = validationContext();
  context.work.resultRefs.push({
    resultRef: "result-2",
    toolCallId: "tool-2",
    toolName: "read_file",
    status: "completed",
    originTurnId: "turn-origin",
    attachedAt: "2026-08-02T01:04:00.000Z",
  });

  expect(isDurableWorkCompletionValidationCurrent(context.work)).toBe(false);
  expect(renderDurableWorkContext(context)).toContain(
    "Latest completion validation (outdated): accept",
  );
});

test("completion Validation is marked outdated when later action progress changes", () => {
  const context = validationContext();
  context.work.actionProgress = [{
    actionKey: "write-report",
    status: "blocked",
    note: "The artifact changed after Validation.",
  }];

  expect(isDurableWorkCompletionValidationCurrent(context.work)).toBe(false);
  expect(renderDurableWorkContext(context)).toContain(
    "Latest completion validation (outdated): accept",
  );
});

function validationContext(): DurableWorkContext {
  return {
    work: {
      workId: "work-1",
      sessionId: "session-1",
      scope: { kind: "session", sessionId: "session-1" },
      origin: { turnId: "turn-origin", messageId: "message-origin" },
      objective: "Create and verify the requested report",
      status: "open",
      currentStage: "validation",
      allowedNextStages: ["reporting"],
      currentPlan: {
        planRevisionId: "plan-1",
        revision: 1,
        objective: "Create and verify the requested report",
        governingRefs: ["SPEC-REPORT"],
        actions: [{
          actionKey: "write-report",
          description: "Create and check report.md",
          dependencyKeys: [],
        }],
        checks: ["report.md contains the requested analysis"],
        originTurnId: "turn-origin",
        createdAt: "2026-08-02T01:00:00.000Z",
      },
      actionProgress: [{ actionKey: "write-report", status: "done" }],
      latestResultReview: {
        reviewRevisionId: "result-review-1",
        revision: 1,
        subject: "result",
        verdict: "accept",
        summary: "The artifact passed its checks.",
        corrections: [],
        boundPlanRevisionId: "plan-1",
        boundResultRefs: ["result-1"],
        originTurnId: "turn-origin",
        createdAt: "2026-08-02T01:02:00.000Z",
      },
      latestCompletionValidation: {
        reviewRevisionId: "completion-validation-1",
        revision: 2,
        subject: "completion",
        verdict: "accept",
        summary: "The whole Work satisfies the original request.",
        corrections: [],
        boundPlanRevisionId: "plan-1",
        boundResultRefs: ["result-1"],
        boundResultReviewRevisionId: "result-review-1",
        boundActionProgress: [{ actionKey: "write-report", status: "done" }],
        originTurnId: "turn-origin",
        createdAt: "2026-08-02T01:03:00.000Z",
      },
      resultRefs: [{
        resultRef: "result-1",
        toolCallId: "tool-1",
        toolName: "write_file",
        status: "completed",
        originTurnId: "turn-origin",
        attachedAt: "2026-08-02T01:01:00.000Z",
      }],
      createdAt: "2026-08-02T01:00:00.000Z",
      updatedAt: "2026-08-02T01:03:00.000Z",
    },
    originalRequest: {
      turnId: "turn-origin",
      messageId: "message-origin",
      content: "요청한 분석 보고서를 만들고 검증해줘",
    },
    resultFacts: [{
      toolName: "write_file",
      status: "completed",
      resultJson: { ok: true, path: "report.md" },
    }],
  };
}
