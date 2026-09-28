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
        events::append(db,&subscribers,"progress.summary",Some(&retained_turn),service::map(&json!({"session_id":"general","turn_id":retained_turn,"row":{"id":"work-1","kind":"used_tool","state":"running","safe_label":"Worked","created_at":"2026-09-14T00:00:01.000Z"}}))?,"2026-09-14T00:00:01.000Z")?;
        events::append(db,&subscribers,"agent.turn_event",Some(&retained_turn),service::map(&json!({"session_id":"general","turn_id":retained_turn,"event":{"kind":"turn.completed","payload":{"delivery_state":"delivered_with_limitations","limitation_codes":["partial"],"limitations":["One result was unavailable."]}}}))?,"2026-09-14T00:00:02.000Z")?;
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

/// Race (REC-04): after a restart the runtime sends a turn's actions again.
/// The projection skips a delivery it must not apply (here the first send
/// carries no claim, so it is stale against the turn's dispatching claim) and
/// retires its staged outbound with it. The re-send, which carries the
/// current claim and so a different payload, then stages and projects; a
/// leftover row would have turned it into an identity conflict that failed
/// every later projection of the chat.
// test-category: race
#[tokio::test]
async fn a_skipped_delivery_retires_its_staged_outbound_for_the_resend() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let root = projection_root("skipped-delivery");
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
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
        .send_message(command("resend-client", "question"))
        .await
        .unwrap()
        .turn
        .unwrap()
        .id;
    let claim = native.0.lock().unwrap()[0].app_queue_claim_id.clone();
    assert!(claim.is_some(), "the dispatched turn carries a claim");
    let transcript = root.join("transcripts/butler_app-general.jsonl");

    append_send(&transcript, "outbound-claimless", &turn, None);
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    assert_eq!(staged_and_receipt(&app).await, (0, None));

    append_send(&transcript, "outbound-resent", &turn, claim.as_deref());
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    assert_eq!(
        staged_and_receipt(&app).await,
        (0, Some("outbound-resent".to_owned()))
    );
    let page = app.list_messages("general".into(), 0.0, 200).await.unwrap();
    let progress = page.turn_progress.unwrap().remove(&turn).unwrap();
    assert_eq!(progress.safe_progress_rows.len(), 1);
    assert_eq!(
        progress.safe_progress_rows[0]["safe_label"],
        "Reading source"
    );
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Appends one send of the progress action `action-resent`: its outbound
/// record and its delivery, written together as the runtime writes them.
fn append_send(transcript: &std::path::Path, event_id: &str, turn: &str, claim: Option<&str>) {
    use std::io::Write;
    let mut metadata = json!({
        "kind":"tool_progress","turnId":turn,"activityKind":"used_tool","state":"running",
        "safeLabel":"Reading source","toolName":"read_file","toolCallId":"call-1"
    });
    if let Some(claim) = claim {
        metadata["appQueueClaimId"] = json!(claim);
    }
    let outbound = json!({
        "eventId":event_id,"sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:01.000Z","transport":"app",
        "payload":{"actionId":"action-resent","message":{},"metadata":metadata},
        "metadata":{"source":"transport/delivery-guard.ts","attempts":1}
    });
    let delivery = json!({
        "eventId":format!("{event_id}-delivery"),"sessionId":"butler/app-general",
        "kind":"delivery","timestamp":"2026-09-14T00:00:02.000Z","transport":"app",
        "payload":{"actionId":"action-resent","ok":true}
    });
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(transcript)
        .unwrap();
    write!(file, "{outbound}\n{delivery}\n").unwrap();
}

/// How many staged rows `action-resent` has, and the event its projection
/// receipt names.
async fn staged_and_receipt(app: &AppApplication) -> (i64, Option<String>) {
    app.storage
        .execute(|db| {
            let staged = db
                .query_row(
                    "SELECT COUNT(*) FROM app_transport_projection_staged_outbounds \
                     WHERE action_id='action-resent'",
                    [],
                    |row| row.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            let receipt = db
                .query_row(
                    "SELECT event_id FROM app_transport_projection_receipts \
                     WHERE action_id='action-resent'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(AppStorageError::sqlite)?;
            Ok((staged, receipt))
        })
        .await
        .unwrap()
}
