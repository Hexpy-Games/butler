import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { completeWorkerResultForDependencies } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/worker-result.ts";
import { completeStewardResultForDependencies } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/terminal-result-service.ts";
import { subsessionResultId } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/identities.ts";
import type { SubsessionDelegationDependencies } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";

for (const status of ["success", "cancelled"] as const) {
test(`Worker ${status} result accepts a resumed source Turn bound to the relation root Work`, async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-worker-result-source-turn-"));
  const relation = {
    relation_id: "relation-worker",
    parent_session_id: "steward-session",
    parent_turn_id: "steward-turn",
    child_session_id: "worker-session",
    anchor_message_id: "anchor",
    ordinal: 1,
    safe_title: "Worker",
    created_at: "2026-09-05T00:00:00.000Z",
  };
  let committedChildTurnId = "";
  const abandonedTurns: string[] = [];
  const dependencies = {
    butlerData: root,
    store: {
      relationByChildSessionId: () => relation,
      childTurnIdByRelationId: () => "initial-worker-turn",
      rootWorkIdByRelationId: () => "worker-root-work",
      packetByRelationId: () => ({
        task_id: "worker-task",
        model_ref: "openai/test",
        reasoning_effort: "medium",
      }),
      resultByRelationId: () => null,
      commitResult: (input: { childTurnId: string; resultId: string }) => {
        committedChildTurnId = input.childTurnId;
        return {
          inserted: true,
          result: {
            result_id: input.resultId,
            relation_id: relation.relation_id,
            child_turn_id: input.childTurnId,
            status,
            summary: "Completed",
            created_at: "2026-09-05T00:00:00.000Z",
          },
          parentInput: { text: "Worker completed" },
        };
      },
      markParentInputDelivered: () => {},
    },
    parentTurns: {
      findTurn: async () => ({
        turnId: "resumed-worker-turn",
        sessionId: "worker-session",
        semanticState: status === "cancelled" ? "cancelled" : "delivered",
      }),
    },
    durableWork: {
      abandonBoundWorkForTurn: async (turnId: string) => { abandonedTurns.push(turnId); },
      boundWorkForTurn: async () => ({
        workId: "worker-root-work",
        sessionId: "worker-session",
      }),
    },
    sessionBindings: {
      getBySessionId: () => ({
        role: "steward",
        workspacePath: root,
        modelRef: "openai/test",
        metadata: { reasoning_effort: "medium" },
      }),
    },
  } as unknown as SubsessionDelegationDependencies;
  const queue = new NativeInboundQueue(root);
  try {
    const result = await completeWorkerResultForDependencies(dependencies, queue, {
      childSessionId: "worker-session",
      childTurnId: "resumed-worker-turn",
      resultId: subsessionResultId("worker-session", "resumed-worker-turn"),
      status,
      summary: "Completed",
    });
    expect(result.status).toBe("committed");
    expect(committedChildTurnId).toBe("resumed-worker-turn");
    expect(abandonedTurns).toEqual(status === "cancelled" ? ["resumed-worker-turn"] : []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
}

test("Worker result rejects a resumed Turn bound to another Work", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-worker-result-wrong-work-"));
  const dependencies = {
    butlerData: root,
    store: {
      relationByChildSessionId: () => ({
        relation_id: "relation-worker",
        child_session_id: "worker-session",
      }),
      childTurnIdByRelationId: () => "initial-worker-turn",
      rootWorkIdByRelationId: () => "worker-root-work",
    },
    parentTurns: {
      findTurn: async () => ({
        sessionId: "worker-session",
        semanticState: "delivered",
      }),
    },
    durableWork: {
      boundWorkForTurn: async () => ({
        workId: "different-work",
        sessionId: "worker-session",
      }),
    },
  } as unknown as SubsessionDelegationDependencies;
  try {
    await expect(completeWorkerResultForDependencies(
      dependencies,
      new NativeInboundQueue(root),
      {
        childSessionId: "worker-session",
        childTurnId: "resumed-worker-turn",
        resultId: subsessionResultId("worker-session", "resumed-worker-turn"),
        status: "success",
        summary: "Completed",
      },
    )).rejects.toThrow("worker_root_work_identity_mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Steward result rejects a delivered Turn bound to another relation Work", async () => {
  const dependencies = {
    store: {
      relationByChildSessionId: () => ({
        relation_id: "relation-steward",
        child_session_id: "steward-session",
      }),
      rootWorkIdByRelationId: () => "relation-root-work",
    },
    parentTurns: {
      findTurn: async () => ({
        sessionId: "steward-session",
        semanticState: "delivered",
      }),
    },
    durableWork: {
      boundWorkForTurn: async () => ({
        workId: "different-work",
        sessionId: "steward-session",
      }),
    },
  } as unknown as SubsessionDelegationDependencies;
  await expect(completeStewardResultForDependencies(
    dependencies,
    async () => {},
    {
      childSessionId: "steward-session",
      childTurnId: "delivered-steward-turn",
      resultId: subsessionResultId("steward-session", "delivered-steward-turn"),
      status: "success",
      summary: "Completed",
    },
  )).rejects.toThrow("subsession_root_work_identity_mismatch");
});
