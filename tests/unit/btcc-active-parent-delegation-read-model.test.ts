/// <reference types="bun" />

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeParentDelegations } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/active-parent-delegation.ts";
import { createSubsessionControlService } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/control.ts";
import type {
  DelegationPacket,
  CreateStewardDirectionInput,
  SessionRelation,
  StewardResultEnvelope,
  StewardDirection,
  SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import { subsessionResultId } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/identities.ts";
import {
  createActiveDelegationAdmissionGuard,
  createGuidedRoundToolSurfaceResolver,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-round-tool-surface.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tools.ts";
import type { DurableWorkService, DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { readFileToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/file-tools/read_file/definition.ts";
import { writeFileToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/file-tools/write_file/definition.ts";
import { toolCallToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_call/definition.ts";
import {
  cancelStewardToolDefinition,
  delegateToStewardToolDefinition,
  steerStewardToolDefinition,
  steerWorkerToolDefinition,
} from "../../packages/butler-agent/src/agent/tools/subsession/definition.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";

test("active parent delegation read model validates exact terminal identities", async () => {
  const fixture = delegationFixture();
  expect(await activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).toEqual([expect.objectContaining({
    relation: fixture.relation,
    child_turn_id: fixture.childTurnId,
  })]);

  fixture.setChildTurn(null);
  expect(await activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).toEqual([expect.objectContaining({
    relation: fixture.relation,
    child_turn_id: fixture.childTurnId,
  })]);
  fixture.setChildTurn(fixture.childTurn);

  fixture.childTurn.semanticState = "delivery_committed";
  expect(await activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).toHaveLength(1);

  fixture.childTurn.semanticState = "delivered";
  expect(await activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).toHaveLength(1);
  fixture.childTurn.semanticState = "cancelled";
  expect(await activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).toHaveLength(1);
  fixture.childTurn.semanticState = "admitted";

  for (const corruptTurn of [
    { ...fixture.childTurn, turnId: "wrong-child-turn" },
    { ...fixture.childTurn, sessionId: "wrong-child-session" },
  ]) {
    fixture.setChildTurn(corruptTurn);
    await expect(activeParentDelegations(fixture.dependencies, {
      parentSessionId: fixture.relation.parent_session_id,
    })).rejects.toThrow("active_parent_delegation_child_turn_mismatch");
  }
  fixture.setChildTurn(fixture.childTurn);

  const exactResult = terminalResult(fixture);
  fixture.setResult(exactResult, exactResult.result_id);
  expect(await activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).toEqual([]);
  const corruptResults: StewardResultEnvelope[] = [
    { ...exactResult, relation_id: "wrong-relation" },
    { ...exactResult, task_id: "wrong-task" },
    { ...exactResult, child_session_id: "wrong-child-session" },
    { ...exactResult, child_turn_id: "wrong-child-turn" },
    { ...exactResult, result_id: "wrong-result" },
  ];
  for (const result of corruptResults) {
    fixture.setResult(result, result.result_id);
    await expect(activeParentDelegations(fixture.dependencies, {
      parentSessionId: fixture.relation.parent_session_id,
    })).rejects.toThrow("active_parent_delegation_result_mismatch");
  }
  fixture.setResult(exactResult, "wrong-stored-result");
  await expect(activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).rejects.toThrow("active_parent_delegation_result_mismatch");
});

test("active parent delegation read model rejects packet and task corruption", async () => {
  const fixture = delegationFixture();
  fixture.packet.parent_work_ref.turn_id = "wrong-parent-turn";
  await expect(activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).rejects.toThrow("active_parent_delegation_packet_mismatch");
  fixture.packet.parent_work_ref.turn_id = fixture.relation.parent_turn_id;
  fixture.setTaskId("wrong-task");
  await expect(activeParentDelegations(fixture.dependencies, {
    parentSessionId: fixture.relation.parent_session_id,
  })).rejects.toThrow("active_parent_delegation_task_mismatch");
});

test("active relation plus Work read failure stays on the restricted surface", async () => {
  let activeReads = 0;
  const active = delegationFact("work-active", "plan-active", "review-active");
  const resolve = surfaceResolver({
    durableWork: {
      boundWorkForTurn: async () => { throw new Error("bound read corrupt"); },
      loadContext: async () => { throw new Error("context read corrupt"); },
    } as unknown as DurableWorkService,
    active: async () => {
      activeReads += 1;
      return [active];
    },
  });
  const names = (await resolve()).names;
  expect(activeReads).toBe(1);
  expect([...names].sort()).toEqual([
    "cancel_steward", "read_file", "start_work", "steer_steward",
  ]);
});

test("delivery-committed child stays active until its terminal result exists", async () => {
  const fixture = delegationFixture();
  fixture.childTurn.semanticState = "delivery_committed";
  const work = reviewedWork("work-active", "plan-active", "review-active");
  const resolve = surfaceResolver({
    durableWork: {
      boundWorkForTurn: async () => null,
      loadContext: async () => ({
        work,
        originalRequest: { turnId: "origin", messageId: "message", content: "active" },
        resultFacts: [],
      }),
    } as unknown as DurableWorkService,
    active: (input) => activeParentDelegations(fixture.dependencies, input),
  });
  const names = (await resolve()).names;
  expect(names.has("steer_steward")).toBe(true);
  expect(names.has("cancel_steward")).toBe(true);
  expect(names.has("start_work")).toBe(true);
  expect(names.has("read_file")).toBe(true);
});

test("an exact reviewed Work is selected among unrelated active siblings", async () => {
  const work = reviewedWork("work-current", "plan-current", "review-current");
  const resolve = surfaceResolver({
    durableWork: {
      boundWorkForTurn: async () => null,
      loadContext: async () => ({
        work,
        originalRequest: { turnId: "origin-current", messageId: "message", content: "current" },
        resultFacts: [],
      }),
    } as unknown as DurableWorkService,
    active: async () => [
      delegationFact("work-unrelated", "plan-unrelated", "review-unrelated"),
      delegationFact(work.workId, work.currentPlan!.planRevisionId,
        work.latestPlanReview!.reviewRevisionId),
    ],
  });
  const names = (await resolve()).names;
  expect(names.has("read_file")).toBe(true);
  expect(names.has("start_work")).toBe(true);
  expect(names.has("steer_steward")).toBe(true);
  expect(names.has("cancel_steward")).toBe(true);
  for (const forbidden of [
    "continue_work", "replace_work_plan", "record_work_review",
    "record_work_disposition", "delegate_to_steward", "write_file", "tool_call",
  ]) expect(names.has(forbidden)).toBe(false);
});

test("execution fallback rejects forbidden active calls and still executes start_work", async () => {
  const guard = createActiveDelegationAdmissionGuard();
  guard.observe(true);
  const executed: string[] = [];
  const execute = guard.execute(async (call) => {
    executed.push(call.name);
    return { ok: true };
  });
  await expect(execute(modelCall("write_file"))).resolves.toMatchObject({
    ok: false,
    error: { code: "active_delegated_work_tool_forbidden" },
  });
  expect(executed).toEqual([]);
  await expect(execute(modelCall("start_work"))).resolves.toEqual({ ok: true });
  expect(executed).toEqual(["start_work"]);
});

test("control service executes exact steer and cancel for the active relation", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-active-control-"));
  const fixture = delegationFixture();
  let createdInstruction = "";
  fixture.store.createDirection = (input) => {
    createdInstruction = input.instruction;
    return {
      ...input,
      revision: 1,
      status: "pending",
      applied_at: null,
      applied_child_turn_id: null,
    };
  };
  const controls = createSubsessionControlService(
    fixture.dependencies,
    new NativeInboundQueue(root),
  );
  try {
    const steered = await controls.steerSteward({
      parentSessionId: fixture.relation.parent_session_id,
      sourceParentTurnId: "fresh-control-turn",
      sourceMessageId: "fresh-control-message",
      relationId: fixture.relation.relation_id,
      instruction: "Keep the same Work and correct the bounded detail.",
    });
    expect(steered.relation_id).toBe(fixture.relation.relation_id);
    expect(createdInstruction).toBe(
      "Keep the same Work and correct the bounded detail.",
    );
    await expect(controls.cancelSteward({
      parentSessionId: fixture.relation.parent_session_id,
      sourceParentTurnId: "fresh-cancel-turn",
      sourceMessageId: "fresh-cancel-message",
      relationId: fixture.relation.relation_id,
    })).resolves.toMatchObject({
      relation: fixture.relation,
      child_turn_id: fixture.childTurnId,
      status: "cancelling",
    });
    expect(readdirSync(join(root, "runtime", "inbound-events", "pending")))
      .toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivered child receives direction on a fresh continuation Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-active-direction-"));
  const fixture = delegationFixture();
  fixture.childTurn.semanticState = "delivered";
  let pending: StewardDirection | null = null;
  fixture.store.createDirection = (input) => {
    pending = {
      ...input,
      revision: 1,
      status: "pending",
      applied_at: null,
      applied_child_turn_id: null,
    };
    return pending;
  };
  fixture.store.consumePendingDirection = ({ childTurnId }) => {
    if (!pending) return null;
    pending = {
      ...pending,
      status: "applied",
      applied_at: "2026-08-30T00:00:01.000Z",
      applied_child_turn_id: childTurnId,
    };
    return pending;
  };
  fixture.store.rootWorkIdByRelationId = () => "task-active";
  fixture.dependencies.sessionBindings = {
    getBySessionId: () => ({
      sessionId: fixture.relation.child_session_id,
      role: "steward",
      workspacePath: "/tmp/workspace",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.5",
      runtimeAdapterId: "btcc-turn-runtime",
      transportBindings: [],
      metadata: { reasoning_effort: "low" },
    }),
  } as unknown as SubsessionDelegationDependencies["sessionBindings"];
  fixture.dependencies.durableWork = {
    bindOpenWork: async () => reviewedWork(
      "task-active", "plan-active", "review-active",
    ),
  } as unknown as DurableWorkService;
  const controls = createSubsessionControlService(
    fixture.dependencies,
    new NativeInboundQueue(root),
  );
  try {
    const direction = await controls.steerSteward({
      parentSessionId: fixture.relation.parent_session_id,
      sourceParentTurnId: "fresh-control-turn",
      sourceMessageId: "fresh-control-message",
      instruction: "Correct the current work without replacing the session.",
    });
    expect(direction.status).toBe("pending");
    expect(readdirSync(join(root, "runtime", "inbound-events", "pending")))
      .toHaveLength(1);
    await expect(controls.consumeStewardDirection({
      childSessionId: fixture.relation.child_session_id,
      childTurnId: "fresh-continuation-turn",
    })).resolves.toMatchObject({
      status: "applied",
      applied_child_turn_id: "fresh-continuation-turn",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function surfaceResolver(input: {
  durableWork: DurableWorkService;
  active: SubsessionDelegationService["activeParentDelegations"];
}) {
  return createGuidedRoundToolSurfaceResolver({
    turnId: "fresh-turn",
    tools: [
      ...DURABLE_WORK_TOOL_DEFINITIONS,
      readFileToolDefinition,
      writeFileToolDefinition,
      toolCallToolDefinition,
      delegateToStewardToolDefinition,
      steerStewardToolDefinition,
      steerWorkerToolDefinition,
      cancelStewardToolDefinition,
    ],
    requiredToolNames: new Set(),
    toolJournal: { list: () => [] },
    durableWork: input.durableWork,
    workScope: { turnId: "fresh-turn", sessionId: "parent-session" },
    effectJournal: { listForWork: async () => [] },
    parentSessionId: "parent-session",
    subsessionDelegation: { activeParentDelegations: input.active },
  });
}

function reviewedWork(
  workId: string,
  planRevisionId: string,
  reviewRevisionId: string,
): DurableWorkView {
  return {
    workId,
    sessionId: "parent-session",
    scope: { kind: "session", sessionId: "parent-session" },
    origin: { turnId: "origin-turn", messageId: "origin-message" },
    objective: "Reviewed objective",
    status: "open",
    currentStage: "execution",
    allowedNextStages: ["review"],
    actionProgress: [{ actionKey: "delegate", status: "active" }],
    currentPlan: {
      planRevisionId,
      revision: 1,
      objective: "Reviewed objective",
      actions: [{ actionKey: "delegate", description: "Delegate", dependencyKeys: [] }],
      checks: [],
      originTurnId: "continued-review-turn",
      createdAt: "2026-08-26T00:00:00.000Z",
    },
    latestPlanReview: {
      reviewRevisionId,
      revision: 1,
      subject: "plan",
      verdict: "accept",
      summary: "Accepted",
      corrections: [],
      boundPlanRevisionId: planRevisionId,
      boundResultRefs: [],
      originTurnId: "continued-review-turn",
      createdAt: "2026-08-26T00:00:01.000Z",
    },
    resultRefs: [],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:01.000Z",
  };
}

function delegationFact(workId: string, planId: string, reviewId: string) {
  const relation = relationFixture(`relation-${workId}`, `child-${workId}`);
  return {
    relation,
    parent_work_ref: {
      work_id: workId,
      session_id: "parent-session",
      turn_id: relation.parent_turn_id,
      plan_revision_id: planId,
      review_revision_id: reviewId,
    },
    child_turn_id: `turn-${workId}`,
  };
}

function delegationFixture() {
  const relation = relationFixture("relation-active", "child-session");
  const childTurnId = "child-turn";
  const packet = packetFixture(relation);
  const admittedChildTurn = {
    turnId: childTurnId,
    sessionId: relation.child_session_id,
    semanticState: "admitted" as
      "admitted" | "delivery_committed" | "delivered" | "cancelled",
  };
  let childTurn: typeof admittedChildTurn | null = admittedChildTurn;
  let result: StewardResultEnvelope | null = null;
  let storedResultId: string | null = null;
  let taskId = packet.task_id;
  const store = {
    relationsByParentSessionId: () => [relation],
    relationByChildSessionId: (sessionId: string) =>
      sessionId === relation.child_session_id ? relation : null,
    packetByRelationId: () => packet,
    taskIdByRelationId: () => taskId,
    childTurnIdByRelationId: () => childTurnId,
    resultByRelationId: () => result,
    resultIdForRelation: () => storedResultId,
    createDirection: (_input: CreateStewardDirectionInput): StewardDirection => {
      throw new Error("not configured");
    },
    consumePendingDirection: (
      _input: { relationId: string; childTurnId: string },
    ): StewardDirection | null => null,
    rootWorkIdByRelationId: () => packet.task_id,
  };
  const dependencies = {
    butlerData: "/tmp",
    store,
    parentTurns: { findTurn: async () => childTurn },
  } as unknown as SubsessionDelegationDependencies;
  return {
    relation,
    packet,
    childTurnId,
    childTurn: admittedChildTurn,
    store,
    dependencies,
    setChildTurn(value: typeof admittedChildTurn | null) { childTurn = value; },
    setResult(value: StewardResultEnvelope, identity: string) {
      result = value;
      storedResultId = identity;
    },
    setTaskId(value: string) { taskId = value; },
  };
}

function relationFixture(relationId: string, childSessionId: string): SessionRelation {
  return {
    relation_id: relationId,
    parent_session_id: "parent-session",
    parent_turn_id: `parent-turn-${relationId}`,
    child_session_id: childSessionId,
    anchor_message_id: `message-${relationId}`,
    ordinal: 1,
    safe_title: "Active Steward",
    created_at: "2026-08-26T00:00:00.000Z",
  };
}

function packetFixture(relation: SessionRelation): DelegationPacket {
  return {
    delegation_id: "delegation-active",
    task_id: "task-active",
    parent_session_id: relation.parent_session_id,
    parent_turn_id: relation.parent_turn_id,
    relation_id: relation.relation_id,
    execution_mode: "read_only",
    objective: "Active objective",
    acceptance_criteria: [],
    task_or_plan_refs: [],
    constraints_and_non_goals: [],
    allowed_tools_and_effects: [],
    mutation_scope: [],
    workspace_and_worktree: {
      ownership: "project",
      workspace_label: "Validated project workspace",
      repository_anchor_ref: "parent-session-project",
    },
    expected_result_schema: {
      version: 1,
      status: "success",
      required_fields: ["summary", "acceptance_evidence", "changed_artifacts"],
    },
    work_creation_policy: "one_recoverable_child_work",
    access_and_budget_policy: {
      access_mode: "full_access",
      max_turns: 10,
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "low",
    },
    parent_work_ref: {
      work_id: "work-active",
      session_id: relation.parent_session_id,
      turn_id: relation.parent_turn_id,
      plan_revision_id: "plan-active",
      review_revision_id: "review-active",
    },
    model_ref: "openai/gpt-5.5",
    reasoning_effort: "low",
  };
}

function terminalResult(fixture: ReturnType<typeof delegationFixture>): StewardResultEnvelope {
  return {
    result_id: subsessionResultId(fixture.relation.child_session_id, fixture.childTurnId),
    relation_id: fixture.relation.relation_id,
    task_id: fixture.packet.task_id,
    child_session_id: fixture.relation.child_session_id,
    child_turn_id: fixture.childTurnId,
    status: "success",
    code: null,
    summary: "Complete",
    acceptance_evidence: [],
    changed_artifacts: [],
    commits: [],
    tests: [],
    remaining_risks: [],
    follow_up_recommendations: [],
    detail_refs: [],
    created_at: "2026-08-26T00:00:02.000Z",
  };
}

function modelCall(name: string) {
  return {
    id: `call-${name}`,
    name,
    arguments: {},
    rawArguments: "{}",
  };
}
