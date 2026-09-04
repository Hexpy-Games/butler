import { expect, test } from "bun:test";
import { guidedPlanModeInstructions } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
import { projectLedgerPlanFromToolRecords } from
  "../../packages/butler-agent/src/agent/btcc/project-plan.ts";
import { renderAcceptedProjectPlanContext } from
  "../../packages/butler-agent/src/agent/btcc/project-plan.ts";
import { isAllowedProjectPlanMutation, projectPlanModeTools } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-project-plan-mode.ts";
import { guidedNativeToolDefinitions } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import { messageFromRow } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/message-read-model.ts";

test("projects one successful top-level Ledger Plan mutation", () => {
  const plan = projectLedgerPlanFromToolRecords([{
    callId: "call-plan",
    toolName: "project_ledger_create",
    rawArguments: "{}",
    arguments: { kind: "plan", title: "Plan mode", body: "# Plan" },
    status: "completed",
    result: {
      ok: true,
      data: {
        id: "PLAN-1",
        title: "Plan mode",
        status: "draft",
        body: "# Plan",
        path: "/private/project/plans/PLAN-1.md",
      },
    },
  }]);

  expect(plan).toEqual({
    kind: "plan",
    id: "PLAN-1",
    title: "Plan mode",
    status: "draft",
    body: "# Plan",
    path: "/private/project/plans/PLAN-1.md",
  });
});

test("message reads expose the Ledger Plan as a safe document", () => {
  const message = messageFromRow({
    rowid: 1,
    id: "message-1",
    chat_id: "session-1",
    turn_id: "turn-1",
    conversation_session_id: null,
    conversation_turn_id: null,
    conversation_message_id: null,
    role: "assistant",
    text: "계획을 작성했습니다.",
    status: "delivered",
    safe_error_code: null,
    retryable: 0,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:01:00.000Z",
    plan_json: JSON.stringify({
      kind: "plan",
      id: "PLAN-1",
      title: "Plan mode",
      status: "draft",
      body: "# Plan",
      path: "/private/project/plans/PLAN-1.md",
    }),
  });

  expect(message.plan_document).toEqual({
    id: "PLAN-1",
    kind: "plan",
    document_type: "plan",
    title: "Plan mode",
    status: "draft",
    safe_path_label: "plans/PLAN-1.md",
    markdown: "# Plan",
    updated_at: "2026-09-04T00:01:00.000Z",
  });
  expect(JSON.stringify(message)).not.toContain("/private/project");
});

test("a direct instruction stays bound to the same Ledger Plan", () => {
  const initial = guidedPlanModeInstructions();
  const continuation = guidedPlanModeInstructions("PLAN-1");

  expect(initial).toContain("create exactly one top-level Project Ledger record");
  expect(initial).toContain("status=draft");
  expect(initial).not.toContain("id=PLAN-1");
  expect(continuation).toContain("id=PLAN-1");
  expect(continuation).toContain("status=draft for a revision");
  expect(continuation).toContain("status=active only when the user's instruction clearly accepts execution");
  expect(continuation).toContain("project_ledger_update");
  expect(continuation).toContain("Spec is created or updated");
  expect(continuation).toContain("review it against that intent");
});

test("a bound Plan keeps its exact update tool under non-mutation access", () => {
  const readOnlySurface = guidedNativeToolDefinitions(false).filter(
    (tool) => tool.effectBoundary === "none",
  );
  expect(
    projectPlanModeTools({
      tools: readOnlySurface,
      exactResultRead: false,
      planId: "PLAN-1",
    }).map((tool) => tool.name),
  ).toContain("project_ledger_update");
});

test("Plan mode admits only a draft create or the exact bound Plan update", () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    name,
    args,
    rawArguments: JSON.stringify(args),
  });

  expect(isAllowedProjectPlanMutation(call("project_ledger_create", {
    kind: "plan",
    status: "draft",
  }))).toBe(true);
  expect(isAllowedProjectPlanMutation(call("project_ledger_create", {
    kind: "plan",
    status: "active",
  }))).toBe(false);
  expect(isAllowedProjectPlanMutation(call("project_ledger_update", {
    kind: "plan",
    id: "PLAN-2",
    status: "draft",
  }), "PLAN-1")).toBe(false);
  expect(isAllowedProjectPlanMutation(call("tool_call", {
    id: "native:project_ledger_update",
    arguments: { kind: "plan", id: "PLAN-1", status: "active" },
  }), "PLAN-1")).toBe(true);
});

test("accepted Plan context carries the exact identity and body into execution", () => {
  expect(renderAcceptedProjectPlanContext({
    kind: "plan",
    id: "PLAN-1",
    title: "Plan mode",
    status: "active",
    body: "# Objective\nShip the requested composer flow.",
  })).toBe([
    "Accepted Project Ledger Plan:",
    "- id: PLAN-1",
    "- title: Plan mode",
    "- status: active",
    "",
    "# Objective",
    "Ship the requested composer flow.",
  ].join("\n"));
});
