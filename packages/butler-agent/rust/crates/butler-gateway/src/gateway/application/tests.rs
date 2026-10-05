mod controls;

mod projection_burst;
mod projection_tests;
mod retry;
mod session_views;
mod skills;
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
            project_workspace_root: path.parent().unwrap().into(),
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
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path,
            butler_data: root.clone(),
            project_workspace_root: root.clone(),
            folder_selection_secret: None,
        },
        dependencies(native.clone(), 100),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let mut plan_request = command("projection-id", "question");
    plan_request.request.plan_mode = Some(json!(true));
    let accepted = app.send_message(plan_request).await.unwrap();
    let rebuilt_turn = native.0.lock().unwrap()[0].clone();
    let turn_id = accepted.turn.unwrap().id;
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
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
