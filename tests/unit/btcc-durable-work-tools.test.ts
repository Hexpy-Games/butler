import { expect, test } from "bun:test";
import {
  WorkStageTransitionError,
  type DurableWorkContext,
  type DurableWorkService,
  type DurableWorkView,
  type RecordWorkCheckpointInput,
  type ReplaceWorkPlanInput,
} from "../../packages/butler-agent/src/agent/btcc/durable-work/index.ts";
import {
  DURABLE_WORK_TOOL_DEFINITIONS,
  executeDurableWorkTool,
  renderDurableWorkContext,
} from "../../packages/butler-agent/src/agent/composition/production-btcc/durable-work-tools.ts";

test("R3 Work exposes only three compact optional control tools", () => {
  expect(DURABLE_WORK_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
  ]);
  expect(DURABLE_WORK_TOOL_DEFINITIONS[0]?.description)
    .toContain("multi-source or multi-step research");
  expect(DURABLE_WORK_TOOL_DEFINITIONS[0]?.description)
    .toContain("once this Turn continues it, keep the same Work");
  expect(DURABLE_WORK_TOOL_DEFINITIONS[0]?.description)
    .toContain("overall multi-Turn user outcome");
  expect(JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS[1]))
    .toContain("next_stage");
  expect(JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS[1]))
    .toContain("action_updates");
  expect(DURABLE_WORK_TOOL_DEFINITIONS[1]?.description)
    .toContain("when no Review is being recorded");
  expect(JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS[2]))
    .toContain("next_stage");
  expect(JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS[2]))
    .toContain("action_updates");
  expect(JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS[2]))
    .toContain('"enum":["planning","execution","reporting"]');
  expect(DURABLE_WORK_TOOL_DEFINITIONS[2]?.description)
    .toContain("The call enters review");
  expect(DURABLE_WORK_TOOL_DEFINITIONS[2]?.description)
    .toContain("does not judge the Review's meaning");
  expect(JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS[2]?.parameters))
    .toContain("The legal stage to enter after the Review");
  for (const tool of DURABLE_WORK_TOOL_DEFINITIONS) {
    expect(tool.concurrencySafe).not.toBe(true);
  }
  expect(DURABLE_WORK_TOOL_DEFINITIONS[2]?.description)
    .toContain("Judge against the original user request");
  expect(DURABLE_WORK_TOOL_DEFINITIONS[2]?.description)
    .toContain("disclosed non-critical limits may still be accepted");
  expect(DURABLE_WORK_TOOL_DEFINITIONS[2]?.description)
    .toContain("a material requested outcome remains unfinished");
  const encoded = JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS);
  expect(encoded).not.toContain("revision_id");
  expect(encoded).not.toContain("result_id");
  expect(encoded).not.toContain("checkpoint_id");
  expect(encoded).not.toContain("hash");
});

