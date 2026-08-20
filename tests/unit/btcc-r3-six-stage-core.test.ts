import { expect, test } from "bun:test";
import {
  allowedNextWorkStages,
  acceptedCurrentResultReview,
  createDurableWorkService,
  resolveWorkReviewTransition,
  type DurableWorkContext,
  type DurableWorkReview,
  type DurableWorkStore,
  type DurableWorkView,
  type RecordWorkReviewCommand,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";

test("semantic Review judgments deterministically traverse the fixed graph", () => {
  expect(resolveWorkReviewTransition({
    currentStage: "planning",
    subject: "plan",
    verdict: "accept",
  })).toEqual({ entryStage: "review", nextStage: "execution" });
  expect(resolveWorkReviewTransition({
    currentStage: "planning",
    subject: "plan",
    verdict: "revise",
  })).toEqual({ entryStage: "review", nextStage: "planning" });
  expect(resolveWorkReviewTransition({
    currentStage: "execution",
    subject: "result",
    verdict: "accept",
  })).toEqual({ entryStage: "review", nextStage: "validation" });
  expect(resolveWorkReviewTransition({
    currentStage: "execution",
    subject: "result",
    verdict: "partial",
    correctionScope: "planning",
  })).toEqual({ entryStage: "review", nextStage: "planning" });
  expect(resolveWorkReviewTransition({
    currentStage: "validation",
    subject: "completion",
    verdict: "accept",
  })).toEqual({ entryStage: "validation", nextStage: "reporting" });
  expect(resolveWorkReviewTransition({
    currentStage: "reporting",
    subject: "completion",
    verdict: "revise",
    correctionScope: "execution",
  })).toEqual({ entryStage: "validation", nextStage: "execution" });
  expect(() => resolveWorkReviewTransition({
    currentStage: "execution",
    subject: "result",
    verdict: "revise",
  })).toThrow(expect.objectContaining({
    code: "work_transition_guard_unmet",
    unmetGuard: "correction_scope_required",
    nextAction: "choose_planning_or_execution_correction",
  }));
});
import {
  DURABLE_WORK_TOOL_DEFINITIONS,
  executeDurableWorkTool,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tools.ts";

test("Managed Work exposes the fixed six-stage transition guide", () => {
  expect(allowedNextWorkStages()).toEqual(["conception"]);
  expect(allowedNextWorkStages("conception")).toEqual(["planning"]);
  expect(allowedNextWorkStages("planning")).toEqual(["review"]);
  expect(allowedNextWorkStages("execution")).toEqual(["review"]);
  expect(allowedNextWorkStages("review")).toEqual([
    "planning",
    "execution",
    "validation",
  ]);
  expect(allowedNextWorkStages("validation")).toEqual([
    "planning",
    "execution",
    "review",
    "reporting",
  ]);
  expect(allowedNextWorkStages("reporting")).toEqual(["validation"]);
});

test("Work exposes atomic disposition alongside optional Review", async () => {
  expect(DURABLE_WORK_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
    "start_work",
    "continue_work",
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
  ]);
  const review = DURABLE_WORK_TOOL_DEFINITIONS.find(({ name }) =>
    name === "record_work_review",
  );
  expect(JSON.stringify(review?.parameters)).toContain(
    '"enum":["plan","result","completion"]',
  );
  expect(JSON.stringify(review?.parameters)).not.toContain("next_stage");
  expect(JSON.stringify(review?.parameters)).toContain("correction_scope");

  let receivedSubject: string | undefined;
  const view = workView({ currentStage: "validation" });
  const result = await executeDurableWorkTool({
    service: fakeService({
      context: workContext(view),
      recordReview(input) {
        receivedSubject = input.subject;
        return Promise.resolve(view);
      },
    }),
    scope: { turnId: "turn-completion-tool", sessionId: view.sessionId },
    mutationCallId: "completion-tool-call",
    name: "record_work_review",
    args: {
      subject: "completion",
      verdict: "accept",
      summary: "The whole Work satisfies the original request.",
      corrections: [],
    },
  });

  expect(receivedSubject).toBe("completion");
  expect(result).toMatchObject({ ok: true });
});

test("result acceptance enters Review but cannot complete Work", async () => {
  let command: RecordWorkReviewCommand | undefined;
  const view = workView({
    currentStage: "execution",
    latestPlanReview: acceptedPlanReview(),
    actionProgress: [{ actionKey: "deliver", status: "done" }],
  });
  const service = createDurableWorkService(fakeStore({
    context: workContext(view),
    recordReview(input) {
      command = input;
      return Promise.resolve(view);
    },
  }));

  await service.recordReview({
    turnId: "turn-result-review",
    sessionId: view.sessionId,
    mutationCallId: "result-review-call",
    subject: "result",
    verdict: "accept",
    summary: "The actual result is correct.",
    corrections: [],
  });

  expect(command).toMatchObject({
    subject: "result",
    entryStage: "review",
    currentStage: "execution",
    nextStage: "validation",
  });
  expect(command?.expectedResultReviewRevisionId).toBeUndefined();
});

test("completion acceptance binds the current result Review without closing Work", async () => {
  let command: RecordWorkReviewCommand | undefined;
  const resultReview = acceptedResultReview(["result-1"]);
  const view = workView({
    currentStage: "validation",
    latestPlanReview: acceptedPlanReview(),
    latestResultReview: resultReview,
    actionProgress: [{ actionKey: "deliver", status: "done" }],
    resultRefs: [{
      resultRef: "result-1",
      toolCallId: "tool-1",
      toolName: "write_file",
      status: "completed",
      originTurnId: "turn-completion",
      attachedAt: "2026-08-02T00:00:00.000Z",
    }],
  });
  const service = createDurableWorkService(fakeStore({
    context: workContext(view),
    recordReview(input) {
      command = input;
      return Promise.resolve(view);
    },
  }));

  await service.recordReview({
    turnId: "turn-completion",
    sessionId: view.sessionId,
    mutationCallId: "completion-call",
    subject: "completion",
    verdict: "accept",
    summary: "The whole Work satisfies the original request and Plan.",
    corrections: [],
  });

  expect(command).toMatchObject({
    subject: "completion",
    entryStage: "validation",
    currentStage: "validation",
    expectedResultReviewRevisionId: resultReview.reviewRevisionId,
    nextStage: "reporting",
  });
});

test("completion acceptance stays open when the accepted result Review is stale", async () => {
  let command: RecordWorkReviewCommand | undefined;
  const view = workView({
    currentStage: "review",
    latestPlanReview: acceptedPlanReview(),
    latestResultReview: acceptedResultReview([]),
    actionProgress: [{ actionKey: "deliver", status: "done" }],
    resultRefs: [{
      resultRef: "new-result",
      toolCallId: "tool-new",
      toolName: "read_file",
      status: "completed",
      originTurnId: "turn-stale-completion",
      attachedAt: "2026-08-02T00:00:00.000Z",
    }],
  });
  const service = createDurableWorkService(fakeStore({
    context: workContext(view),
    recordReview(input) {
      command = input;
      return Promise.resolve(view);
    },
  }));

  await service.recordReview({
    turnId: "turn-stale-completion",
    sessionId: view.sessionId,
    mutationCallId: "stale-completion-call",
    subject: "completion",
    verdict: "accept",
    summary: "Attempt to validate after a newer result.",
    corrections: [],
  });

  expect(command).toMatchObject({
    entryStage: "validation",
  });
  expect(command?.expectedResultReviewRevisionId).toBeUndefined();
});

test("accepted result Review matches a unique current result-ref set regardless of order", () => {
  const result = (resultRef: string, index: number) => ({
    resultRef,
    toolCallId: `tool-${index}`,
    toolName: "read_file",
    status: "completed" as const,
    originTurnId: "turn-results",
    attachedAt: "2026-08-02T00:00:00.000Z",
  });
  const currentResults = [result("result-a", 1), result("result-b", 2)];
  const current = workView({
    latestResultReview: acceptedResultReview(["result-b", "result-a"]),
    resultRefs: currentResults,
  });

  expect(acceptedCurrentResultReview(current)?.reviewRevisionId)
    .toBe("result-review-current");
  expect(acceptedCurrentResultReview(workView({
    latestResultReview: acceptedResultReview(["result-a", "result-a"]),
    resultRefs: [result("result-a", 1), result("result-a", 2)],
  }))).toBeUndefined();
  expect(acceptedCurrentResultReview(workView({
    latestResultReview: acceptedResultReview(["result-a", "result-b"]),
    resultRefs: [result("result-a", 1), result("result-a", 2)],
  }))).toBeUndefined();
  expect(acceptedCurrentResultReview(workView({
    latestResultReview: acceptedResultReview(["result-a"]),
    resultRefs: currentResults,
  }))).toBeUndefined();
  expect(acceptedCurrentResultReview(workView({
    latestResultReview: acceptedResultReview(["result-a", "result-b", "result-c"]),
    resultRefs: currentResults,
  }))).toBeUndefined();
});

function fakeService(input: {
  context: DurableWorkContext;
  recordReview(
    input: Parameters<ReturnType<typeof createDurableWorkService>["recordReview"]>[0],
  ): Promise<DurableWorkView>;
}) {
  return createDurableWorkService(fakeStore(input));
}

function fakeStore(input: {
  context: DurableWorkContext;
  recordReview(input: RecordWorkReviewCommand): Promise<DurableWorkView>;
}): DurableWorkStore {
  return {
    loadContext: () => Promise.resolve(input.context),
    importOpenLegacyWork: () => Promise.resolve(null),
    bindOpenWork: () => Promise.resolve(input.context.work),
    startWork: () => Promise.resolve(input.context.work),
    continueWork: () => Promise.resolve(input.context.work),
    replacePlan: () => Promise.resolve(input.context.work),
    recordCheckpoint: () => Promise.resolve(input.context.work),
    recordReview: input.recordReview,
    recordDisposition: () => Promise.resolve(input.context.work),
    claimCloseoutCorrection: () => Promise.resolve(false),
    attachToolResult: () => Promise.resolve(input.context.work),
    boundWorkForTurn: () => Promise.resolve(input.context.work),
  };
}

function workContext(work: DurableWorkView): DurableWorkContext {
  return {
    work,
    originalRequest: {
      turnId: "turn-origin",
      messageId: "message-origin",
      content: "Produce and verify the requested deliverable.",
    },
    resultFacts: [],
  };
}

function workView(
  overrides: Partial<DurableWorkView> = {},
): DurableWorkView {
  return {
    workId: "work-six-stage",
    sessionId: "session-six-stage",
    scope: { kind: "session", sessionId: "session-six-stage" },
    origin: { turnId: "turn-origin", messageId: "message-origin" },
    objective: "Produce and verify the requested deliverable",
    status: "open",
    currentStage: "planning",
    allowedNextStages: ["review"],
    currentPlan: {
      planRevisionId: "plan-current",
      revision: 1,
      objective: "Produce and verify the requested deliverable",
      actions: [{
        actionKey: "deliver",
        description: "Produce the deliverable",
        dependencyKeys: [],
      }],
      checks: ["The deliverable satisfies the original request"],
      originTurnId: "turn-origin",
      createdAt: "2026-08-02T00:00:00.000Z",
    },
    actionProgress: [{ actionKey: "deliver", status: "pending" }],
    resultRefs: [],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function acceptedPlanReview(): DurableWorkReview {
  return {
    reviewRevisionId: "plan-review-current",
    revision: 1,
    subject: "plan",
    verdict: "accept",
    summary: "The current Plan is ready.",
    corrections: [],
    boundPlanRevisionId: "plan-current",
    boundResultRefs: [],
    originTurnId: "turn-origin",
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}

function acceptedResultReview(boundResultRefs: string[]): DurableWorkReview {
  return {
    reviewRevisionId: "result-review-current",
    revision: 2,
    subject: "result",
    verdict: "accept",
    summary: "The current result is ready.",
    corrections: [],
    boundResultRefs,
    originTurnId: "turn-origin",
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}
