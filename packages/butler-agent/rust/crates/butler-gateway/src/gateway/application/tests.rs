mod child_results;
mod controls;
mod documents;

mod projection_burst;
mod projection_tests;
mod retry;
mod session_views;
mod support;

use std::sync::{Arc, Mutex, atomic::AtomicU64};

use serde_json::{Value, json};

use super::*;
use crate::gateway::GatewayApplication;
use support::*;

#[tokio::test]
async fn message_and_turn_cursors_preserve_distinct_public_rules() {
    let path = temp_path("cursors");
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path.clone(),
            butler_data: path.parent().unwrap().into(),
            folder_selection_secret: None,
        },
        dependencies(Arc::new(Native(Mutex::new(Vec::new()))), 40),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    app.storage
        .execute(|db| {
            let transaction = db.savepoint().map_err(AppStorageError::sqlite)?;
            for index in 1..=205 {
                transaction
                    .execute(
                        "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) \
                         VALUES(?1,'general','user',?2,'sent','now','now')",
                        rusqlite::params![format!("message-{index}"), index.to_string()],
                    )
                    .map_err(AppStorageError::sqlite)?;
            }
            transaction
                .execute(
                    "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,safe_error_code) \
                     VALUES('hidden-legacy','general','assistant','hidden','delivered','now','now','goal_completion_incomplete')",
                    [],
                )
                .map_err(AppStorageError::sqlite)?;
            for index in 1..=2 {
                transaction
                    .execute(
                        "INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) \
                         VALUES(?1,'general','thinking','Thinking','now','now')",
                        [format!("turn-{index}")],
                    )
                    .map_err(AppStorageError::sqlite)?;
            }
            transaction.commit().map_err(AppStorageError::sqlite)
        })
        .await
        .unwrap();

    let initial = app.list_messages("general".into(), 0.0, 200).await.unwrap();
    assert_eq!(initial.messages.len(), 200);
    assert_eq!(initial.messages.first().unwrap().text, "6");
    assert_eq!(initial.messages.last().unwrap().text, "205");
    let delta = app
        .list_messages("general".into(), 199.9, 200)
        .await
        .unwrap();
    assert_eq!(delta.messages.first().unwrap().text, "200");
    assert_eq!(delta.messages.len(), 6);
    let turns = app.list_turns("general".into(), 1.5).await.unwrap();
    assert_eq!(turns.turns.len(), 1);
    assert_eq!(turns.turns[0].id, "turn-2");

    let latest = app
        .session_view(
            "general".into(),
            AppSessionViewPage {
                after_cursor: None,
                before_cursor: None,
                limit: 2,
            },
        )
        .await
        .unwrap();
    assert_eq!(latest["messages"][0]["text"], "204");
    assert_eq!(latest["messages"][1]["text"], "205");
    assert_eq!(latest["message_window"]["previous_cursor"], 204);
    assert_eq!(latest["message_window"]["next_cursor"], 205);
    assert_eq!(latest["message_window"]["complete"], false);

    let older = app
        .session_view(
            "general".into(),
            AppSessionViewPage {
                after_cursor: None,
                before_cursor: Some(204),
                limit: 2,
            },
        )
        .await
        .unwrap();
    assert_eq!(older["messages"][0]["text"], "202");
    assert_eq!(older["messages"][1]["text"], "203");
    assert_eq!(older["message_window"]["complete"], false);

    let forward = app
        .session_view(
            "general".into(),
            AppSessionViewPage {
                after_cursor: Some(203),
                before_cursor: None,
                limit: 2,
            },
        )
        .await
        .unwrap();
    assert_eq!(forward["messages"][0]["text"], "204");
    assert_eq!(forward["messages"][1]["text"], "205");
    assert_eq!(forward["message_window"]["complete"], true);

    app.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

