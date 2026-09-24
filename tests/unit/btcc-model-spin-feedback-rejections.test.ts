import { expect, test } from "bun:test";
import { createActiveDelegationAdmissionGuard } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-round-tool-surface.ts";
import { executePreparedBtccToolCall, prepareBtccToolCall } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-execution.ts";
import { executeDurableWorkTool } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tool-execution.ts";
import { selectedPlanAction } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/worker-delegation.ts";
import { createSubsessionToolHandlers } from
  "../../packages/butler-agent/src/agent/tools/subsession/executor.ts";
import type { SubsessionDelegationService } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";
import type { DurableWorkService } from "../../packages/butler-agent/src/agent/btcc/work/index.ts";

type Rejected = { ok: false; error: { code: string; message: string; reason?: string; alternatives?: string[]; state?: Record<string, unknown>; expected?: unknown } };

function workService(executionMode: string | undefined, overrides: Partial<DurableWorkService> = {}): DurableWorkService {
  return {
    boundWorkForTurn: async () => ({ workId: "w1", status: "open", currentStage: "execution",
      currentPlan: executionMode ? { executionMode } : undefined }),
    loadContext: async () => null,
    ...overrides,
  } as unknown as DurableWorkService;
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: `p-${name}`, name, arguments: args, rawArguments: JSON.stringify(args),
});

test("an outstanding Worker rejection lists management tools and the execution mode", async () => {
  const guard = createActiveDelegationAdmissionGuard(async () => true, {
    role: "steward", turnId: "t", durableWork: workService("workers"), workScope: { turnId: "t", sessionId: "s" },
  });
  const result = await guard.execute(async () => ({ ok: true }))(call("write_file")) as Rejected;
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("tool_unavailable");
  expect(result.error.alternatives).toEqual(expect.arrayContaining(["wait_for_worker", "steer_worker", "delegate_to_worker"]));
  expect(result.error.state).toMatchObject({ execution_mode: "workers", worker_outstanding: true });
  expect(result.error.message).toContain("wait_for_worker");
});

test("active delegated Work rejection lists allowed tools and current mode", async () => {
  const guard = createActiveDelegationAdmissionGuard(async () => false, {
    role: "butler", turnId: "t", durableWork: workService("steward"), workScope: { turnId: "t", sessionId: "s" },
  });
  guard.observe(true);
  const result = await guard.execute(async () => ({ ok: true }))(call("write_file")) as Rejected;
  expect(result.error.code).toBe("active_delegated_work_tool_forbidden");
  expect(result.error.alternatives).toEqual(expect.arrayContaining(["steer_steward", "cancel_steward", "start_work"]));
  expect(result.error.state).toMatchObject({ execution_mode: "steward", active_delegation: true });
});

test("an execution-mode mismatch names allowed tools and the Plan mode", async () => {
  const guard = createActiveDelegationAdmissionGuard(async () => false, {
    role: "steward", turnId: "t", durableWork: workService("workers"), workScope: { turnId: "t", sessionId: "s" },
  });
  const result = await guard.execute(async () => ({ ok: true }))(call("write_file")) as Rejected;
  expect(result.error.code).toBe("tool_unavailable");
  expect(result.error.alternatives).toEqual(expect.arrayContaining(["delegate_to_worker", "replace_work_plan"]));
  expect(result.error.state).toMatchObject({ execution_mode: "workers", role: "steward" });
  const plan = await guard.execute(async () => ({ ok: true }))(call("replace_work_plan", { execution_mode: "steward" })) as Rejected;
  expect(plan.error.alternatives).toEqual(["direct", "workers"]);
});

test("schema rejections name the field, expected shape, and available tools", async () => {
  const tools = [{ name: "lookup", description: "Look up", parameters: { type: "object", additionalProperties: false,
    properties: { key: { type: "string", description: "Key" } }, required: ["key"] } }];
  const invalid = await executePreparedBtccToolCall({ executeTool: async () => ({}) },
    prepareBtccToolCall({ tools }, call("lookup", { key: 3 })));
  expect(invalid.ok).toBe(false);
  if (invalid.ok) return;
  expect(invalid.error.code).toBe("invalid_arguments");
  expect(invalid.error.field).toBe("key");
  expect(invalid.error.expected).toMatchObject({ type: "string" });
  const missing = await executePreparedBtccToolCall({ executeTool: async () => ({}) },
    prepareBtccToolCall({ tools }, call("lokup", { key: "a" })));
  if (missing.ok) throw new Error("expected rejection");
  expect(missing.error.code).toBe("tool_unavailable");
  expect(missing.error.alternatives).toEqual(["lookup"]);
});

test("delegation argument errors are actionable tool results, not raw codes", async () => {
  const handlers = createSubsessionToolHandlers({
    service: { delegateWorkerReviewed: async () => undefined } as unknown as SubsessionDelegationService,
    parentSessionId: "steward", parentTurnId: "turn", anchorMessageId: "message",
    modelRef: "model", reasoningEffort: "medium", parentAccessMode: "full_access",
  });
  const result = await handlers.delegate_to_worker!({ name: "delegate_to_worker", providerCallId: "p", rawArguments: "{}",
    args: { action_key: "build", objective: "", implementation_brief: "brief", acceptance_criteria: ["ok"] } }) as Rejected;
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("delegation_objective_required");
  expect(result.error.message).toContain("objective");
  expect(result.error.alternatives?.[0]).toContain("non-empty string");
});

test("a non-executable Plan action rejection names action status, dependencies, and eligible actions", () => {
  const reviewed = {
    actions: [
      { actionKey: "build", dependencyKeys: [] },
      { actionKey: "test", dependencyKeys: ["build"] },
      { actionKey: "docs", dependencyKeys: [] },
    ],
    action_progress: [{ actionKey: "build", status: "active" }, { actionKey: "docs", status: "done" }],
  } as unknown as Parameters<typeof selectedPlanAction>[0];
  const failure = (() => { try { selectedPlanAction(reviewed, "test"); } catch (error) { return error; } })() as
    { code: string; rejection: Rejected["error"] };
  expect(failure.code).toBe("worker_plan_action_dependency_incomplete");
  expect(failure.rejection.state).toMatchObject({ action_key: "test", pending_dependencies: ["build"] });
  expect(failure.rejection.alternatives).toEqual(["build"]);
  const done = (() => { try { selectedPlanAction(reviewed, "docs"); } catch (error) { return error; } })() as
    { rejection: Rejected["error"] };
  expect(done.rejection.state).toMatchObject({ action_key: "docs", action_status: "done" });
});

test("unsupported Work values list the allowed values", async () => {
  const result = await executeDurableWorkTool({
    service: workService("direct"), scope: { turnId: "t", sessionId: "s" }, mutationCallId: "m",
    name: "record_work_disposition", args: { work_id: "w1", disposition: "done", summary: "x" },
  }) as Rejected;
  expect(result.ok).toBe(false);
  expect(result.error.message).toContain("completed, open, blocked");
});
