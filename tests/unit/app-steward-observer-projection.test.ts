import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteStewardObserverStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/steward-observer-store.ts";
import { projectStewardSession } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";
import { sessionViewForStewardObserver } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer-view.ts";

describe("App Steward observer projection", () => {
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
    expect(projection.artifacts[0]?.safe_path_label).toBe("src/review.ts");
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
      }],
      plan: null,
      result: null,
      updated_at: "2026-08-22T08:02:00.000Z",
    });

    expect(projection.active_turn?.progress.summary).toBe("프로젝트 기록 확인");
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
    expect(view.messages.at(-1)?.artifacts?.[0]?.id).toBe("result-3:artifact:0");
    expect(view.messages.filter((message) => message.turn_activity_rows?.length))
      .toHaveLength(1);
    expect(view.message_window.complete).toBe(true);
  });
});