// test-category: race
#[tokio::test]
async fn delivered_transcript_final_projects_and_settles_exact_queue_claim() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let root = std::env::temp_dir().join(format!(
        "butler-h1b-projection-{}-{}",
        std::process::id(),
        Clock(AtomicU64::new(90)).new_uuid()
    ));
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
    let path = root.join("app.sqlite");
    let enqueued = Arc::new(tokio::sync::Notify::new());
    let (release, ready) = tokio::sync::watch::channel(false);
    let mut deps = dependencies(native.clone(), 100);
    deps.native_ingress = Arc::new(child_results::ObservedNative {
        native: native.clone(),
        enqueued: enqueued.clone(),
    });
    deps.executor_readiness = Arc::new(child_results::ReadinessGate(ready));
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path,
            butler_data: root.clone(),
            folder_selection_secret: None,
        },
        deps,
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    // Publishing repeated changes must not wait behind a dispatcher held at readiness.
    // The wakes name another chat: a released cycle for this chat could claim
    // the ordinary admission below before it claims its own row.
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        for _ in 0..128 {
            app.queue_wake.chat("other".into()).await.unwrap();
        }
    })
    .await
    .expect("coalesced queue wakes must not block event publication");
    release.send(true).unwrap();
    // Commands run in order, so this reply follows the startup drain of every chat.
    app.queue_wake.drain_chat("general".into()).await.unwrap();
    let mut plan_request = command("projection-id", "question");
    plan_request.request.plan_mode = Some(json!(true));
    let accepted = app.send_message(plan_request).await.unwrap();
    assert!(accepted.accepted.is_some());
    assert!(accepted.turn.is_some());
    assert_eq!(native.0.lock().unwrap().len(), 1);
    tokio::time::timeout(std::time::Duration::from_secs(3), enqueued.notified())
        .await
        .unwrap();
    let rebuilt_turn = native.0.lock().unwrap()[0].clone();
    let turn_id = rebuilt_turn.turn_id.clone();
    documents::assert_retry_snapshot(&app, &turn_id).await;
    assert!(
        app.send_message(command("followup", "A queued follow-up"))
            .await
            .unwrap()
            .queued
            .is_some()
    );
    for number in 1..=2 {
        let mut result = command(
            &format!("result-{number}"),
            &format!("Child output {number}"),
        );
        result.request.subsession_result = Some(butler_turn::btcc::SubsessionResultContext {
            child_session_id: None,
            relation_id: format!("relation-{number}"),
            result_id: format!("result-{number}"),
            safe_title: "Child".into(),
        });
        assert!(app.send_message(result).await.unwrap().queued.is_some());
    }
    let outbound = json!({
        "eventId":"outbound-1","sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:01.000Z","transport":"app",
        "payload":{"actionId":"action-1","message":{"text":"<butler_final_answer>answer</butler_final_answer>","artifacts":[],
            "plan":{"kind":"plan","id":"plan-1","title":"Ship it","status":"active","body":"Do the work"}},
            "metadata":{"kind":"final_result","turnId":turn_id,"appQueueClaimId":rebuilt_turn.app_queue_claim_id,
                "queueId":"queue-1","dispatchClaimId":"dispatch-1"}}
    });
    let delivery = json!({
        "eventId":"delivery-1","sessionId":"butler/app-general","kind":"delivery",
        "timestamp":"2026-09-14T00:00:02.000Z","transport":"app",
        "payload":{"actionId":"action-1","ok":true}
    });
    std::fs::write(
        root.join("transcripts/butler_app-general.jsonl"),
        format!("{outbound}\n{delivery}\n"),
    )
    .unwrap();

    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    let deferred = app.list_messages("general".into(), 0.0, 200).await.unwrap();
    assert_eq!(deferred.messages.last().unwrap().text, "question");
    std::fs::write(
        root.join("runtime/inbound-events/processed/queue-1.json"),
        r#"{"metadata":{"terminalClaimId":"dispatch-1"}}"#,
    )
    .unwrap();
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    let page = app.list_messages("general".into(), 0.0, 200).await.unwrap();
    // The queue wake may already have dispatched the plan continuation, whose
    // user message then follows the answer.
    let texts = page
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>();
    let question = texts.iter().position(|text| *text == "question").unwrap();
    assert_eq!(texts.get(question + 1), Some(&"answer"));
    let settled_turn = turn_id.clone();
    let state = app
        .storage
        .execute(move |db| {
            db.query_row(
                "SELECT state FROM session_queued_messages WHERE turn_id=?1",
                [settled_turn],
                |row| row.get::<_, String>(0),
            )
            .map_err(AppStorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(state, "dispatched");
    app.storage
        .execute(move |db| {
            // The plan continuation is the newest queue row. The queue wake
            // issued by projection may already have dispatched it, so its
            // state is not part of this contract.
            let (text, resolution): (String, String) = db
                .query_row(
                    "SELECT text,control_resolution_json FROM session_queued_messages \
                     WHERE turn_id IS NOT ?1 ORDER BY rowid DESC LIMIT 1",
                    [&turn_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(AppStorageError::sqlite)?;
            assert_eq!(text, "Proceed with the accepted plan \"Ship it\".");
            let resolution: Value = serde_json::from_str(&resolution).unwrap();
            assert_eq!(resolution["plan_id"], "plan-1");
            assert_eq!(resolution["controls"]["plan_mode"], false);
            let turn_events = {
                let mut statement = db
                    .prepare(
                        "SELECT payload_json FROM events WHERE type='agent.turn_event' \
                         AND turn_id=?1 ORDER BY id",
                    )
                    .map_err(AppStorageError::sqlite)?;
                statement
                    .query_map([&turn_id], |row| row.get::<_, String>(0))
                    .map_err(AppStorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(AppStorageError::sqlite)?
            };
            let events = turn_events
                .iter()
                .map(|value| serde_json::from_str::<Value>(value).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                events
                    .iter()
                    .map(|value| value["event"]["kind"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                [
                    "message.final.started",
                    "message.final.completed",
                    "turn.completed"
                ]
            );
            assert_eq!(events[0]["event"]["sessionSequence"], 1);
            assert_eq!(events[2]["event"]["turnSequence"], 3);
            assert_eq!(events[0]["event"]["visibility"], "public");
            Ok(())
        })
        .await
        .unwrap();
    // Final delivery starts the first child result before the user follow-up
    // or plan continuation. Another result arrives under that active claim.
    tokio::time::timeout(std::time::Duration::from_secs(3), enqueued.notified())
        .await
        .unwrap();
    assert_eq!(native.0.lock().unwrap()[1].text, "Child output 1");
    let mut result = command("result-3", "Child output 3");
    result.request.subsession_result = Some(butler_turn::btcc::SubsessionResultContext {
        child_session_id: None,
        relation_id: "relation-3".into(),
        result_id: "result-3".into(),
        safe_title: "Child".into(),
    });
    assert!(app.send_message(result).await.unwrap().queued.is_some());
    for number in 2..=3 {
        let parent = native.0.lock().unwrap().last().unwrap().clone();
        // Consume all prior wakes while the current parent claim is active.
        app.queue_wake.drain_chat("general".into()).await.unwrap();
        assert_eq!(native.0.lock().unwrap().len(), number);
        let suspended = json!({
            "eventId":format!("suspended-{number}"), "sessionId":"butler/app-general", "kind":"outbound",
            "timestamp":"2026-09-14T00:00:03.000Z", "transport":"app",
            "payload":{"actionId":format!("suspend-{number}"), "message":{}, "metadata":{
                "kind":"turn_suspended", "turnId":parent.turn_id,
                "appQueueClaimId":parent.app_queue_claim_id, "suspension":"waiting_for_worker"
            }}
        });
        let delivered = json!({
            "eventId":format!("suspended-delivery-{number}"), "sessionId":"butler/app-general", "kind":"delivery",
            "timestamp":"2026-09-14T00:00:04.000Z", "transport":"app",
            "payload":{"actionId":format!("suspend-{number}"), "ok":true}
        });
        {
            use std::io::Write;
            let mut transcript = std::fs::OpenOptions::new()
                .append(true)
                .open(root.join("transcripts/butler_app-general.jsonl"))
                .unwrap();
            writeln!(transcript, "{suspended}\n{delivered}").unwrap();
        }
        app.refresh_message_projection("general".into())
            .await
            .unwrap();
        // No sleep, drain or unrelated wake after projection releases the claim.
        tokio::time::timeout(std::time::Duration::from_secs(3), enqueued.notified())
            .await
            .unwrap();
        let turns = native.0.lock().unwrap().clone();
        assert_eq!(turns.len(), number + 1);
        assert_eq!(turns[number].text, format!("Child output {number}"));
    }
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
