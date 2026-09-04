import { expect, test } from "bun:test";
import {
  createActiveDelegationAdmissionGuard,
  createGuidedRoundToolSurfaceResolver,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-round-tool-surface.ts";
import { createGuidedToolBatchTransition } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-batch-transition.ts";
import { createGuidedWorkContextRefresh } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-work-context-refresh.ts";
import type { DurableWorkService, DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";

const tools = [
  {
    name: "delegate_to_worker",
    description: "Delegate one action.",
    parameters: {
      type: "object",
      properties: { relation_id: { type: "string" } },
    },
  },
  {
    name: "edit_file",
    description: "Edit one file.",
    parameters: { type: "object", properties: {} },
  },
] as const;

test("guided role tool schemas stay stable as Work and relations change", async () => {
  let work: DurableWorkView | null = null;
  let active: Array<Record<string, unknown>> = [];
  const durableWork = {
    boundWorkForTurn: async () => work,
    loadContext: async () => work ? { work } : null,
  } as unknown as DurableWorkService;
  const resolve = createGuidedRoundToolSurfaceResolver({
    turnId: "turn",
    tools,
    requiredToolNames: new Set(),
    toolJournal: { list: () => [] },
    durableWork,
    workScope: { sessionId: "steward", turnId: "turn" },
    effectJournal: { listForWork: async () => [] },
    parentSessionId: "steward",
    subsessionDelegation: {
      activeParentDelegations: async () => active as never,
    },
    shouldWaitForWorker: async () => active.length > 0,
  });

  const initial = await resolve();
  work = {
    workId: "work",
    sessionId: "steward",
    status: "open",
    objective: "Complete the task",
    currentPlan: {
      planRevisionId: "plan-1",
      objective: "Complete the task",
      executionMode: "workers",
      actions: [],
      checks: [],
    },
  } as unknown as DurableWorkView;
  active = [{ relation: { relation_id: "relation-1" } }];
  const managed = await resolve();

  expect(managed.tools).toEqual(initial.tools);
  expect(managed.digest).toBe(initial.digest);
});

test("reviewed execution ownership is enforced at each Steward tool call", async () => {
  let mode: "direct" | "workers" | undefined = "direct";
  let stage = "execution";
  const durableWork = {
    boundWorkForTurn: async () => ({
      currentStage: stage,
      currentPlan: { executionMode: mode },
    }),
  } as unknown as DurableWorkService;
  const guard = createActiveDelegationAdmissionGuard(
    async () => false,
    {
      role: "steward",
      turnId: "turn",
      durableWork,
      workScope: { sessionId: "steward", turnId: "turn" },
    },
  );
  const executed: string[] = [];
  const execute = guard.execute(async (call) => {
    executed.push(call.name);
    return { ok: true };
  });
  const call = (name: string) => execute({
    id: name,
    name,
    arguments: {},
    rawArguments: "{}",
  });

  expect(await call("delegate_to_worker")).toMatchObject({ ok: false });
  expect(await call("edit_file")).toMatchObject({ ok: true });
  mode = "workers";
  expect(await call("edit_file")).toMatchObject({ ok: false });
  expect(await call("read_file")).toMatchObject({ ok: false });
  stage = "validation";
  expect(await call("run_command")).toMatchObject({ ok: true });
  stage = "execution";
  mode = undefined;
  expect(await call("edit_file")).toMatchObject({ ok: false });
  expect(await call("delegate_to_worker")).toMatchObject({ ok: false });
  expect(executed).toEqual(["edit_file", "run_command"]);
});

test("settled Worker result Turn admits integration while retaining Worker execution ownership", async () => {
  const durableWork = {
    boundWorkForTurn: async () => ({
      currentStage: "execution",
      currentPlan: { executionMode: "workers" },
    }),
  } as unknown as DurableWorkService;
  const guard = createActiveDelegationAdmissionGuard(async () => false, {
    role: "steward",
    turnId: "steward-worker-result-settled",
    durableWork,
    workScope: { sessionId: "steward", turnId: "steward-worker-result-settled" },
    workerResultIntegration: true,
  });
  const executed: string[] = [];
  const execute = guard.execute(async (call) => {
    executed.push(call.name);
    return { ok: true };
  });
  await expect(execute({ id: "read", name: "read_file", arguments: {},
    rawArguments: "{}" })).resolves.toEqual({ ok: true });
  await expect(execute({ id: "validate", name: "run_command", arguments: { state_effect: "validation" },
    rawArguments: '{"state_effect":"validation"}' })).resolves.toEqual({ ok: true });
  for (const [name, args] of [
    ["write_file", {}],
    ["edit_file", {}],
    ["run_command", { state_effect: "mutation" }],
    ["tool_call", { id: "native:edit_file", arguments: { path: "file.txt" } }],
  ] as const) {
    await expect(execute({ id: name, name, arguments: args,
      rawArguments: JSON.stringify(args) })).resolves.toMatchObject({ ok: false });
  }
  expect(executed).toEqual(["read_file", "run_command"]);
});

test("Worker management results are observed before a later wait decision", async () => {
  const transition = createGuidedToolBatchTransition({
    turnId: "turn",
    durableWork: {} as DurableWorkService,
    shouldWaitForWorker: async () => true,
  });
  expect(await transition({
    iteration: 1,
    toolCalls: [{ id: "delegate", name: "delegate_to_worker", arguments: {}, rawArguments: "{}" }],
    toolResults: [{
      toolCallId: "delegate",
      name: "delegate_to_worker",
      ok: false,
      error: { code: "invalid_assignment", message: "Action is not eligible." },
    }],
  })).toBe("continue");
  expect(await transition({ iteration: 2, toolCalls: [], toolResults: [] }))
    .toBe("wait");
});

test("current Work context refreshes after mutation without changing stable instructions", async () => {
  const stableInstructions = "stable-role-and-tool-contract";
  let status: "open" | "blocked" = "open";
  const context = () => ({
    originalRequest: { content: "Complete the task" },
    work: {
      workId: "work",
      sessionId: "steward",
      objective: "Complete the task",
      status,
      allowedNextStages: [],
      actionProgress: [],
      resultRefs: [],
    },
    resultFacts: [],
  }) as never;
  const refresh = createGuidedWorkContextRefresh({
    initial: context(),
    load: async () => context(),
  });

  expect(await refresh()).toBeUndefined();
  status = "blocked";
  expect(await refresh()).toContain("Status: blocked");
  expect(await refresh()).toBeUndefined();
  expect(stableInstructions).toBe("stable-role-and-tool-contract");
});
