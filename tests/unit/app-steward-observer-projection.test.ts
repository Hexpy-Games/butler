import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteStewardObserverStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/steward-observer-store.ts";
import {
  projectStewardActivityRows,
  projectStewardSession,
} from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";
import { sessionViewForStewardObserver } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer-view.ts";
import { projectStewardWorkerActivity } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer-worker.ts";
import { relabelWorkerActivities } from "../../packages/butler-agent/src/gateways/app/domain/workers/worker-activity-ordering.ts";

describe("App Steward observer projection", () => {
  test("merges one tool call's start and completion into one activity row", () => {
    const rows = projectStewardActivityRows({
      session_id: "steward-tool-merge",
      title: "Tool merge",
      turns: [{
        id: "turn-tool-merge",
        state: "delivered",
        created_at: "2026-09-02T00:00:00.000Z",
        updated_at: "2026-09-02T00:01:00.000Z",
      }],
      messages: [],
      progress_events: [{
        id: "tool-started",
        session_id: "steward-tool-merge",
        turn_id: "turn-tool-merge",
        session_sequence: 1,
        turn_sequence: 1,
        kind: "tool.started",
        visibility: "public",
        payload: {
          activityKind: "used_tool",
          safeLabel: "수정 상태와 diff 확인",
          toolName: "run_command",
          toolCallId: "tool-call-1",
          bridgePhase: "btcc_operation",
          state: "running",
        },
        created_at: "2026-09-02T00:00:30.000Z",
      }, {
        id: "tool-completed",
        session_id: "steward-tool-merge",
        turn_id: "turn-tool-merge",
        session_sequence: 2,
        turn_sequence: 2,
        kind: "tool.completed",
        visibility: "public",
        payload: {
          activityKind: "used_tool",
          safeLabel: "수정 상태와 diff 확인",
          toolName: "run_command",
          toolCallId: "tool-call-1",
          resultId: "tool-result-1",
          bridgePhase: "btcc_operation",
          state: "delivered",
        },
        created_at: "2026-09-02T00:01:00.000Z",
      }],
      plan: null,
      result: null,
      updated_at: "2026-09-02T00:01:00.000Z",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "delivered",
      tool_call_id: "tool-call-1",
      tool_result_id: "tool-result-1",
    });
  });

  test("projects a stored structured report instead of showing raw JSON", () => {
    const report = JSON.stringify({
      status: "success",
      version: 1,
      summary: "TurboQuant와 vLLM 호환성 조사를 완료했습니다.",
      changed_artifacts: ["research/qwen3.8-27b-awq-turboquant-vllm.md"],
    });
    const relation = {
      relation_id: "relation-report",
      parent_session_id: "parent-report",
      parent_turn_id: "parent-turn-report",
      child_session_id: "steward-report",
      anchor_message_id: "anchor-report",
      ordinal: 1,
      safe_title: "TurboQuant와 vLLM 호환성 조사",
      created_at: "2026-08-29T00:00:00.000Z",
    };
    const snapshot = {
      session_id: "steward-report",
      title: relation.safe_title,
      turns: [{
        id: "steward-turn-report",
        state: "delivered",
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:01:00.000Z",
      }],
      messages: [{
        id: "assistant-report",
        session_id: "steward-report",
        turn_id: "steward-turn-report",
        role: "assistant" as const,
        text: report,
        created_at: "2026-08-29T00:01:00.000Z",
        updated_at: "2026-08-29T00:01:00.000Z",
      }],
      progress_events: [],
      plan: null,
      result: {
        result_id: "result-report",
        relation_id: relation.relation_id,
        task_id: "task-report",
        child_session_id: "steward-report",
        child_turn_id: "steward-turn-report",
        status: "success" as const,
        code: null,
        summary: report,
        acceptance_evidence: [],
        changed_artifacts: [],
        changed_files: [{
          path: "src/steward.ts",
          additions: 1,
          deletions: 0,
          lines: [{ type: "added" as const, new_line: 1, content: "export {};" }],
        }],
        created_at: "2026-08-29T00:01:00.000Z",
      },
      updated_at: "2026-08-29T00:01:00.000Z",
    };

    const projection = projectStewardSession(relation, snapshot);
    const view = sessionViewForStewardObserver(relation, snapshot, 1);

    expect(projection.result?.summary).toBe(
      "TurboQuant와 vLLM 호환성 조사를 완료했습니다.",
    );
    expect(projection.result?.changed_artifacts).toEqual([
      "research/qwen3.8-27b-awq-turboquant-vllm.md",
    ]);
    expect(view.messages.at(-1)?.text).toBe(projection.result?.summary);
    expect(view.messages.at(-1)?.artifacts).toBeUndefined();
    expect(view.messages.at(-1)?.changed_files).toEqual([{
      path: "src/steward.ts",
      additions: 1,
      deletions: 0,
      lines: [{ type: "added", new_line: 1, content: "export {};" }],
    }]);
    expect(JSON.stringify(view)).not.toContain('"changed_artifacts"');
  });

  test("reads the durable relation, public activity, transcript, and result", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation-1", "parent-1", "parent-turn-1", "steward-1", "anchor-1", 1, "Review task", "2026-08-19T00:00:00.000Z");
    db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, revision, execution_fence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("steward-turn-1", "steward-1", "inbox-1", "trigger-1", "message-1", "Review", "snapshot-1", "{}", "{}", "admitted", 1, 0);
    db.query("INSERT INTO btcc_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("message-1", "steward-1", "steward-turn-1", "user", "Review the task", "message-key-1", "2026-08-19T00:01:00.000Z");
    db.query("INSERT INTO btcc_guided_works VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("work-1", "steward-1", "session", "steward-1", "steward-turn-1", "message-1", "Review", "open", "plan-1", "2026-08-19T00:01:00.000Z", "2026-08-19T00:02:00.000Z");
    db.query("INSERT INTO btcc_guided_work_plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("plan-1", "work-1", 3, "Review", "[]", JSON.stringify([
        { actionKey: "action-1", description: "Inspect the durable path", dependencyKeys: [] },
        { actionKey: "action-2", description: "Record the result", dependencyKeys: [] },
      ]), "[]", "steward-turn-1", "2026-08-19T00:01:00.000Z");
    db.query("INSERT INTO btcc_guided_work_review_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("review-1", "work-1", 1, "plan", "accept", "Plan accepted", "[]", "plan-1", null, null, null, "steward-turn-1", "2026-08-19T00:01:30.000Z");
    db.query("INSERT INTO btcc_guided_work_checkpoint_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("checkpoint-1", "work-1", 1, "plan-1", "execution", "Working", "Record the result", JSON.stringify([
        { actionKey: "action-1", status: "done" },
        { actionKey: "action-2", status: "active" },
      ]), 0, "steward-turn-1", "2026-08-19T00:02:30.000Z");
    db.query(`
      INSERT INTO btcc_progress_events (
        event_id, action_id, session_id, turn_id, session_sequence,
        turn_sequence, event_fingerprint, event_json, destination_json,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
    `).run(
      "event-1",
      "action-1",
      "steward-1",
      "steward-turn-1",
      1,
      1,
      "fingerprint-1",
      JSON.stringify({
        kind: "tool.progress",
        visibility: "public",
        payload: {
          activityKind: "todo",
          todoId: "work-1:action-1",
          safeLabel: "Inspecting the task",
          bridgePhase: "btcc_work_ledger",
          state: "running",
        },
      }),
      "{}",
      "2026-08-19T00:02:00.000Z",
    );
    db.query(`
      INSERT INTO btcc_progress_events (
        event_id, action_id, session_id, turn_id, session_sequence,
        turn_sequence, event_fingerprint, event_json, destination_json,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
    `).run(
      "event-public-note-1",
      "public-note-action-1",
      "steward-1",
      "steward-turn-1",
      1,
      2,
      "fingerprint-public-note-1",
      JSON.stringify({
        kind: "assistant.public_note",
        visibility: "public",
        payload: { note: "Steward child is validating the result" },
      }),
      "{}",
      "2026-08-19T00:02:30.000Z",
    );
    db.query(`
      INSERT INTO btcc_steward_results (
        result_id, relation_id, task_id, child_session_id, child_turn_id,
        status, code, summary, acceptance_evidence_json,
        changed_artifacts_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "result-1",
      "relation-1",
      "task-1",
      "steward-1",
      "steward-turn-1",
      "success",
      null,
      "Review complete",
      JSON.stringify(["Evidence recorded"]),
      JSON.stringify(["src/review.ts"]),
      "2026-08-19T00:03:00.000Z",
    );
    const observer = new SqliteStewardObserverStore(db);
    const snapshot = observer.snapshot("steward-1");
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.progress_events).toHaveLength(2);
    expect(snapshot?.plan?.approved).toBe(true);
    expect(snapshot?.plan?.revision).toBe(3);
    expect(snapshot?.result?.changed_artifacts).toEqual(["src/review.ts"]);
    expect(observer.relationsForParent("parent-1")[0]?.child_session_id).toBe("steward-1");

    const projection = projectStewardSession(
      observer.relationsForParent("parent-1")[0]!,
      snapshot!,
    );
    expect(projection.status).toBe("delivered");
    expect(projection.active_turn).toBeNull();
    expect(projection.artifacts).toEqual([]);
    expect(projection.changed_files).toEqual([]);
    expect(projection.activity_rows.find((row) => row.kind === "todo")?.safe_label)
      .toBe("Inspecting the task");
    expect(projection.activity_rows.find((row) => row.kind === "message")?.safe_label)
      .toBe("Steward child is validating the result");
    expect(projection.approved_plan_total).toBe(2);
    expect(projection.approved_plan_completed).toBe(1);
    const publicView = sessionViewForStewardObserver(
      observer.relationsForParent("parent-1")[0]!,
      snapshot!,
      2,
    );
    expect(publicView.messages.at(-1)?.text).toBe("Review complete");
    expect(publicView.messages.at(-1)?.turn_activity_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          safe_label: "Steward child is validating the result",
        }),
        expect.objectContaining({
          kind: "todo",
          safe_input_label: "action-1",
        }),
      ]),
    );
    db.close();
  });

  test("reads Worker changed files into the Steward message projection", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "relation-files",
        "parent-files",
        "parent-turn-files",
        "steward-files",
        "anchor-files",
        1,
        "Worker file changes",
        "2026-08-31T00:00:00.000Z",
      );
    db.query(`
      INSERT INTO btcc_steward_results (
        result_id, relation_id, task_id, child_session_id, child_turn_id,
        status, code, summary, acceptance_evidence_json,
        changed_artifacts_json, changed_files_json, commits_json, tests_json,
        remaining_risks_json, follow_up_recommendations_json, detail_refs_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "result-files",
      "relation-files",
      "task-files",
      "steward-files",
      "turn-files",
      "success",
      null,
      "Worker changes completed",
      "[]",
      "[]",
      JSON.stringify([{
        path: "src/worker-output.ts",
        additions: 2,
        deletions: 1,
        lines: [{ type: "added", new_line: 2, content: "worker output" }],
      }]),
      "[]",
      "[]",
      "[]",
      "[]",
      "[]",
      "2026-08-31T00:01:00.000Z",
    );

    const observer = new SqliteStewardObserverStore(db);
    const relation = observer.relationsForParent("parent-files")[0]!;
    const snapshot = observer.snapshot("steward-files")!;
    const view = sessionViewForStewardObserver(relation, snapshot, 0);

    expect(snapshot.result?.changed_files?.[0]?.path).toBe(
      "src/worker-output.ts",
    );
    expect(view.messages.at(-1)?.changed_files?.[0]?.path).toBe(
      "src/worker-output.ts",
    );
    db.close();
  });

  test("renders Butler direction and Steward activity in durable timeline order while waiting for Worker", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation-timeline", "parent-timeline", "parent-turn", "steward-timeline",
        "anchor-timeline", 1, "Timeline task", "2026-08-30T00:00:00.000Z");
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation-worker", "steward-timeline", "steward-turn-1", "worker-timeline",
        "worker-anchor", 1, "Worker task", "2026-08-30T00:01:30.000Z");
    db.query(`INSERT INTO btcc_subsession_delegations
      (delegation_id, relation_id, task_id, child_turn_id, root_work_id,
       packet_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("delegation-timeline", "relation-timeline", "task-timeline",
        "steward-turn-1", "work-timeline",
        JSON.stringify({ objective: "Butler가 작성한 원래 요청" }),
        "2026-08-30T00:00:00.000Z");
    db.query(`INSERT INTO btcc_subsession_delegations
      (delegation_id, relation_id, task_id, child_turn_id, root_work_id,
       packet_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("delegation-worker", "relation-worker", "task-worker",
        "worker-turn-1", "worker-work-1", JSON.stringify({
          objective: "운영 배포 기준 확인",
        }), "2026-08-30T00:01:30.000Z");
    for (const [turnId, messageId, state] of [
      ["steward-turn-1", "steward-message:delegation-timeline", "delivered"],
      ["steward-turn-2", "subsession-direction-message:direction-timeline", "delivered"],
    ]) {
      db.query(`INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, revision, execution_fence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(turnId, "steward-timeline", `inbox-${turnId}`, `trigger-${turnId}`,
          messageId, "internal", `snapshot-${turnId}`, "{}", "{}", state, 1, 0);
    }
    db.query("INSERT INTO btcc_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("assistant-first", "steward-timeline", "steward-turn-1", "assistant",
        "첫 번째 스튜어드 응답", "assistant-first-key", "2026-08-30T00:01:00.000Z");
    db.query("INSERT INTO btcc_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("worker-result-message:private", "steward-timeline", "steward-turn-2", "user",
        "raw Worker transport", "worker-result-key", "2026-08-30T00:02:30.000Z");
    db.query("INSERT INTO btcc_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("assistant-second", "steward-timeline", "steward-turn-2", "assistant",
        "방향을 반영한 스튜어드 응답", "assistant-second-key", "2026-08-30T00:03:00.000Z");
    db.query(`INSERT INTO btcc_subsession_directions (
      instruction_id, relation_id, revision, source_parent_turn_id,
      source_message_id, instruction, status, created_at, applied_at,
      applied_child_turn_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("direction-timeline", "relation-timeline", 1, "parent-direction-turn",
        "parent-direction-message", "버틀러의 추가 지시", "applied",
        "2026-08-30T00:02:00.000Z", "2026-08-30T00:02:01.000Z", "steward-turn-2");
    for (const [eventId, turnId, label, sequence] of [
      ["event-first", "steward-turn-1", "첫 번째 활동", 1],
      ["event-second", "steward-turn-2", "두 번째 활동", 2],
    ]) {
      db.query(`INSERT INTO btcc_progress_events (
        event_id, action_id, session_id, turn_id, session_sequence,
        turn_sequence, event_fingerprint, event_json, destination_json,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`)
        .run(eventId, eventId, "steward-timeline", turnId, sequence, 1,
          `fingerprint-${eventId}`, JSON.stringify({
            kind: "assistant.public_note",
            visibility: "public",
            payload: { note: label },
          }), "{}", `2026-08-30T00:0${sequence}:30.000Z`);
    }

    const observer = new SqliteStewardObserverStore(db);
    const relation = observer.relationsForParent("parent-timeline")[0]!;
    const snapshot = observer.snapshot("steward-timeline")!;
    const workerRelation = observer.relationsForParent("steward-timeline")[0]!;
    const worker = relabelWorkerActivities([projectStewardWorkerActivity(
      workerRelation,
      observer.snapshot(workerRelation.child_session_id),
      observer.delegationPresentation(workerRelation.relation_id),
    )])[0]!;
    const view = sessionViewForStewardObserver(relation, snapshot, 2, [worker]);
    expect(view.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Butler가 작성한 원래 요청"],
      ["assistant", "첫 번째 스튜어드 응답"],
      ["user", "버틀러의 추가 지시"],
      ["assistant", "방향을 반영한 스튜어드 응답"],
    ]);
    expect(view.messages[1]?.turn_activity_rows?.[0]?.safe_label).toBe("첫 번째 활동");
    expect(view.messages[3]?.turn_activity_rows?.[0]?.safe_label).toBe("두 번째 활동");
    expect(view.status).toBe("active");
    expect(view.active_turn).toBeNull();
    expect(view.latest_turn?.state).toBe("delivered");
    expect(view.waiting_for_children).toBe(true);
    expect(view.workers).toEqual([expect.objectContaining({
      worker_display_name: "Kai",
      worker_ordinal_label: "Worker 1",
      objective: "운영 배포 기준 확인",
      phase: "executing",
      terminal: false,
    })]);
    expect(JSON.stringify(view)).not.toContain("raw Worker transport");
    db.close();
  });

  test("does not expose internal BTCC activity", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation-2", "parent-2", "parent-turn-2", "steward-2", "anchor-2", 1, "Private task", "2026-08-19T00:00:00.000Z");
    db.query(`
      INSERT INTO btcc_progress_events (
        event_id, action_id, session_id, turn_id, session_sequence,
        turn_sequence, event_fingerprint, event_json, destination_json,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
    `).run(
      "event-2",
      "action-2",
      "steward-2",
      "turn-2",
      1,
      1,
      "fingerprint-2",
      JSON.stringify({ kind: "tool.progress", visibility: "internal", payload: {} }),
      "{}",
      "2026-08-19T00:02:00.000Z",
    );
    const snapshot = new SqliteStewardObserverStore(db).snapshot("steward-2");
    db.query("INSERT INTO btcc_subsession_delegations VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "delegation-2",
        "relation-2",
        "task-2",
        "turn-2",
        JSON.stringify({ privatePrompt: "do not expose" }),
        "2026-08-19T00:02:30.000Z",
        "2026-08-19T00:02:30.000Z",
      );
    expect(snapshot?.progress_events).toHaveLength(1);
    const publicView = sessionViewForStewardObserver(
      new SqliteStewardObserverStore(db).relationsForParent("parent-2")[0]!,
      snapshot!,
      1,
    );
    expect(publicView.messages).toEqual([]);
    expect(publicView.relation?.safe_title).toBe("Private task");
    expect(JSON.stringify(publicView)).not.toContain("do not expose");
    expect(projectStewardSession(
      new SqliteStewardObserverStore(db).relationsForParent("parent-2")[0]!,
      snapshot!,
    ).activity_rows).toEqual([]);
    db.close();
  });

  test("projects legacy Steward-only failures from the common BTCC terminal state", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation-legacy", "parent-legacy", "parent-turn-legacy", "steward-legacy", "anchor-legacy", 1, "Legacy child", "2026-08-21T00:00:00.000Z");
    db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, final_payload_json,
        canonical_assistant_message_id, revision, execution_fence,
        final_disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "steward-turn-legacy", "steward-legacy", "inbox-legacy", "trigger-legacy",
      "message-legacy", "Review", "snapshot-legacy", "{}", "{}", "delivered",
      JSON.stringify({
        content: JSON.stringify({
          status: "success",
          summary: { title: "Recovered common BTCC result" },
        }),
      }),
      "assistant-legacy", 1, 0, "completed",
    );
    db.query("INSERT INTO btcc_guided_works VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("work-legacy", "steward-legacy", "session", "steward-legacy", "steward-turn-legacy", "message-legacy", "Review", "completed", null, "2026-08-21T00:00:00.000Z", "2026-08-21T00:01:00.000Z");
    db.query("INSERT INTO btcc_guided_turn_work_bindings VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("binding-legacy", "steward-turn-legacy", "steward-legacy", "work-legacy", 1, 1, "2026-08-21T00:00:00.000Z");
    db.query(`
      INSERT INTO btcc_steward_results (
        result_id, relation_id, task_id, child_session_id, child_turn_id,
        status, code, summary, acceptance_evidence_json,
        changed_artifacts_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "result-legacy", "relation-legacy", "task-legacy", "steward-legacy",
      "steward-turn-legacy", "failed", "steward_execution_failed",
      "Steward could not complete the bounded task.", "[]", "[]",
      "2026-08-21T00:02:00.000Z",
    );

    const observer = new SqliteStewardObserverStore(db);
    const snapshot = observer.snapshot("steward-legacy");
    expect(snapshot?.result).toMatchObject({
      status: "success",
      code: null,
      summary: "Recovered common BTCC result",
    });
    expect(JSON.stringify(sessionViewForStewardObserver(
      observer.relationsForParent("parent-legacy")[0]!, snapshot!, 0,
    ))).not.toContain("Steward could not complete the bounded task.");
    db.close();
  });

  test("relation-only observer projection is safe when no child snapshot exists", () => {
    const relation = {
      relation_id: "relation-only",
      parent_session_id: "parent-only",
      parent_turn_id: "parent-turn-only",
      child_session_id: "steward-only",
      anchor_message_id: "anchor-only",
      ordinal: 1,
      safe_title: "Pending child",
      created_at: "2026-08-19T00:00:00.000Z",
    };
    const view = sessionViewForStewardObserver(relation, null, 0);
    expect(view.session_id).toBe("steward-only");
    expect(view.relation).toEqual(relation);
    expect(view.messages).toEqual([]);
    expect(view.active_turn).toBeNull();
    expect(view.cursors.messages).toBe(0);
    expect(JSON.stringify(view)).not.toContain("DelegationPacket");
  });

  test("n/j uses the accepted current Plan and durable done or skipped actions", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation-plan", "parent-plan", "parent-turn-plan", "steward-plan", "anchor-plan", 1, "Plan child", "2026-08-19T00:00:00.000Z");
    db.query("INSERT INTO btcc_guided_works VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("work-plan", "steward-plan", "session", "steward-plan", "turn-plan", "message-plan", "Plan", "open", "plan-current", "2026-08-19T00:01:00.000Z", "2026-08-19T00:02:00.000Z");
    db.query("INSERT INTO btcc_guided_work_plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("plan-current", "work-plan", 7, "Plan", "[]", JSON.stringify([
        { actionKey: "a1", description: "First", dependencyKeys: [] },
        { actionKey: "a2", description: "Second", dependencyKeys: [] },
        { actionKey: "a3", description: "Third", dependencyKeys: [] },
      ]), "[]", "turn-plan", "2026-08-19T00:01:00.000Z");
    db.query("INSERT INTO btcc_guided_work_review_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("review-plan", "work-plan", 1, "plan", "accept", "Accepted", "[]", "plan-current", null, null, null, "turn-plan", "2026-08-19T00:01:30.000Z");
    db.query("INSERT INTO btcc_guided_work_checkpoint_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("checkpoint-plan", "work-plan", 1, "plan-current", "execution", "Working", "Third", JSON.stringify([
        { actionKey: "a1", status: "done" },
        { actionKey: "a2", status: "skipped" },
        { actionKey: "a3", status: "pending" },
      ]), 0, "turn-plan", "2026-08-19T00:02:30.000Z");
    const observer = new SqliteStewardObserverStore(db);
    const snapshot = observer.snapshot("steward-plan");
    const projection = projectStewardSession(
      observer.relationsForParent("parent-plan")[0]!,
      snapshot!,
    );
    expect(snapshot?.plan?.approved).toBe(true);
    expect(projection.approved_plan_revision).toBe(7);
    expect(projection.approved_plan_total).toBe(3);
    expect(projection.approved_plan_completed).toBe(2);
    expect(projection.activity_rows.map((row) => row.state)).toEqual([
      "completed",
      "skipped",
      "pending",
    ]);
    db.close();
  });

  test("active Turn summary uses current activity instead of the appended Plan tail", () => {
    const relation = {
      relation_id: "relation-current-activity",
      parent_session_id: "parent-current-activity",
      parent_turn_id: "parent-turn-current-activity",
      child_session_id: "steward-current-activity",
      anchor_message_id: "anchor-current-activity",
      ordinal: 1,
      safe_title: "Current activity child",
      created_at: "2026-08-19T00:00:00.000Z",
    };
    const projection = projectStewardSession(relation, {
      session_id: relation.child_session_id,
      title: relation.safe_title,
      turns: [{
        id: "turn-current-activity",
        state: "thinking",
        created_at: "2026-08-19T00:01:00.000Z",
        updated_at: "2026-08-19T00:02:00.000Z",
      }],
      messages: [],
      progress_events: [{
        id: "event-current-activity",
        session_id: relation.child_session_id,
        turn_id: "turn-current-activity",
        session_sequence: 1,
        turn_sequence: 1,
        kind: "assistant.public_note",
        visibility: "public",
        payload: { note: "Validating the current implementation" },
        created_at: "2026-08-19T00:02:00.000Z",
      }],
      plan: {
        plan_revision_id: "plan-current-activity",
        revision: 1,
        actions: [{
          action_key: "inspect",
          description: "Inspect the implementation",
        }, {
          action_key: "report",
          description: "Report the result",
        }],
        action_progress: [{ action_key: "inspect", status: "active" }],
        approved: true,
      },
      result: null,
      updated_at: "2026-08-19T00:02:00.000Z",
    });

    expect(projection.active_turn?.progress.summary)
      .toBe("Validating the current implementation");
    expect(projection.approved_plan_total).toBe(2);
    expect(projection.approved_plan_completed).toBe(0);
  });

  test("generic model waiting does not replace the latest substantive activity summary", () => {
    const relation = {
      relation_id: "relation-substantive-activity",
      parent_session_id: "parent-substantive-activity",
      parent_turn_id: "parent-turn-substantive-activity",
      child_session_id: "steward-substantive-activity",
      anchor_message_id: "anchor-substantive-activity",
      ordinal: 1,
      safe_title: "Substantive activity child",
      created_at: "2026-08-22T08:00:00.000Z",
    };
    const projection = projectStewardSession(relation, {
      session_id: relation.child_session_id,
      title: relation.safe_title,
      turns: [{
        id: "turn-substantive-activity",
        state: "thinking",
        created_at: "2026-08-22T08:01:00.000Z",
        updated_at: "2026-08-22T08:02:00.000Z",
      }],
      messages: [],
      progress_events: [{
        id: "event-project-records",
        session_id: relation.child_session_id,
        turn_id: "turn-substantive-activity",
        session_sequence: 1,
        turn_sequence: 1,
        kind: "tool.completed",
        visibility: "public",
        payload: {
          activityKind: "used_tool",
          safeLabel: "프로젝트 기록 확인",
          safeToolName: "project_ledger_list",
          toolCallId: "project-records",
          bridgePhase: "btcc_operation",
          state: "delivered",
        },
        created_at: "2026-08-22T08:01:30.000Z",
      }, {
        id: "event-next-model-round",
        session_id: relation.child_session_id,
        turn_id: "turn-substantive-activity",
        session_sequence: 2,
        turn_sequence: 2,
        kind: "tool.started",
        visibility: "public",
        payload: {
          activityKind: "message",
          safeLabel: "응답 생성 중",
          safeToolName: "model_round",
          toolCallId: "model-round-next",
          bridgePhase: "model_round_waiting",
          state: "running",
        },
        created_at: "2026-08-22T08:02:00.000Z",
      }, {
        id: "event-model-phase",
        session_id: relation.child_session_id,
        turn_id: "turn-substantive-activity",
        session_sequence: 3,
        turn_sequence: 3,
        kind: "assistant.public_note",
        visibility: "public",
        payload: {
          note: "실행 결과를 검토하고 있습니다",
          decisionSummary: "실행 결과를 검토하고 있습니다",
          decisionSource: "model-authored",
          activityStage: "review",
          state: "running",
        },
        created_at: "2026-08-22T08:03:00.000Z",
      }],
      plan: null,
      result: null,
      updated_at: "2026-08-22T08:02:00.000Z",
    });

    expect(projection.active_turn?.progress.summary).toBe("프로젝트 기록 확인");
    expect(projection.active_turn?.updated_at).toBe("2026-08-22T08:03:00.000Z");
    expect(projection.active_turn?.progress.updated_at).toBe("2026-08-22T08:03:00.000Z");
  });

  test("absent Plan approval does not fabricate n/j", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation-unapproved", "parent-unapproved", "parent-turn-unapproved", "steward-unapproved", "anchor-unapproved", 1, "Unapproved child", "2026-08-19T00:00:00.000Z");
    db.query("INSERT INTO btcc_guided_works VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("work-unapproved", "steward-unapproved", "session", "steward-unapproved", "turn-unapproved", "message-unapproved", "Plan", "completed", "plan-unapproved", "2026-08-19T00:01:00.000Z", "2026-08-19T00:02:00.000Z");
    db.query("INSERT INTO btcc_guided_work_plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("plan-unapproved", "work-unapproved", 2, "Plan", "[]", JSON.stringify([
        { actionKey: "a1", description: "First", dependencyKeys: [] },
      ]), "[]", "turn-unapproved", "2026-08-19T00:01:00.000Z");
    const observer = new SqliteStewardObserverStore(db);
    const projection = projectStewardSession(
      observer.relationsForParent("parent-unapproved")[0]!,
      observer.snapshot("steward-unapproved")!,
    );
    expect(projection.approved_plan_total).toBeUndefined();
    expect(projection.approved_plan_completed).toBeUndefined();
    db.close();
  });

  test("does not duplicate a terminal result already represented by the child assistant", () => {
    const relation = {
      relation_id: "relation-3",
      parent_session_id: "parent-3",
      parent_turn_id: "parent-turn-3",
      child_session_id: "steward-3",
      anchor_message_id: "anchor-3",
      ordinal: 1,
      safe_title: "Terminal child",
      created_at: "2026-08-19T00:00:00.000Z",
    };
    const view = sessionViewForStewardObserver(relation, {
      session_id: "steward-3",
      title: "Terminal child",
      turns: [{
        id: "turn-3",
        state: "delivered",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:03:00.000Z",
      }],
      messages: [{
        id: "user-3",
        session_id: "steward-3",
        turn_id: "turn-3",
        role: "user",
        text: "RAW_TOOL_PAYLOAD:{\"secret\":true} credential=sk-test-123 /private/project/file.ts",
        created_at: "2026-08-19T00:01:00.000Z",
        updated_at: "2026-08-19T00:01:00.000Z",
      }, {
        id: "assistant-3",
        session_id: "steward-3",
        turn_id: "turn-3",
        role: "assistant",
        text: "hidden reasoning: inspect raw tool payload before reporting",
        created_at: "2026-08-19T00:02:00.000Z",
        updated_at: "2026-08-19T00:02:00.000Z",
      }],
      progress_events: [{
        id: "event-3",
        session_id: "steward-3",
        turn_id: "turn-3",
        session_sequence: 1,
        turn_sequence: 1,
        kind: "assistant.public_note",
        visibility: "public",
        payload: { note: "Finished" },
        created_at: "2026-08-19T00:03:00.000Z",
      }],
      plan: null,
      result: {
        result_id: "result-3",
        relation_id: "relation-3",
        task_id: "task-3",
        child_session_id: "steward-3",
        child_turn_id: "turn-3",
        status: "success",
        code: null,
        summary: "Completed",
        acceptance_evidence: ["Evidence"],
        changed_artifacts: ["src/result.ts"],
        created_at: "2026-08-19T00:04:00.000Z",
      },
      updated_at: "2026-08-19T00:04:00.000Z",
    }, 1);
    expect(view.messages.map((message) => message.id)).toEqual([
      "user-3",
      "assistant-3",
    ]);
    const publicViewJson = JSON.stringify(view);
    expect(publicViewJson).not.toMatch(/RAW_TOOL_PAYLOAD|sk-test-123|\/private\/project\/file\.ts|hidden reasoning/iu);
    expect(view.messages[0]?.text).toBe("Terminal child");
    expect(view.messages[1]?.text).toBe("Completed");
    expect(view.messages.at(-1)?.text).toBe("Completed");
    expect(view.messages.at(-1)?.artifacts).toBeUndefined();
    expect(view.messages.filter((message) => message.turn_activity_rows?.length))
      .toHaveLength(1);
    expect(view.message_window.complete).toBe(true);
  });

  test("keeps earlier Steward messages delivered when the terminal result fails", () => {
    const relation = {
      relation_id: "relation-failed",
      parent_session_id: "parent-failed",
      parent_turn_id: "parent-turn-failed",
      child_session_id: "steward-failed",
      anchor_message_id: "anchor-failed",
      ordinal: 1,
      safe_title: "Failed child",
      created_at: "2026-08-31T00:00:00.000Z",
    };
    const view = sessionViewForStewardObserver(relation, {
      session_id: relation.child_session_id,
      title: relation.safe_title,
      turns: [{
        id: "turn-progress",
        state: "delivered",
        created_at: "2026-08-31T00:00:00.000Z",
        updated_at: "2026-08-31T00:01:00.000Z",
      }, {
        id: "turn-failed",
        state: "failed",
        created_at: "2026-08-31T00:00:00.000Z",
        updated_at: "2026-08-31T00:02:00.000Z",
      }],
      messages: [{
        id: "assistant-progress",
        session_id: relation.child_session_id,
        turn_id: "turn-progress",
        role: "assistant",
        text: "Worker 작업을 시작했습니다.",
        created_at: "2026-08-31T00:01:00.000Z",
        updated_at: "2026-08-31T00:01:00.000Z",
      }, {
        id: "assistant-terminal",
        session_id: relation.child_session_id,
        turn_id: "turn-failed",
        role: "assistant",
        text: "raw terminal text",
        created_at: "2026-08-31T00:02:00.000Z",
        updated_at: "2026-08-31T00:02:00.000Z",
      }],
      progress_events: [],
      plan: null,
      result: {
        result_id: "result-failed",
        relation_id: relation.relation_id,
        task_id: "task-failed",
        child_session_id: relation.child_session_id,
        child_turn_id: "turn-failed",
        status: "failed",
        code: "steward_execution_failed",
        summary: "완료하지 못했지만 확인한 내용입니다.",
        acceptance_evidence: [],
        changed_artifacts: [],
        created_at: "2026-08-31T00:02:00.000Z",
      },
      updated_at: "2026-08-31T00:02:00.000Z",
    }, 1);

    expect(view.messages.map((message) => [message.text, message.status]))
      .toEqual([
        ["Worker 작업을 시작했습니다.", "delivered"],
        ["완료하지 못했지만 확인한 내용입니다.", "failed"],
      ]);
    expect(view.messages.every((message) => !message.safe_error_code)).toBe(true);
  });
});
