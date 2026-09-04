import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSubsessionDelegationStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/subsession-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import {
  findActiveWorkerAssignment,
  replayDispatchIntent,
} from "../../packages/butler-agent/src/agent/btcc/subsessions/worker-delegation.ts";
import type {
  DelegationPacket,
  SessionRelation,
  SubsessionDispatchIntent,
} from "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worker assignment persists dispatch atomically and reuses one active Work action", () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-worker-dispatch-"));
  roots.push(root);
  const db = new Database(join(root, "btcc.sqlite"));
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const store = new SqliteSubsessionDelegationStore(db);
  const bindings = new SessionBindingStore(
    join(root, "session-store.sqlite"),
    "ephemeral",
  );
  const queue = new NativeInboundQueue(root);
  const relation = workerRelation();
  const packet = workerPacket(relation);
  const dispatchIntent = workerDispatchIntent(relation, packet);
  try {
    db.exec(`
      CREATE TRIGGER fail_worker_delegation
      BEFORE INSERT ON btcc_subsession_delegations
      BEGIN SELECT RAISE(ABORT, 'simulated dispatch-intent failure'); END
    `);
    expect(() => store.create({
      relation,
      packet,
      childTurnId: "worker-turn-1",
      rootWorkId: "worker-root-1",
      dispatchIntent,
    })).toThrow("simulated dispatch-intent failure");
    expect(rowCount(db, "btcc_session_relations")).toBe(0);
    db.exec("DROP TRIGGER fail_worker_delegation");

    expect(store.createWorkerAssignment({
      relation,
      packet,
      childTurnId: "worker-turn-1",
      rootWorkId: "worker-root-1",
      dispatchIntent,
    })).toEqual(relation);
    expect(rowCount(db, "btcc_session_relations")).toBe(1);
    expect(rowCount(db, "btcc_subsession_delegations")).toBe(1);
    expect(store.dispatchIntentByRelationId(relation.relation_id))
      .toEqual(dispatchIntent);
    expect(store.pendingDispatchIntents()).toEqual([{
      relationId: relation.relation_id,
      intent: dispatchIntent,
    }]);

    const duplicateRelation = {
      ...relation,
      relation_id: "relation-worker-duplicate",
      parent_turn_id: "steward-turn-new",
      child_session_id: "worker-session-duplicate",
      ordinal: 2,
    };
    const duplicatePacket = {
      ...workerPacket(duplicateRelation),
      delegation_id: "delegation-worker-duplicate",
      task_id: "task-worker-duplicate",
      implementation_brief: "A changed brief must not create another active assignment.",
    };
    const duplicateIntent = workerDispatchIntent(duplicateRelation, duplicatePacket);
    expect(store.createWorkerAssignment({
      relation: duplicateRelation,
      packet: duplicatePacket,
      childTurnId: "worker-turn-duplicate",
      rootWorkId: "worker-root-duplicate",
      dispatchIntent: duplicateIntent,
    })).toEqual(relation);
    expect(rowCount(db, "btcc_session_relations")).toBe(1);
    expect(rowCount(db, "btcc_subsession_delegations")).toBe(1);

    expect(findActiveWorkerAssignment(
      store,
      relation.parent_session_id,
      packet.parent_work_ref.work_id,
      packet.plan_action!.action_key,
    )).toEqual(relation);

    replayDispatchIntent({ sessionBindings: bindings, store }, queue, relation.relation_id,
      dispatchIntent);
    replayDispatchIntent({ sessionBindings: bindings, store }, queue, relation.relation_id,
      dispatchIntent);
    expect(bindings.getBySessionId(relation.child_session_id)).toMatchObject({
      role: "worker",
      workspacePath: root,
    });
    expect(queue.findIdempotent(dispatchIntent.envelope)?.envelope.message.text)
      .toBe("Execute the stored Worker assignment");
    expect(store.pendingDispatchIntents()).toEqual([]);

    insertCompletedResult(db, relation, packet);
    expect(findActiveWorkerAssignment(
      store,
      relation.parent_session_id,
      packet.parent_work_ref.work_id,
      packet.plan_action!.action_key,
    )).toBeUndefined();
    expect(store.createWorkerAssignment({
      relation: duplicateRelation,
      packet: duplicatePacket,
      childTurnId: "worker-turn-duplicate",
      rootWorkId: "worker-root-duplicate",
      dispatchIntent: duplicateIntent,
    })).toEqual(duplicateRelation);
    expect(rowCount(db, "btcc_session_relations")).toBe(2);
  } finally {
    bindings.close();
    db.close();
  }
});

