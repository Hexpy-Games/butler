use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use rusqlite::OptionalExtension;
use serde_json::json;

use super::super::*;
use super::support::*;
use crate::gateway::GatewayApplication;

fn projection_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "butler-h1b-{label}-{}-{}",
        std::process::id(),
        AtomicU64::new(1).fetch_add(1, Ordering::Relaxed)
    ))
}

#[tokio::test]
async fn transcript_watcher_projects_delivered_turn_without_foreground_refresh() {
    let root = projection_root("watched-final");
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
            project_workspace_root: root.clone(),
            folder_selection_secret: None,
        },
        dependencies(native.clone(), 800),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let turn = app
        .send_message(command("watched-final", "question"))
        .await
        .unwrap()
        .turn
        .unwrap();
    let claim = native.0.lock().unwrap()[0].app_queue_claim_id.clone();
    std::fs::write(
        root.join("runtime/inbound-events/processed/queue-watched.json"),
        r#"{"metadata":{"terminalClaimId":"dispatch-watched"}}"#,
    )
    .unwrap();
    let transcript = root.join("transcripts/butler_app-general.jsonl");
    let outbound = json!({
        "eventId":"outbound-watched","sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:01.000Z","transport":"app",
        "payload":{"actionId":"action-watched","message":{"text":"answer","replyToMessageId":turn.user_message_id.unwrap()},
            "metadata":{"kind":"final_result","turnId":turn.id,"appQueueClaimId":claim,
                "appQueueClaimProvenance":"matching_app_target",
                "queueId":"queue-watched","dispatchClaimId":"dispatch-watched"}}
    });
    let delivery = json!({
        "eventId":"delivery-watched","sessionId":"butler/app-general","kind":"delivery",
        "timestamp":"2026-09-14T00:00:02.000Z","transport":"app",
        "payload":{"actionId":"action-watched","ok":true}
    });
    std::fs::write(&transcript, format!("{outbound}\n{delivery}\n")).unwrap();
    // A failure bound only: FSEvents delivery on hosted macOS VMs can lag by
    // several seconds.
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let turns = app.turn_page("general".into(), 0.0).await.unwrap();
            if turns.turns.iter().any(|item| {
                item.id == turn.id
                    && matches!(item.state, crate::gateway::protocol::TurnState::Delivered)
            }) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("watcher must project terminal records without a GET-triggered refresh");
    let messages = app.message_page("general".into(), 0.0, 200).await.unwrap();
    assert!(
        messages
            .messages
            .iter()
            .any(|item| item.turn_id.as_deref() == Some(&turn.id)
                && matches!(item.role, crate::gateway::protocol::MessageRole::Assistant))
    );
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn recovered_delivered_final_requires_unchanged_original_claim() {
    use std::os::unix::fs::MetadataExt;

    for case in ["recovered", "edited", "new_claim", "cancelled"] {
        let root = projection_root(case);
        std::fs::create_dir_all(root.join("transcripts")).unwrap();
        let native = Arc::new(Native(Mutex::new(Vec::new())));
        let app = AppApplication::open(
            AppApplicationConfig {
                database_path: root.join("app.sqlite"),
                butler_data: root.clone(),
                project_workspace_root: root.clone(),
                folder_selection_secret: None,
            },
            dependencies(native.clone(), 800),
        )
        .await
        .unwrap();
        app.start_dispatch().await.unwrap();
        let accepted = app.send_message(command(case, "question")).await.unwrap();
        let turn = accepted.turn.unwrap();
        let user = turn.user_message_id.unwrap();
        let claim = native.0.lock().unwrap()[0].app_queue_claim_id.clone();
        let transcript = root.join("transcripts/butler_app-general.jsonl");
        let outbound = json!({
            "eventId":"outbound-1","sessionId":"butler/app-general","kind":"outbound",
            "timestamp":"2026-09-14T00:00:01.000Z","transport":"app",
            "payload":{"actionId":"action-1","message":{"text":"answer","replyToMessageId":user},
                "metadata":{"kind":"final_result","turnId":turn.id,"appQueueClaimId":claim,
                    "appQueueClaimProvenance":"matching_app_target",
                    "queueId":"queue-1","dispatchClaimId":"dispatch-1"}}
        });
        std::fs::write(&transcript, format!("{outbound}\n")).unwrap();
        app.refresh_message_projection("general".into())
            .await
            .unwrap();
        let original_inode = std::fs::metadata(&transcript).unwrap().ino();
        app.storage
            .execute(|db| {
                db.execute(
                    "UPDATE session_queued_messages SET lease_expires_at='2026-09-13T00:00:00.000Z' \
                     WHERE state='dispatching'",
                    [],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .unwrap();
        app.recover_expired().await.unwrap();
        let case_name = case.to_owned();
        app.storage
            .execute(move |db| {
                match case_name.as_str() {
                    "edited" => {
                        db.execute("UPDATE session_queued_messages SET text='changed',updated_at='2026-09-14T00:00:03.000Z' WHERE state='queued'",[]).map_err(AppStorageError::sqlite)?;
                    }
                    "new_claim" => {
                        db.execute("UPDATE session_queued_messages SET state='dispatching',claim_id='new-claim' WHERE state='queued'",[]).map_err(AppStorageError::sqlite)?;
                    }
                    "cancelled" => {
                        db.execute("UPDATE session_queued_messages SET state='failed' WHERE state='queued'",[]).map_err(AppStorageError::sqlite)?;
                    }
                    _ => {}
                }
                Ok(())
            })
            .await
            .unwrap();
        std::fs::write(
            root.join("runtime/inbound-events/processed/queue-1.json"),
            r#"{"metadata":{"terminalClaimId":"dispatch-1"}}"#,
        )
        .unwrap();
        let delivery = json!({
            "eventId":"delivery-1","sessionId":"butler/app-general","kind":"delivery",
            "timestamp":"2026-09-14T00:00:02.000Z","transport":"app",
            "payload":{"actionId":"action-1","ok":true}
        });
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&transcript)
                .unwrap(),
            "{delivery}"
        )
        .unwrap();
        assert_eq!(
            std::fs::metadata(&transcript).unwrap().ino(),
            original_inode
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            app.refresh_message_projection("general".into()),
        )
        .await
        .expect("projection must yield when a claim cannot be proven")
        .unwrap();
        let target = turn.id.clone();
        let (state, assistant_count, offset) = app.storage.execute(move |db| {
            let state = db.query_row("SELECT state FROM turns WHERE id=?1",[&target],|row|row.get::<_,String>(0)).map_err(AppStorageError::sqlite)?;
            let assistant_count = db.query_row("SELECT count(*) FROM messages WHERE turn_id=?1 AND role='assistant'",[&target],|row|row.get::<_,i64>(0)).map_err(AppStorageError::sqlite)?;
            let offset = db.query_row("SELECT projected_bytes FROM app_transcript_projection_checkpoints WHERE chat_id='general'",[],|row|row.get::<_,u64>(0)).map_err(AppStorageError::sqlite)?;
            Ok((state,assistant_count,offset))
        }).await.unwrap();
        if case == "recovered" {
            assert_eq!((state.as_str(), assistant_count), ("delivered", 1));
            assert_eq!(offset, std::fs::metadata(&transcript).unwrap().len());
        } else {
            assert_eq!((state.as_str(), assistant_count), ("thinking", 0));
            assert_eq!(offset, (outbound.to_string().len() + 1) as u64);
        }
        app.close().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tokio::test]
async fn delivered_progress_is_receipted_and_returned_by_message_get() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let root = projection_root("non-final-progress");
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
            project_workspace_root: root.clone(),
            folder_selection_secret: None,
        },
        dependencies(native.clone(), 600),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let accepted = app
        .send_message(command("progress-client", "question"))
        .await
        .unwrap();
    let turn = accepted.turn.unwrap().id;
    let claim = native.0.lock().unwrap()[0].app_queue_claim_id.clone();
    let outbound = json!({
        "eventId":"outbound-progress","sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:01.000Z","transport":"app",
        "payload":{"actionId":"action-progress","message":{},"metadata":{
            "kind":"tool_progress","turnId":turn,"appQueueClaimId":claim,
            "activityKind":"used_tool","state":"running","safeLabel":"Reading source",
            "toolName":"read_file","toolCallId":"call-1"
        }}
    });
    let delivery = json!({
        "eventId":"delivery-progress","sessionId":"butler/app-general","kind":"delivery",
        "timestamp":"2026-09-14T00:00:02.000Z","transport":"app",
        "payload":{"actionId":"action-progress","ok":true}
    });
    let runtime = json!({
        "eventId":"outbound-runtime","sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:03.000Z","transport":"app",
        "payload":{"actionId":"Action-Runtime","message":{},"metadata":{
            "kind":"turn_event","turnId":turn,"appQueueClaimId":claim,
            "event":{"id":"Event-MixedCase","kind":"model.stream.tool_call_delta",
                "payload":{"streamId":"stream-1","sequence":"2","callIndex":"0",
                    "argumentCharCount":"4","publicState":"generating"}}
        }}
    });
    let runtime_delivery = json!({
        "eventId":"delivery-runtime","sessionId":"butler/app-general","kind":"delivery",
        "timestamp":"2026-09-14T00:00:04.000Z","transport":"app",
        "payload":{"actionId":"Action-Runtime","ok":true}
    });
    let continuation = json!({
        "eventId":"outbound-continuation","sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:05.000Z","transport":"app",
        "payload":{"actionId":"Action-Continuation","message":{},"metadata":{
            "kind":"turn_event","turnId":turn,"appQueueClaimId":claim,
            "event":{"id":"Event-Continuation","kind":"tool.progress","payload":{
                "activityKind":"model","state":"running","safeLabel":"Private retry",
                "noVisibleReply":true,"continuationRequeued":true}}
        }}
    });
    let continuation_delivery = json!({
        "eventId":"delivery-continuation","sessionId":"butler/app-general","kind":"delivery",
        "timestamp":"2026-09-14T00:00:06.000Z","transport":"app",
        "payload":{"actionId":"Action-Continuation","ok":true}
    });
    std::fs::write(
        root.join("transcripts/butler_app-general.jsonl"),
        format!("{outbound}\n{delivery}\n{runtime}\n{runtime_delivery}\n{continuation}\n{continuation_delivery}\n"),
    )
    .unwrap();
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    let page = app.list_messages("general".into(), 0.0, 200).await.unwrap();
    let progress = page.turn_progress.unwrap().remove(&turn).unwrap();
    assert_eq!(progress.safe_progress_rows.len(), 1);
    assert_eq!(
        progress.safe_progress_rows[0]["safe_label"],
        "Reading source"
    );
    app.storage.execute(|db| {
        let receipt:i64=db.query_row("SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id IN ('action-progress','Action-Runtime','Action-Continuation')",[],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let staged:i64=db.query_row("SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id='action-progress'",[],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let runtime:String=db.query_row("SELECT payload_json FROM events WHERE type='agent.turn_event' AND json_extract(payload_json,'$.event.id')='Event-MixedCase'",[],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let runtime:serde_json::Value=serde_json::from_str(&runtime).unwrap();
        assert_eq!(runtime["event"]["payload"]["sequence"],2);
        assert_eq!(runtime["event"]["payload"]["argumentCharCount"],4);
        let hidden:i64=db.query_row("SELECT COUNT(*) FROM app_internal_continuation_progress_events WHERE turn_id=?1",[turn],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        assert_eq!(hidden,1);
        assert_eq!((receipt,staged),(3,0)); Ok(())
    }).await.unwrap();
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn retention_owner_snapshots_terminal_progress_and_joins_on_close() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let root = projection_root("retention");
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
            project_workspace_root: root.clone(),
            folder_selection_secret: None,
        },
        dependencies(native, 700),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let turn = app
        .send_message(command("retention-client", "question"))
        .await
        .unwrap()
        .turn
        .unwrap()
        .id;
    let retained_turn = turn.clone();
    app.storage.execute(move|db|{
        let subscribers=EventSubscribers::default();
        events::append(db,&subscribers,"progress.summary",Some(&retained_turn),service::map(json!({"session_id":"general","turn_id":retained_turn,"row":{"id":"work-1","kind":"used_tool","state":"running","safe_label":"Worked","created_at":"2026-09-14T00:00:01.000Z"}}))?,"2026-09-14T00:00:01.000Z")?;
        events::append(db,&subscribers,"agent.turn_event",Some(&retained_turn),service::map(json!({"session_id":"general","turn_id":retained_turn,"event":{"kind":"turn.completed","payload":{"delivery_state":"delivered_with_limitations","limitation_codes":["partial"],"limitations":["One result was unavailable."]}}}))?,"2026-09-14T00:00:02.000Z")?;
        db.execute("UPDATE turns SET state='delivered',safe_status_label='Delivered' WHERE id=?1",[&retained_turn]).map_err(AppStorageError::sqlite)?;
        db.execute(
            "INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable) \
             VALUES('retained-final','general',?1,'assistant','Done','delivered',\
                    '2026-09-14T00:00:02.000Z','2026-09-14T00:00:02.000Z',0)",
            [&retained_turn],
        ).map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    app.retention.as_ref().unwrap().schedule(turn.clone()).await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let id = turn.clone();
            let ready = app
                .storage
                .execute(move |db| {
                    db.query_row(
                        "SELECT 1 FROM app_terminal_turn_projections WHERE turn_id=?1",
                        [id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map(|v| v.is_some())
                    .map_err(AppStorageError::sqlite)
                })
                .await
                .unwrap();
            if ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("retention owner must snapshot the terminal projection");
    let page = app.list_messages("general".into(), 0.0, 200).await.unwrap();
    let progress = &page.turn_progress.unwrap()[&turn];
    assert_eq!(progress.safe_progress_rows[0]["safe_label"], "Worked");
    assert!(matches!(
        progress.delivery_state,
        Some(crate::gateway::DeliveryState::DeliveredWithLimitations)
    ));
    assert_eq!(
        progress.limitation_codes.as_deref(),
        Some(["partial".to_owned()].as_slice())
    );
    let message = page
        .messages
        .iter()
        .find(|message| message.id == "retained-final")
        .unwrap();
    assert!(matches!(
        message.delivery_state,
        Some(crate::gateway::DeliveryState::DeliveredWithLimitations)
    ));
    assert_eq!(message.work_blocks.as_ref().map(Vec::len), Some(1));
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
