import { expect, test } from "bun:test";
import { completedToolProgressSummary } from "../../packages/butler-agent/src/agent/turn/native/tool-execution/completed-tool-progress.ts";
import { createProjectLedgerFreshnessCache } from "../../packages/butler-agent/src/agent/turn/native/tool-execution/project-ledger-freshness-cache.ts";
import { applyPlannedReviewToolPolicy } from "../../packages/butler-agent/src/agent/turn/native/policy/planned-review-tool-policy.ts";
import {
  activeTodoWorkBlockFromArgs,
  runtimeSemanticTodoItems,
  shouldSynthesizeRuntimeSemanticProgress,
} from "../../packages/butler-agent/src/agent/turn/native/progress/runtime-semantic-progress.ts";

test("planned review policy injects scoped ownership and blocks sibling starts", () => {
  const repairArgs: Record<string, unknown> = {};
  expect(applyPlannedReviewToolPolicy({
    plannedReview: {
      taskId: "planned-alpha",
      attempt: 2,
      workerTaskId: "worker-1",
      reviewEventId: "review-1",
    },
    toolName: "repair_planned_task",
    args: repairArgs,
  })).toBeNull();
  expect(repairArgs).toEqual({
    task_id: "planned-alpha",
    attempt: 2,
    worker_task_id: "worker-1",
    review_event_id: "review-1",
  });

  const block = applyPlannedReviewToolPolicy({
    plannedReview: {
      taskId: "planned-alpha",
      attempt: null,
      workerTaskId: null,
      reviewEventId: null,
    },
    toolName: "dispatch_worker",
    args: {},
  });
  expect(block?.result).toEqual(expect.objectContaining({
    ok: false,
    blocked_tool: "dispatch_worker",
    planned_review_task_id: "planned-alpha",
  }));
});

test("runtime semantic progress policy recognizes only durable compound command work", () => {
  expect(shouldSynthesizeRuntimeSemanticProgress({
    callName: "run_command",
    args: { command: "bun test && bun run typecheck" },
  })).toBe(true);
  expect(shouldSynthesizeRuntimeSemanticProgress({
    callName: "run_command",
    args: { command: "rg worker src" },
  })).toBe(false);
  expect(shouldSynthesizeRuntimeSemanticProgress({
    callName: "dispatch_worker",
    args: { task: "run the plan" },
  })).toBe(false);
});

test("runtime semantic progress derives active todo work blocks from real args", () => {
  expect(activeTodoWorkBlockFromArgs({
    todos: [
      { id: "plan", content: "Plan", status: "completed" },
      { id: "exec", active_form: "Running validation", status: "in_progress" },
    ],
  })).toEqual({
    id: "work-todo-exec",
    label: "Running validation",
  });
});

test("runtime semantic todo items preserve user-facing active forms", () => {
  expect(runtimeSemanticTodoItems({
    language: "ko",
    executionLabel: "검증 실행",
    state: "execution",
  }).map((item) => [item.id, item.active_form])).toEqual([
    ["orient", "요청 의도를 확인합니다."],
    ["plan", "확인 경로를 준비합니다."],
    ["execute", "검증 실행"],
    ["review", "도구 결과를 검토합니다."],
    ["consolidate", "핵심 결과를 정리합니다."],
    ["report", "사용자에게 보고합니다."],
  ]);
});

test("Project Ledger freshness cache de-duplicates reads and invalidates after mutation", async () => {
  const calls: string[] = [];
  const cache = createProjectLedgerFreshnessCache(async (call) => {
    calls.push(call.name);
    return { ok: true, count: calls.length };
  });

  await expect(cache.execute({
    name: "inspect_project_status",
    args: { project_path: "/tmp/project" },
    rawArguments: "{}",
  })).resolves.toEqual({ ok: true, count: 1 });
  await expect(cache.execute({
    name: "inspect_project_status",
    args: { project_path: "/tmp/project" },
    rawArguments: "{}",
  })).resolves.toEqual({ ok: true, count: 1 });
  await cache.execute({
    name: "run_command",
    args: { command: "node packages/project-ledger/bin/project-ledger index" },
    rawArguments: "{}",
  });
  await expect(cache.execute({
    name: "inspect_project_status",
    args: { project_path: "/tmp/project" },
    rawArguments: "{}",
  })).resolves.toEqual({ ok: true, count: 3 });
});

test("Project Ledger freshness cache invalidates after native lifecycle mutations", async () => {
  const calls: string[] = [];
  const cache = createProjectLedgerFreshnessCache(async (call) => {
    calls.push(call.name);
    return { ok: true, count: calls.length };
  });

  await expect(cache.execute({
    name: "query_project_work",
    args: { project_path: "/tmp/project", kind: "task" },
    rawArguments: "{}",
  })).resolves.toEqual({ ok: true, count: 1 });
  await expect(cache.execute({
    name: "query_project_work",
    args: { project_path: "/tmp/project", kind: "task" },
    rawArguments: "{}",
  })).resolves.toEqual({ ok: true, count: 1 });
  await cache.execute({
    name: "project_ledger_task_update",
    args: { project_path: "/tmp/project", id: "T-LEDGER", status: "in_progress" },
    rawArguments: "{}",
  });
  await expect(cache.execute({
    name: "query_project_work",
    args: { project_path: "/tmp/project", kind: "task" },
    rawArguments: "{}",
  })).resolves.toEqual({ ok: true, count: 3 });
  await cache.execute({
    name: "project_ledger_render",
    args: { project_path: "/tmp/project", view: "dashboard", write: true },
    rawArguments: "{}",
  });
  await expect(cache.execute({
    name: "query_project_work",
    args: { project_path: "/tmp/project", kind: "task" },
    rawArguments: "{}",
  })).resolves.toEqual({ ok: true, count: 5 });
});

test("completed tool progress projects smart web search planned queries", () => {
  const progress = completedToolProgressSummary({
    kind: "searched",
    toolName: "Web search",
    safeLabel: "Searching",
    workBlockLabel: "Searching",
    inputLabel: "",
    detailRows: [],
  }, {
    search_plan: {
      mode: "smart",
      queries: [{ query: "Butler tool routing" }],
    },
  });

  expect(progress.safeLabel).toBe("Smart web search: 1 planned query");
  expect(progress.detailRows).toEqual([expect.objectContaining({
    safe_value: "Butler tool routing",
    state: "delivered",
  })]);
});
