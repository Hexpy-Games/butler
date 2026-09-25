import { expect, test } from "bun:test";
import { createSubsessionToolHandlers } from
  "../../packages/butler-agent/src/agent/tools/subsession/executor.ts";
import { createGuidedToolBatchTransition } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-batch-transition.ts";
import type { SubsessionDelegationService } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";
import type { DurableWorkService } from "../../packages/butler-agent/src/agent/btcc/work/index.ts";

const identity = {
  parentSessionId: "steward", parentTurnId: "turn", anchorMessageId: "message",
  modelRef: "model", reasoningEffort: "medium", parentAccessMode: "full_access" as const,
};
const args = { action_key: "build", objective: "Implement", implementation_brief: "Keep API", acceptance_criteria: ["Works"] };

function handlersReturning(reused: "active" | "settled" | undefined) {
  return createSubsessionToolHandlers({
    ...identity,
    service: {
      delegateWorkerReviewed: async () => ({ relation: { relation_id: "relation-1" }, reused }),
    } as unknown as SubsessionDelegationService,
  });
}

test("re-assigning a running action returns already_delegated with a wait instruction", async () => {
  const result = await handlersReturning("active").delegate_to_worker!({
    name: "delegate_to_worker", providerCallId: "p", rawArguments: "{}", args,
  }) as Record<string, unknown>;
  expect(result).toMatchObject({ ok: true, status: "already_delegated", relation_id: "relation-1" });
  expect(String(result.message)).toContain("wait_for_worker");
});

test("re-assigning an identical finished assignment is an actionable rejection", async () => {
  const result = await handlersReturning("settled").delegate_to_worker!({
    name: "delegate_to_worker", providerCallId: "p", rawArguments: "{}", args,
  }) as { ok: false; error: { code: string; alternatives: string[] } };
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("identical_assignment_already_settled");
  expect(result.error.alternatives.length).toBeGreaterThan(0);
});

test("a new assignment still reports queued", async () => {
  const result = await handlersReturning(undefined).delegate_to_worker!({
    name: "delegate_to_worker", providerCallId: "p", rawArguments: "{}", args,
  });
  expect(result).toEqual({ ok: true, status: "queued" });
});

test("only a newly queued assignment keeps the Steward managing; repeats and steers wait", async () => {
  const transition = createGuidedToolBatchTransition({
    turnId: "turn",
    durableWork: { boundWorkForTurn: async () => null } as unknown as DurableWorkService,
    shouldWaitForWorker: async () => true,
  });
  const batch = (name: string, output: Record<string, unknown>) => ({
    toolCalls: [{ id: "c", name, arguments: {}, rawArguments: "{}" }],
    toolResults: [{ toolCallId: "c", name, ok: true as const, output }],
    iteration: 1,
  });
  expect(await transition(batch("delegate_to_worker", { ok: true, status: "queued" }))).toBe("continue");
  expect(await transition(batch("delegate_to_worker", { ok: true, status: "already_delegated" }))).toBe("wait");
  expect(await transition(batch("steer_worker", { ok: true, status: "pending" }))).toBe("wait");
  // A rejected management call is delivered to the model before any wait.
  expect(await transition({ ...batch("delegate_to_worker", {}), toolResults: [{ toolCallId: "c", name: "delegate_to_worker",
    ok: false as const, error: { code: "worker_plan_action_missing", message: "No such action." } }] })).toBe("continue");
});
