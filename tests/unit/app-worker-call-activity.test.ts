import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { SubsessionDelegationService } from "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";
import { createSubsessionToolHandlers } from "../../packages/butler-agent/src/agent/tools/subsession/executor.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteStewardObserverStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/steward-observer-store.ts";
import { projectStewardWorkerActivity } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer-worker.ts";
import type { StewardObserverSnapshot } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";

const relation = { relation_id: "relation", parent_session_id: "steward", parent_turn_id: "parent-turn",
  child_session_id: "worker", anchor_message_id: "message", ordinal: 1, safe_title: "Implement", created_at: "2026-09-06T00:00:00Z" };

test("Worker calling identity uses the activity journal occurrence, not the provider call ID", async () => {
  let request: unknown;
  const handlers = createSubsessionToolHandlers({
    service: { delegateWorkerReviewed: async (value: unknown) => { request = value; } } as unknown as SubsessionDelegationService,
    parentSessionId: "steward", parentTurnId: "parent-turn", anchorMessageId: "message",
    modelRef: "model", reasoningEffort: "medium", parentAccessMode: "full_access",
  });
  const result = await handlers.delegate_to_worker!({ name: "delegate_to_worker", providerCallId: "provider-call", rawArguments: "{}",
    args: { action_key: "build", objective: "Implement", implementation_brief: "Keep API", acceptance_criteria: ["Works"] },
  }, { effectOccurrenceId: "journal-call" });
  expect(request).toMatchObject({ source_tool_call_id: "journal-call" });
  expect(result).toEqual({ ok: true, status: "queued" });
});

test("Worker projection carries the calling identity, real phase and approved Plan progress", () => {
  const snapshot: StewardObserverSnapshot = {
    session_id: "worker", title: "Implement", messages: [], result: null, updated_at: relation.created_at,
    turns: [{ id: "worker-turn", state: "admitted", created_at: relation.created_at, updated_at: relation.created_at }],
    progress_events: [{ id: "phase", session_id: "worker", turn_id: "worker-turn", session_sequence: 1,
      turn_sequence: 1, visibility: "public", kind: "assistant.public_note", created_at: relation.created_at,
      payload: { note: "구현 검토", activityStage: "review", workDecisionSource: "model-authored",
        workDecisionTitle: "구현 검토", workDecisionSummary: "구현 결과를 검토합니다.", semanticBlockId: "review" } }],
    plan: { plan_revision_id: "plan", revision: 1, approved: true,
      actions: [{ action_key: "build", description: "Build" }, { action_key: "review", description: "Review" }],
      action_progress: [{ action_key: "build", status: "done" }, { action_key: "review", status: "active" }] },
  };
  const presentation = { task_id: "task", objective: "Implement", source_tool_call_id: "call" };
  const active = projectStewardWorkerActivity(relation, snapshot, presentation);
  expect(active).toMatchObject({ source_tool_call_id: "call", parent_turn_id: "parent-turn",
    phase: "verifying", status_line: "검토 중", approved_plan_total: 2, approved_plan_completed: 1, terminal: false });
  snapshot.progress_events.push({ id: "read", session_id: "worker", turn_id: "worker-turn", session_sequence: 2,
    turn_sequence: 2, visibility: "public", kind: "tool.started", created_at: "2026-09-06T00:01:00Z",
    payload: { toolName: "read_file", toolCallId: "read-call", safeLabel: "읽기: routes.ts" } });
  expect(projectStewardWorkerActivity(relation, snapshot, presentation).current_activity_title).toBe("읽기: routes.ts");
  snapshot.result = { status: "failed", summary: "실행 중 오류", changed_artifacts: [], acceptance_evidence: [] } as unknown as NonNullable<StewardObserverSnapshot["result"]>;
  expect(projectStewardWorkerActivity(relation, snapshot, presentation)).toMatchObject({ phase: "failed", status_line: "실패", terminal: true });
  expect(projectStewardWorkerActivity(relation, null, presentation)).toMatchObject({ phase: "orienting", status_line: "구상 중" });
});

test("stored calling identity wins; old packets attach only to a unique exact successful invocation", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const packet = { parent_turn_id: "parent-turn", objective: "Implement", implementation_brief: "Keep current API",
    acceptance_criteria: ["Works"], plan_action: { action_key: "build" } };
  db.query(`INSERT INTO btcc_subsession_delegations
    (delegation_id, relation_id, task_id, child_turn_id, root_work_id, packet_json, created_at)
    VALUES ('delegation', 'relation', 'task', 'child', 'work', ?, 'now')`).run(JSON.stringify(packet));
  const add = (call: string, turn: string) => db.query(`INSERT INTO btcc_guided_tool_calls
    (turn_id, call_id, tool_name, raw_arguments, arguments_json, status, result_json, started_at)
    VALUES (?, ?, 'delegate_to_worker', '{}', ?, 'completed', '{"ok":true,"status":"queued"}', 'now')`)
    .run(turn, call, JSON.stringify({ ...packet, action_key: "build" }));
  add("correct-call", "parent-turn"); add("other-turn", "other-turn");
  const observer = new SqliteStewardObserverStore(db);
  expect(observer.delegationPresentation("relation")?.source_tool_call_id).toBe("correct-call");
  add("ambiguous-call", "parent-turn");
  expect(observer.delegationPresentation("relation")?.source_tool_call_id).toBeUndefined();
  db.query("UPDATE btcc_subsession_delegations SET packet_json = ?").run(JSON.stringify({ ...packet, source_tool_call_id: "correct-call" }));
  expect(observer.delegationPresentation("relation")?.source_tool_call_id).toBe("correct-call");
  db.close();
});
