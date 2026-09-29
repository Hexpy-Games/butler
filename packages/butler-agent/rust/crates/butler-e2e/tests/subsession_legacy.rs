//! Delegations written before subsession packets were typed still read.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::{Value, json};

/// SUB-LEGACY-01 — a session whose delegations predate the typed packet
/// (no `child_role`/`access_mode`, `routingHints.stewardId`, no envelope
/// `role`, a NULL dispatch intent, no reviewed parent Work) and one row that
/// cannot be decoded at all: the agent starts, `/session-view`,
/// `/session-summary`, `/context-details` and `/worker-activity` answer 200,
/// the legacy children appear with their roles and the context details are
/// real. An undecodable row that was still pending is closed as failed.
#[tokio::test]
async fn sub_legacy_01_pre_typed_delegations_are_read() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SUB-LEGACY-01")?.start().await?;
    let created = s.gw.post("/sessions", json!({"kind": "chat"})).await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let session = &created.data()["session"];
    let chat = session["id"].as_str().unwrap().to_owned();
    let hint = session["session_hint"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    seed_legacy_delegations(&s, &hint);
    seed_stuck_handoff_message(&s, &chat);
    s.gw = s.agent.start_again().await?;

    let view =
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?;
    assert_eq!(view.status, 200, "{}", view.text);
    let summary =
        s.gw.get(&format!("/session-summary?session_id={chat}"))
            .await?;
    assert_eq!(summary.status, 200, "{}", summary.text);
    let context =
        s.gw.get(&format!("/context-details?session_id={chat}"))
            .await?;
    assert_eq!(context.status, 200, "{}", context.text);

    assert_handoff_message_is_final(view.data());
    assert_branch_from_handoff_message(&s, &chat).await?;

    for (stewards, workers) in [
        (&view.data()["steward_children"], &view.data()["workers"]),
        (
            &summary.data()["steward_children"],
            &summary.data()["worker_activity"],
        ),
    ] {
        assert_eq!(
            children(stewards, "session_id"),
            ["steward-legacy-a", "steward-legacy-b", "steward-legacy-f"]
        );
        assert_eq!(children(workers, "session_id"), ["worker-legacy-c"]);
        assert_steward_turn_shape(stewards);
    }
    for details in [
        &view.data()["context"],
        &summary.data()["context_details"],
        context.data(),
    ] {
        assert_context_details(details, &chat);
    }

    let activity = s.gw.get("/worker-activity?include_history=true").await?;
    assert_eq!(activity.status, 200, "{}", activity.text);
    let mut ids = children(&activity.data()["workers"], "worker_id");
    ids.sort_unstable();
    assert_eq!(
        ids,
        [
            "steward-relation-b",
            "steward-relation-f",
            "steward-task-a",
            "worker-relation-c"
        ],
        "{}",
        activity.text
    );

    s.agent.terminate().await?;
    assert_unreadable_pending_row_closed(&s);
    s.finish().await
}

/// The `key` strings of a projected list, in order.
fn children<'a>(list: &'a Value, key: &str) -> Vec<&'a str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|child| child[key].as_str().unwrap())
        .collect()
}

/// Context details of the session: its own id, a model budget and categories.
fn assert_context_details(details: &Value, chat: &str) {
    assert_eq!(details["session_id"], chat, "{details}");
    assert!(details["budget_tokens"].as_u64().unwrap() > 0, "{details}");
    assert!(details["used_tokens"].is_u64(), "{details}");
    assert!(
        matches!(details["status"].as_str(), Some("low" | "medium" | "high")),
        "{details}"
    );
    assert!(
        !details["categories"].as_array().unwrap().is_empty(),
        "{details}"
    );
}

/// The unreadable pending delegation `e` is failed and no longer pending, so
/// its parent does not wait for it.
fn assert_unreadable_pending_row_closed(s: &Scenario) {
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let closed: (String, Option<String>) = db
        .query_row(
            "SELECT x.status, d.dispatch_state FROM btcc_steward_results x JOIN btcc_subsession_delegations d ON d.relation_id = x.relation_id WHERE x.relation_id = 'relation-e'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the unreadable pending delegation is closed");
    assert_eq!(closed, ("failed".to_owned(), None));
}

