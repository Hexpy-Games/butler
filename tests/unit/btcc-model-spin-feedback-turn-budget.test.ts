import { expect, test } from "bun:test";
import { enforceRelationTurnBudget } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/turn-budget.ts";
import { priorWorkerAttempts } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/prior-attempts.ts";
import { renderWorkerInput } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/worker-input.ts";
import { createSubsessionToolHandlers } from
  "../../packages/butler-agent/src/agent/tools/subsession/executor.ts";
import type {
  DelegationPacket, SessionRelation, StewardResultEnvelope, SubsessionDelegationService,
} from "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";

const relation = (id: string) => ({ relation_id: id, parent_session_id: "steward", child_session_id: `worker-${id}` }) as SessionRelation;
const packet = (actionKey: string, maxTurns = 3) => ({
  parent_work_ref: { work_id: "parent-work" }, plan_action: { action_key: actionKey, description: "Build it" },
  objective: "Build", acceptance_criteria: ["Works"], access_and_budget_policy: { max_turns: maxTurns },
}) as unknown as DelegationPacket;
const result = (id: string, status: string, code: string | null, summary: string, created: string) => ({
  result_id: `result-${id}`, relation_id: id, status, code, summary, created_at: created,
}) as unknown as StewardResultEnvelope;

function store(input: { revision?: number; results?: Record<string, StewardResultEnvelope>; packets?: Record<string, DelegationPacket> }) {
  return {
    latestDirection: () => input.revision ? { revision: input.revision } : null,
    packetByRelationId: (id: string) => input.packets?.[id] ?? packet("build"),
    resultByRelationId: (id: string) => input.results?.[id] ?? null,
    relationsByParentSessionId: () => Object.keys(input.packets ?? {}).map(relation),
  };
}

test("re-delegating an action carries its prior attempts to the Worker", () => {
  const attempts = priorWorkerAttempts(store({
    packets: { r1: packet("build"), r2: packet("build"), r3: packet("docs") },
    results: {
      r2: result("r2", "blocked", "needs_user_decision", "Which API version?", "2026-09-25T02:00:00Z"),
      r1: result("r1", "incomplete", "child_closeout_missing", "Stopped early", "2026-09-25T01:00:00Z"),
      r3: result("r3", "success", null, "Docs done", "2026-09-25T00:00:00Z"),
    },
  }) as never, { parentSessionId: "steward", parentWorkId: "parent-work", actionKey: "build" });
  expect(attempts).toEqual([
    { attempt: 1, status: "incomplete", code: "child_closeout_missing", summary: "Stopped early" },
    { attempt: 2, status: "blocked", code: "needs_user_decision", summary: "Which API version?" },
  ]);
  const text = renderWorkerInput(packet("build"), undefined, attempts);
  expect(text).toContain("prior_attempts:");
  expect(text).toContain("attempt 2: blocked (needs_user_decision): Which API version?");
});

test("the Steward tool result names prior attempts of a new assignment", async () => {
  const handlers = createSubsessionToolHandlers({
    parentSessionId: "steward", parentTurnId: "turn", anchorMessageId: "message",
    modelRef: "model", reasoningEffort: "medium", parentAccessMode: "full_access",
    service: { delegateWorkerReviewed: async () => ({ relation: { relation_id: "r3" },
      prior_attempts: [{ attempt: 1, status: "incomplete", code: "child_closeout_missing", summary: "Stopped" }] }) } as unknown as SubsessionDelegationService,
  });
  const output = await handlers.delegate_to_worker!({ name: "delegate_to_worker", providerCallId: "p", rawArguments: "{}",
    args: { action_key: "build", objective: "Build", implementation_brief: "Brief", acceptance_criteria: ["Works"] } });
  expect(output).toEqual({ ok: true, status: "queued",
    prior_attempts: [{ attempt: 1, status: "incomplete", code: "child_closeout_missing", summary: "Stopped" }] });
});

test("a relation under its turn budget starts the new Turn", async () => {
  let committed = false;
  await enforceRelationTurnBudget({
    store: store({ revision: 1 }) as never, relation: relation("r1"), role: "worker",
    childTurn: { turnId: "t", semanticState: "delivered" } as never,
    commitIncomplete: async () => { committed = true; },
  });
  expect(committed).toBe(false);
});

test("reaching max_turns commits an incomplete result and explains the rejected steer", async () => {
  const commits: unknown[] = [];
  const error = await enforceRelationTurnBudget({
    store: store({ revision: 2 }) as never, relation: relation("r1"), role: "worker",
    childTurn: { turnId: "worker-turn-2", semanticState: "delivered",
      finalPayload: { content: "Wrote the parser; tests pending." } } as never,
    commitIncomplete: async (input) => { commits.push(input); },
  }).catch((caught: unknown) => caught) as { code: string; rejection: { state: Record<string, unknown>; alternatives: string[] } };
  expect(commits).toEqual([expect.objectContaining({
    childSessionId: "worker-r1", childTurnId: "worker-turn-2", status: "incomplete", code: "turn_budget_exhausted",
    summary: expect.stringContaining("Wrote the parser"),
  })]);
  expect(error.code).toBe("turn_budget_exhausted");
  expect(error.rejection.state).toMatchObject({ turns_used: 3, max_turns: 3, result_status: "incomplete" });
  expect(error.rejection.alternatives.length).toBeGreaterThan(0);
});

test("an exhausted relation that already reported is not reported twice", async () => {
  const commits: unknown[] = [];
  const error = await enforceRelationTurnBudget({
    store: store({ revision: 5, results: { r1: result("r1", "success", null, "Done", "2026-09-25T00:00:00Z") } }) as never,
    relation: relation("r1"), role: "steward",
    childTurn: { turnId: "t", semanticState: "delivered" } as never,
    commitIncomplete: async (input) => { commits.push(input); },
  }).catch((caught: unknown) => caught) as { rejection: { state: Record<string, unknown> } };
  expect(commits).toEqual([]);
  expect(error.rejection.state).toMatchObject({ result_status: "success" });
});