function workerRelation(): SessionRelation {
  return {
    relation_id: "relation-worker-1",
    parent_session_id: "steward-session-1",
    parent_turn_id: "steward-turn-1",
    child_session_id: "worker-session-1",
    anchor_message_id: "anchor-worker-1",
    ordinal: 1,
    safe_title: "Worker action",
    created_at: "2026-09-05T00:00:00.000Z",
  };
}

function workerPacket(relation: SessionRelation): DelegationPacket {
  return {
    delegation_id: "delegation-worker-1",
    task_id: "task-worker-1",
    parent_session_id: relation.parent_session_id,
    parent_turn_id: relation.parent_turn_id,
    relation_id: relation.relation_id,
    execution_mode: "mutation",
    objective: "Execute one Plan action",
    acceptance_criteria: ["The action is complete"],
    implementation_brief: "Initial brief text must not define assignment identity.",
    task_or_plan_refs: ["plan-revision-1"],
    plan_action: {
      action_key: "implement-action",
      description: "Implement the action",
      dependency_keys: [],
    },
    constraints_and_non_goals: [],
    allowed_tools_and_effects: ["write_file:workspace"],
    mutation_scope: ["."],
    workspace_and_worktree: {
      ownership: "parent_session",
      workspace_label: "Inherited parent session workspace",
      repository_anchor_ref: "parent-session-workspace",
    },
    expected_result_schema: {
      version: 1,
      status: "success",
      required_fields: ["summary", "acceptance_evidence", "changed_artifacts"],
    },
    work_creation_policy: "one_recoverable_child_work",
    access_and_budget_policy: {
      access_mode: "full_access",
      max_turns: 8,
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "low",
    },
    parent_work_ref: {
      work_id: "steward-work-1",
      session_id: relation.parent_session_id,
      turn_id: relation.parent_turn_id,
      plan_revision_id: "plan-revision-1",
      review_revision_id: "review-revision-1",
    },
    model_ref: "openai/gpt-5.5",
    reasoning_effort: "low",
  };
}

function workerDispatchIntent(
  relation: SessionRelation,
  packet: DelegationPacket,
): SubsessionDispatchIntent {
  return {
    childBinding: {
      sessionId: relation.child_session_id,
      role: "worker",
      workspacePath: roots[0]!,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.5",
      transportBindings: [],
    },
    envelope: {
      eventId: `worker:${packet.delegation_id}`,
      transport: "app",
      accountId: "local",
      peer: {
        kind: "dm",
        id: relation.child_session_id,
        parentId: relation.parent_session_id,
      },
      sender: { id: "butler-worker-dispatch", displayName: "Butler Worker" },
      message: {
        id: `worker-message:${packet.delegation_id}`,
        text: "Execute the stored Worker assignment",
        timestamp: relation.created_at,
      },
      routingHints: {
        sessionId: relation.child_session_id,
        turnId: "worker-turn-1",
      },
      raw: { source: "btcc-worker-delegation" },
    },
    metadata: { source: "btcc-worker-delegation" },
  };
}

function insertCompletedResult(
  db: Database,
  relation: SessionRelation,
  packet: DelegationPacket,
): void {
  db.query(`
    INSERT INTO btcc_steward_results (
      result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, code, summary, acceptance_evidence_json, changed_artifacts_json,
      changed_files_json, commits_json, tests_json, remaining_risks_json,
      follow_up_recommendations_json, detail_refs_json, created_at
    ) VALUES (?, ?, ?, ?, ?, 'success', NULL, 'complete', '[]', '[]',
      '[]', '[]', '[]', '[]', '[]', '[]', ?)
  `).run(
    "result-worker-1",
    relation.relation_id,
    packet.task_id,
    relation.child_session_id,
    "worker-turn-1",
    "2026-09-05T00:01:00.000Z",
  );
}

function rowCount(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
    .get()!.count;
}