/// Five delegations of the parent session `hint` in the shapes the runtime
/// store held before the packet was typed. All values are made up.
fn seed_legacy_delegations(s: &Scenario, hint: &str) {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let rows = [
        // Steward, NULL dispatch intent, no reviewed parent Work.
        (
            "a",
            "steward-legacy-a",
            legacy_packet("a", hint, false),
            None,
        ),
        // Steward with an enqueued envelope naming `stewardId`, no role.
        (
            "b",
            "steward-legacy-b",
            legacy_packet("b", hint, true),
            Some(legacy_intent("steward-legacy-b")),
        ),
        // Worker (role inferred from the session id), NULL dispatch intent.
        ("c", "worker-legacy-c", legacy_packet("c", hint, true), None),
        // A packet no version could decode: skipped, not fatal.
        ("d", "steward-legacy-d", json!({"unexpected": true}), None),
        // The same, still waiting to be dispatched.
        ("e", "steward-legacy-e", json!({"unexpected": true}), None),
        // Steward whose turn stayed finalizing past its grace without a result.
        (
            "f",
            "steward-legacy-f",
            legacy_packet("f", hint, true),
            None,
        ),
    ];
    seed_child_turn(&db, "a", "steward-legacy-a", "delivered");
    seed_child_turn(&db, "b", "steward-legacy-b", "admitted");
    seed_child_turn(&db, "f", "steward-legacy-f", "delivery_committed");
    for (ordinal, (key, child, packet, intent)) in (1_i64..).zip(rows) {
        db.execute(
            "INSERT INTO btcc_session_relations (relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES (?1,?2,'turn-legacy',?3,'message-legacy',?4,'Legacy task','2026-01-01T00:00:00.000Z')",
            rusqlite::params![format!("relation-{key}"), hint, child, ordinal],
        )
        .unwrap();
        db.execute(
            "INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'2026-01-01T00:00:00.000Z')",
            rusqlite::params![
                format!("delegation-{key}"),
                format!("relation-{key}"),
                format!("task-{key}"),
                format!("child-turn-{key}"),
                format!("work-{key}"),
                packet.to_string(),
                intent.as_ref().map(Value::to_string),
                match (key, &intent) {
                    ("e", _) => Some("pending"),
                    (_, Some(_)) => Some("enqueued"),
                    _ => None,
                },
            ],
        )
        .unwrap();
    }
    seed_finished_steward(&db);
}

/// Steward `a` finished successfully; `b` still runs its admitted turn.
fn seed_finished_steward(db: &rusqlite::Connection) {
    db.execute(
        "INSERT INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES ('result-a','relation-a','task-a','steward-legacy-a','child-turn-a','success','Made-up summary','[]','[]','2026-01-01T00:00:03.000Z')",
        [],
    )
    .unwrap();
}

/// A packet as written before `child_role`, `access_mode` and (for the first
/// steward) the reviewed parent Work were recorded.
fn legacy_packet(key: &str, parent: &str, with_work: bool) -> Value {
    let mut packet = json!({
        "delegation_id": format!("delegation-{key}"),
        "task_id": format!("task-{key}"),
        "relation_id": format!("relation-{key}"),
        "parent_session_id": parent,
        "parent_turn_id": "turn-legacy",
        "objective": "Made-up legacy objective",
        "acceptance_criteria": ["made-up check"],
        "task_or_plan_refs": [],
        "constraints_and_non_goals": [],
        "allowed_tools_and_effects": ["read_file:workspace"],
        "mutation_scope": [],
        "execution_mode": "read_only",
        "access_and_budget_policy": {
            "access_mode": "read_only", "max_turns": 8,
            "model_ref": "provider/model", "reasoning_effort": "medium"
        },
        "work_creation_policy": "forbidden",
        "model_ref": "provider/model",
        "reasoning_effort": "medium",
    });
    if with_work {
        packet["parent_work_ref"] = json!({
            "work_id": "work-legacy", "session_id": parent, "turn_id": "turn-legacy",
            "plan_revision_id": "plan-legacy", "review_revision_id": "review-legacy"
        });
    }
    packet
}

/// A dispatch intent as written when only stewards were dispatched.
fn legacy_intent(child: &str) -> Value {
    json!({
        "envelope": {
            "eventId": "event-legacy", "transport": "app", "accountId": "local",
            "peer": {"kind": "dm", "id": child, "parentId": "parent-legacy"},
            "sender": {"id": "butler-steward-dispatch", "displayName": "Butler Steward"},
            "message": {"id": "message-legacy", "text": "made up", "timestamp": "2026-01-01T00:00:00.000Z"},
            "routingHints": {"stewardId": child, "turnId": "child-turn-b"},
            "nativeStewardContext": {
                "version": 1, "projectName": "", "workspacePath": "/tmp/legacy",
                "modelRef": "provider/model", "reasoningEffort": "medium"
            },
            "raw": {"source": "btcc-subsession-delegation"}
        },
        "metadata": {"source": "btcc-subsession"},
        "childBinding": {"role": "steward"}
    })
}