test("R3 Work tool maps semantic model input and returns validation as ordinary feedback", async () => {
  let received: ReplaceWorkPlanInput | null = null;
  let progressReceived: RecordWorkCheckpointInput | null = null;
  let reviewReceived: Parameters<DurableWorkService["recordReview"]>[0] | null = null;
  const service = fakeService({
    replacePlan(input) {
      received = input;
      return Promise.resolve(workView());
    },
    recordCheckpoint(input) {
      progressReceived = input;
      return Promise.resolve(workView());
    },
    recordReview(input) {
      reviewReceived = input;
      return Promise.resolve(workView());
    },
  });
  const scope = { turnId: "turn-1", sessionId: "session-1" };

  const accepted = await executeDurableWorkTool({
    service,
    scope,
    mutationCallId: "call-1",
    name: "replace_work_plan",
    args: {
      objective: "Create the requested report",
      actions: [{
        action_key: "research",
        description: "Collect current evidence",
        dependency_keys: [],
      }, {
        action_key: "write",
        description: "Write and verify the report",
        dependency_keys: ["research"],
        effect: { capability: "workspace.file", target: "report.md" },
      }],
      checks: ["Report exists", "Sources are present"],
    },
  });

  expect(accepted).toEqual({
    ok: true,
    work: {
      work_id: "work-1",
      status: "open",
      current_stage: "planning",
      allowed_next_stages: ["review"],
      actions: [{ action_key: "research", status: "pending" }],
      unresolved_action_keys: ["research"],
      completion_blockers: [
        "current_plan_review_required",
        "unresolved_actions",
      ],
      latest_plan_review: null,
      latest_result_review: null,
    },
  });
  expect(received).toMatchObject({
    turnId: "turn-1",
    sessionId: "session-1",
    mutationCallId: "call-1",
    startNew: false,
    actions: [{ actionKey: "research" }, { actionKey: "write" }],
  });

  const progress = await executeDurableWorkTool({
    service,
    scope,
    mutationCallId: "call-progress",
    name: "record_work_checkpoint",
    args: {
      next_stage: "review",
      action_updates: [{
        action_key: "research",
        status: "done",
        note: "Current evidence was collected.",
      }],
    },
  });
  expect(progress).toMatchObject({ ok: true });
  expect(progressReceived).toMatchObject({
    nextStage: "review",
    actionUpdates: [{
      actionKey: "research",
      status: "done",
      note: "Current evidence was collected.",
    }],
  });

  const acceptedWithoutDuplicatedDescription = await executeDurableWorkTool({
    service,
    scope,
    mutationCallId: "call-plan-with-semantic-key-only",
    name: "replace_work_plan",
    args: {
      objective: "Create the requested report",
      actions: [{ action_key: "research_sources" }],
    },
  });
  expect(acceptedWithoutDuplicatedDescription).toMatchObject({ ok: true });
  expect(received).toMatchObject({
    actions: [{
      actionKey: "research_sources",
      description: "research_sources",
    }],
  });

  const review = await executeDurableWorkTool({
    service,
    scope,
    mutationCallId: "call-review",
    name: "record_work_review",
    args: {
      subject: "result",
      verdict: "accept",
      next_stage: "reporting",
      action_updates: [{
        action_key: "research",
        status: "done",
        note: "The requested evidence is present.",
      }],
      summary: "The requested result is complete.",
    },
  });
  expect(review).toMatchObject({ ok: true });
  expect(reviewReceived).toMatchObject({
    mutationCallId: "call-review",
    subject: "result",
    verdict: "accept",
    nextStage: "reporting",
    actionUpdates: [{
      actionKey: "research",
      status: "done",
      note: "The requested evidence is present.",
    }],
  });

  const rejected = await executeDurableWorkTool({
    service,
    scope,
    mutationCallId: "call-2",
    name: "record_work_review",
    args: { subject: "result", verdict: "perfect", summary: "Looks good" },
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: "work_update_rejected" },
  });
});

test("R3 Work tool results do not repeat anchored Plan detail", async () => {
  const view = workView();
  view.objective = "REPEATED_STABLE_OBJECTIVE";
  view.currentPlan = {
    ...view.currentPlan!,
    objective: "REPEATED_PLAN_OBJECTIVE",
    governingRefs: ["REPEATED_GOVERNING_REFERENCE"],
    checks: ["REPEATED_PLAN_CHECK"],
    actions: [{
      actionKey: "research",
      description: "REPEATED_ACTION_DESCRIPTION",
      dependencyKeys: ["REPEATED_DEPENDENCY"],
      effect: {
        capability: "REPEATED_EFFECT_CAPABILITY",
        target: "REPEATED_EFFECT_TARGET",
      },
    }],
  };
  view.actionProgress = [{
    actionKey: "research",
    status: "active",
    note: "REPEATED_PROGRESS_NOTE",
  }];
  const result = await executeDurableWorkTool({
    service: fakeService({ replacePlan: async () => view }),
    scope: { turnId: "turn-1", sessionId: "session-1" },
    mutationCallId: "compact-result",
    name: "replace_work_plan",
    args: {
      objective: "Create the requested report",
      actions: [{ action_key: "research" }],
    },
  });

  expect(result).toEqual({
    ok: true,
    work: {
      work_id: "work-1",
      status: "open",
      current_stage: "planning",
      allowed_next_stages: ["review"],
      actions: [{ action_key: "research", status: "active" }],
      unresolved_action_keys: ["research"],
      completion_blockers: [
        "current_plan_review_required",
        "unresolved_actions",
      ],
      latest_plan_review: null,
      latest_result_review: null,
    },
  });
  const encoded = JSON.stringify(result);
  expect(encoded).not.toContain("REPEATED_");
  expect(Buffer.byteLength(encoded)).toBeLessThan(600);
});

