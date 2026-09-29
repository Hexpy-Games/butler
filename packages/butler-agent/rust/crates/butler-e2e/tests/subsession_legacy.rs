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

    for (stewards, workers) in [
        (&view.data()["steward_children"], &view.data()["workers"]),
        (
            &summary.data()["steward_children"],
            &summary.data()["worker_activity"],
        ),
    ] {
        assert_eq!(
            children(stewards, "session_id"),
            ["steward-legacy-a", "steward-legacy-b"]
        );
        assert_eq!(children(workers, "session_id"), ["worker-legacy-c"]);
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
            "steward-relation-a",
            "steward-relation-b",
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
    ];
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