/// One BTCC turn of a made-up child, in the given semantic state.
fn seed_child_turn(db: &rusqlite::Connection, key: &str, child: &str, state: &str) {
    db.execute(
        "INSERT INTO btcc_inbound_inbox (inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES (?1,?2,?3,?4,'hash-legacy','{}','admitted')",
        rusqlite::params![
            format!("inbox-{key}"),
            child,
            format!("trigger-{key}"),
            format!("child-turn-{key}")
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO btcc_turns (turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES (?1,?2,?3,?4,'message-legacy','made up','snapshot-legacy','{}','{}',?5,1,1)",
        rusqlite::params![
            format!("child-turn-{key}"),
            child,
            format!("inbox-{key}"),
            format!("trigger-{key}"),
            state
        ],
    )
    .unwrap();
}

/// The turn shape the UI relies on: every Steward child carries a `latest_turn`
/// with `progress.safe_progress_rows`, delivery and control flags, the child
/// list fields and an App `status`; only a live child has an `active_turn`.
fn assert_steward_turn_shape(stewards: &Value) {
    let list = stewards.as_array().unwrap();
    for child in list {
        for field in ["activity_rows", "artifacts", "changed_files"] {
            assert!(child[field].is_array(), "{field}: {child}");
        }
        let turn = &child["latest_turn"];
        assert!(turn["id"].is_string(), "{child}");
        let progress = &turn["progress"];
        assert!(progress["safe_progress_rows"].is_array(), "{child}");
        assert_eq!(progress["turn_id"], turn["id"], "{child}");
        assert_eq!(progress["state"], turn["state"], "{child}");
        for field in ["limitations", "limitation_codes"] {
            assert!(turn[field].is_array(), "{field}: {child}");
        }
        for field in ["cancellable", "retryable"] {
            assert!(turn[field].is_boolean(), "{field}: {child}");
        }
        assert!(turn["delivery_state"].is_string(), "{child}");
    }
    let done = &list[0];
    assert_eq!(done["status"], "delivered", "{done}");
    assert_eq!(done["terminal"], true, "{done}");
    assert_eq!(done["latest_turn"]["state"], "delivered", "{done}");
    assert_eq!(done["latest_turn"]["cancellable"], false, "{done}");
    assert!(done["active_turn"].is_null(), "{done}");
    let live = &list[1];
    assert_eq!(live["status"], "active", "{live}");
    assert_eq!(live["latest_turn"]["state"], "thinking", "{live}");
    assert_eq!(live["latest_turn"]["cancellable"], true, "{live}");
    assert_eq!(live["active_turn"], live["latest_turn"], "{live}");
    // A finalizing turn older than its grace is an orphan, not active work.
    let orphan = &list[2];
    assert_eq!(orphan["status"], "failed", "{orphan}");
    assert_eq!(orphan["terminal"], true, "{orphan}");
    assert_eq!(orphan["result_missing"], true, "{orphan}");
    assert_eq!(orphan["latest_turn"]["state"], "streaming", "{orphan}");
    assert!(orphan["active_turn"].is_null(), "{orphan}");
}

/// A hand-off turn as older builds left it: the turn is delivered but its
/// provisional assistant message is still `streaming`.
fn seed_stuck_handoff_message(s: &Scenario, chat: &str) {
    let db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute(
        "INSERT INTO turns (id,chat_id,state,safe_status_label,retryable,cancellable,created_at,updated_at) VALUES ('turn-handoff',?1,'delivered','Delivered',0,0,'2026-01-01T00:00:01.000Z','2026-01-01T00:00:02.000Z')",
        [chat],
    )
    .unwrap();
    db.execute(
        "INSERT INTO messages (id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable) VALUES ('message-stream-turn-handoff',?1,'turn-handoff','assistant','Made-up hand-off text','streaming','2026-01-01T00:00:01.000Z','2026-01-01T00:00:02.000Z',0)",
        [chat],
    )
    .unwrap();
}

/// The parent's hand-off message reads as delivered, so its controls show.
fn assert_handoff_message_is_final(view: &Value) {
    let message = view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["id"] == "message-stream-turn-handoff")
        .unwrap_or_else(|| panic!("hand-off message missing: {view}"));
    assert_eq!(message["status"], "delivered", "{message}");
}

/// The settled hand-off message is a valid branch source: the branch owner
/// reads the same status as the transcript.
async fn assert_branch_from_handoff_message(s: &Scenario, chat: &str) -> Result<(), HarnessError> {
    let branch =
        s.gw.post(
            "/internal/session-branches",
            json!({
                "request_id": "branch-handoff", "source_session_id": chat,
                "source_message_id": "message-stream-turn-handoff",
                "title": "Made-up topic", "destination": "chat",
            }),
        )
        .await?;
    // The stub tier has no model for the branch summary (502); what matters
    // is that the source answer was accepted (not 404 branch_source_unavailable).
    assert_ne!(branch.status, 404, "{}", branch.text);
    assert!(
        !branch.text.contains("branch_source_unavailable"),
        "{}",
        branch.text
    );
    Ok(())
}
