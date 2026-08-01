import { expect, test } from "bun:test";
import type {
  DurableWorkContext,
  DurableWorkService,
  DurableWorkView,
  ReplaceWorkPlanInput,
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
  const service = fakeService({
    replacePlan(input) {
      received = input;
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

  expect(accepted).toMatchObject({
    ok: true,
    work: { status: "open", plan_revision: 1 },
  });
  expect(received).toMatchObject({
    turnId: "turn-1",
    sessionId: "session-1",
    mutationCallId: "call-1",
    startNew: false,
    actions: [{ actionKey: "research" }, { actionKey: "write" }],
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
  expect(rendered).toContain("Original request: Research the market");
  expect(rendered).toContain("Current plan:");
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
    currentPlan: {
      planRevisionId: "plan-revision-1",
      revision: 1,
      objective: "Create the requested report",
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