test("R3 Work transition rejection returns the allowed next stage as ordinary feedback", async () => {
  const current = workView();
  const service = fakeService({
    loadContext: async () => ({
      work: current,
      originalRequest: {
        turnId: "turn-origin",
        messageId: "message-origin",
        content: "Create the requested report",
      },
      resultFacts: [],
    }),
    recordCheckpoint: async () => {
      throw new WorkStageTransitionError("planning", "reporting", ["review"]);
    },
  });

  const result = await executeDurableWorkTool({
    service,
    scope: { turnId: "turn-1", sessionId: "session-1" },
    mutationCallId: "invalid-transition",
    name: "record_work_checkpoint",
    args: { next_stage: "reporting" },
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "invalid_work_stage_transition",
      current_stage: "planning",
      attempted_stage: "reporting",
      allowed_next_stages: ["review"],
    },
    work: {
      status: "open",
      current_stage: "planning",
      allowed_next_stages: ["review"],
      unresolved_action_keys: ["research"],
    },
  });
  expect(current.currentStage).toBe("planning");
  expect(current.actionProgress).toEqual([{
    actionKey: "research",
    status: "pending",
  }]);
});

test("R3 generic Work rejection returns the current guardrail view", async () => {
  const current = workView();
  current.objective = "REPEATED_ERROR_OBJECTIVE";
  current.currentPlan = {
    ...current.currentPlan!,
    governingRefs: ["REPEATED_ERROR_REFERENCE"],
    checks: ["REPEATED_ERROR_CHECK"],
  };
  const service = fakeService({
    loadContext: async () => ({
      work: current,
      originalRequest: {
        turnId: "turn-origin",
        messageId: "message-origin",
        content: "Create the requested report",
      },
      resultFacts: [],
    }),
    replacePlan: async () => {
      throw new Error(
        "Durable Work continuation is already committed for this Turn",
      );
    },
  });

  const result = await executeDurableWorkTool({
    service,
    scope: { turnId: "turn-1", sessionId: "session-1" },
    mutationCallId: "contradictory-start-new",
    name: "replace_work_plan",
    args: {
      start_new: true,
      objective: "Start unrelated Work",
      actions: [{ action_key: "restart" }],
    },
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "work_update_rejected",
      message: expect.stringContaining("continuation is already committed"),
    },
    work: {
      work_id: "work-1",
      current_stage: "planning",
      allowed_next_stages: ["review"],
      actions: [{ action_key: "research", status: "pending" }],
      unresolved_action_keys: ["research"],
    },
  });
  expect(JSON.stringify(result)).not.toContain("REPEATED_ERROR_");
});

test("R3 continuation context stays concise and semantic", () => {
  const context: DurableWorkContext = {
    work: {
      ...workView(),
      latestPlanReview: {
        reviewRevisionId: "plan-review-1",
        revision: 1,
        subject: "plan",
        verdict: "revise",
        summary: "The source plan needs one correction.",
        corrections: ["Add a second independent source."],
        boundPlanRevisionId: "plan-revision-1",
        boundResultRefs: [],
        originTurnId: "turn-origin",
        createdAt: "2026-07-31T00:00:00.000Z",
      },
      latestResultReview: {
        reviewRevisionId: "result-review-1",
        revision: 2,
        subject: "result",
        verdict: "partial",
        summary: "The artifact still needs verification.",
        corrections: ["Read report.md back before reporting."],
        boundResultRefs: [],
        originTurnId: "turn-origin",
        createdAt: "2026-07-31T00:00:00.000Z",
      },
    },
    originalRequest: {
      turnId: "turn-origin",
      messageId: "message-origin",
      content: "Research the market and create report.md",
    },
    resultFacts: [{
      toolName: "write_file",
      status: "completed",
      resultJson: { ok: true, path: "report.md" },
    }],
  };

  const rendered = renderDurableWorkContext(context) ?? "";
  expect(rendered).toContain("Original request (highest priority): Research the market");
  expect(rendered).toContain("Current stage: planning");
  expect(rendered).toContain("Allowed next stages: review");
  expect(rendered).toContain("Governing references: SPEC-REPORT");
  expect(rendered).toContain("- [pending] research: Collect evidence");
  expect(rendered).toContain("Current plan details:");
  expect(rendered).toContain("Result (write_file, completed)");
  expect(rendered).toContain("Plan corrections: Add a second independent source.");
  expect(rendered).toContain("Result corrections: Read report.md back before reporting.");
  expect(rendered).not.toContain("work-1");
  expect(rendered).not.toContain("plan-revision-1");
  expect(rendered.length).toBeLessThanOrEqual(8_000);
});

test("R3 continuation context reuses the bounded web model projection", () => {
  const repeatedBody = `${"source opening ".repeat(80)}LATE_SOURCE_FACT${
    " source ending".repeat(80)
  }`;
  const context: DurableWorkContext = {
    work: workView(),
    originalRequest: {
      turnId: "turn-origin",
      messageId: "message-origin",
      content: "Research the source and continue later",
    },
    resultFacts: [{
      toolName: "web_read",
      status: "completed",
      resultJson: {
        ok: true,
        source_url: "https://example.com/report",
        markdown: repeatedBody,
        chunks: [{ content: "RAW_CHUNK_MUST_NOT_REPLAY" }],
        public_web_evidence_items: [{
          evidence_item_id: "evidence-1",
          source_url: "https://example.com/report",
          source_identity: "example.com",
          content_kind: "page_chunk",
          bounded_content: repeatedBody.slice(0, 400),
          limitations: [],
        }],
      },
    }],
  };

  const rendered = renderDurableWorkContext(context) ?? "";
  expect(rendered).toContain("LATE_SOURCE_FACT");
  expect(rendered).not.toContain("RAW_CHUNK_MUST_NOT_REPLAY");
  expect(rendered.match(/LATE_SOURCE_FACT/g)?.length).toBe(1);
  expect(rendered.length).toBeLessThanOrEqual(8_000);
});

test("R3 context keeps every normal-sized unresolved action ahead of verbose details", () => {
  const base = workView();
  const actions = Array.from({ length: 20 }, (_, index) => ({
    actionKey: `action-${index + 1}`,
    description: `Action ${index + 1} ${"verbose detail ".repeat(30)}`,
    dependencyKeys: index === 0 ? [] : [`action-${index}`],
  }));
  const context: DurableWorkContext = {
    work: {
      ...base,
      actionProgress: actions.map((action, index) => ({
        actionKey: action.actionKey,
        status: index < 5 ? "done" : "pending",
      })),
      currentPlan: {
        ...base.currentPlan!,
        actions,
        checks: Array.from({ length: 10 }, (_, index) =>
          `Check ${index + 1} ${"detailed criterion ".repeat(20)}`),
      },
      effectBlockers: [{
        blockerId: "blocker-context",
        sourceTurnId: "turn-origin",
        capability: "publish",
        target: "remote:report",
        detail: "A prior publication must be reconciled before another attempt.",
        createdAt: "2026-08-02T00:00:00.000Z",
      }],
    },
    originalRequest: {
      turnId: "turn-origin",
      messageId: "message-origin",
      content: `Create the requested report ${"with original detail ".repeat(80)}`,
    },
    resultFacts: Array.from({ length: 8 }, (_, index) => ({
      toolName: "read_file",
      status: "completed" as const,
      resultJson: { index, content: "result detail ".repeat(100) },
    })),
  };

  const rendered = renderDurableWorkContext(context) ?? "";
  for (let index = 6; index <= 20; index += 1) {
    expect(rendered).toContain(`action-${index}=pending`);
  }
  expect(rendered).toContain("Unresolved prior effect (publish -> remote:report)");
  expect(rendered).toContain("Guardrail: choose the next useful unresolved action");
  expect(rendered.length).toBeLessThanOrEqual(8_000);
});

function fakeService(
  overrides: Partial<DurableWorkService>,
): DurableWorkService {
  return {
    loadContext: async () => null,
    importOpenLegacyWork: async () => null,
    bindOpenWork: async () => null,
    replacePlan: async () => workView(),
    recordCheckpoint: async () => workView(),
    recordReview: async () => workView(),
    attachToolResult: async () => workView(),
    boundWorkForTurn: async () => null,
    ...overrides,
  };
}

function workView(): DurableWorkView {
  return {
    workId: "work-1",
    sessionId: "session-1",
    scope: { kind: "session", sessionId: "session-1" },
    origin: { turnId: "turn-origin", messageId: "message-origin" },
    objective: "Create the requested report",
    status: "open",
    currentStage: "planning",
    allowedNextStages: ["review"],
    actionProgress: [{ actionKey: "research", status: "pending" }],
    currentPlan: {
      planRevisionId: "plan-revision-1",
      revision: 1,
      objective: "Create the requested report",
      governingRefs: ["SPEC-REPORT"],
      actions: [{
        actionKey: "research",
        description: "Collect evidence",
        dependencyKeys: [],
      }],
      checks: ["Report exists"],
      originTurnId: "turn-origin",
      createdAt: "2026-07-31T00:00:00.000Z",
    },
    resultRefs: [],
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}
