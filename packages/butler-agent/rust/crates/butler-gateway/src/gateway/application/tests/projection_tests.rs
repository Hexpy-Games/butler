use std::sync::{Arc, Mutex};

use rusqlite::OptionalExtension;
use serde_json::json;

use super::super::*;
use super::support::*;
use crate::gateway::GatewayApplication;

fn projection_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "butler-h1b-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

// test-category: race
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
    let turn = dispatched_turn(&app, &native, command("progress-client", "question"))
        .await
        .id;
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

// test-category: race
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
        dependencies(native.clone(), 700),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let turn = dispatched_turn(&app, &native, command("retention-client", "question"))
        .await
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
    cancelled_reader_joins_on_close(app).await;
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
    let turn = dispatched_turn(&app, &native, command("resend-client", "question"))
        .await
        .id;
    let claim = native.0.lock().unwrap()[0].app_queue_claim_id.clone();
    assert!(claim.is_some(), "the dispatched turn carries a claim");
    let transcript = root.join("transcripts/butler_app-general.jsonl");

    append_send(&transcript, "outbound-claimless", &turn, None, false);
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    assert_eq!(staged_and_receipt(&app, "action-resent").await, (0, None));

    // A cancellation marker cannot authorize a stale event without the owner's
    // durable cancellation record for this turn.
    append_send(
        &transcript,
        "outbound-unrequested-cancel",
        &turn,
        None,
        true,
    );
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    assert_eq!(
        staged_and_receipt(&app, "outbound-unrequested-cancel").await,
        (0, None)
    );

    append_send(
        &transcript,
        "outbound-resent",
        &turn,
        claim.as_deref(),
        false,
    );
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    assert_eq!(
        staged_and_receipt(&app, "action-resent").await,
        (0, Some("outbound-resent".to_owned()))
    );
    let page = app.list_messages("general".into(), 0.0, 200).await.unwrap();
    let progress = page.turn_progress.unwrap().remove(&turn).unwrap();
    assert_eq!(progress.safe_progress_rows.len(), 1);
    assert_eq!(
        progress.safe_progress_rows[0]["safe_label"],
        "Reading source"
    );
    super::projection_burst::assert_burst_projects_other_chat(&app, &native, &root).await;
    // Cancellation progress may precede the control acknowledgment that changes
    // the turn state. The durable owner request already authorizes settlement.
    let cancelled_turn = turn.clone();
    app.storage.execute(move |db| {
        db.execute("INSERT INTO app_turn_cancel_outbox(turn_id,queue_id,state,created_at) VALUES(?1,'owner-cancel','pending','now')", [&cancelled_turn])
            .map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    append_send(&transcript, "outbound-requested-cancel", &turn, None, true);
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    assert_eq!(
        staged_and_receipt(&app, "outbound-requested-cancel").await,
        (0, Some("outbound-requested-cancel".into()))
    );
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

// Either the inline sender or the background FIFO dispatcher can claim the
// message. Submit once and wait for the matching committed dispatch before
// injecting projection events; a queued receipt need not contain a turn.
pub(super) async fn dispatched_turn(
    app: &AppApplication,
    native: &Native,
    request: crate::gateway::SendMessageCommand,
) -> crate::gateway::TurnRecord {
    let chat = request.chat_id.clone();
    let sent = app.send_message(request).await.unwrap();
    if let Some(turn) = sent.turn {
        assert_eq!(
            native
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|sent| sent.turn_id == turn.id)
                .count(),
            1
        );
        return turn;
    }
    let queued = sent
        .queued
        .expect("a deferred send has a queued receipt")
        .id;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let (chat, queued) = (chat.clone(), queued.clone());
            let turn = app.storage.read(move |db| {
                let id: Option<String> = db.query_row(
                    "SELECT q.turn_id FROM session_queued_messages q WHERE q.chat_id=?1 AND q.id=?2 \
                     AND EXISTS(SELECT 1 FROM events WHERE type='turn.queued' AND turn_id=q.turn_id)",
                    [chat, queued], |row| row.get(0),
                ).optional().map_err(AppStorageError::sqlite)?;
                id.map(|id| read_model::exact_turn(db, &id)).transpose().map(Option::flatten)
            }).await.unwrap();
            if let Some(turn) = turn
                && matches!(turn.state, crate::gateway::TurnState::Thinking)
                && native.0.lock().unwrap().iter().any(|sent| sent.turn_id == turn.id)
            {
                assert_eq!(native.0.lock().unwrap().iter().filter(|sent| sent.turn_id == turn.id).count(), 1);
                return turn;
            }
            tokio::task::yield_now().await;
        }
    }).await.expect("the submitted message must be dispatched once")
}

/// Appends one send of the progress action `action-resent`: its outbound
/// record and its delivery, written together as the runtime writes them.
fn append_send(
    transcript: &std::path::Path,
    event_id: &str,
    turn: &str,
    claim: Option<&str>,
    authority_cancel: bool,
) {
    use std::io::Write;
    let mut metadata = json!({
        "kind":"tool_progress","turnId":turn,"activityKind":"used_tool","state":"running",
        "safeLabel":"Reading source","toolName":"read_file","toolCallId":"call-1"
    });
    if authority_cancel {
        metadata = json!({"kind":"turn_event","turnId":turn,"event":{
            "kind":"tool.cancelled","payload":{"authorityCancellation":true,
                "toolName":"read_file","toolCallId":"call-1","bridgePhase":"btcc_operation"}}});
        let payload = super::super::projection::normalize_committed_turn_event(
            "tool.cancelled",
            "public",
            metadata["event"]["payload"].as_object(),
        )
        .unwrap();
        assert_eq!(payload["authorityCancellation"], true);
        metadata["event"]["payload"] = json!(payload);
    }
    if let Some(claim) = claim {
        metadata["appQueueClaimId"] = json!(claim);
    }
    let action = if authority_cancel {
        event_id
    } else {
        "action-resent"
    };
    let outbound = json!({
        "eventId":event_id,"sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:01.000Z","transport":"app",
        "payload":{"actionId":action,"message":{},"metadata":metadata},
        "metadata":{"source":"transport/delivery-guard.ts","attempts":1}
    });
    let delivery = json!({
        "eventId":format!("{event_id}-delivery"),"sessionId":"butler/app-general",
        "kind":"delivery","timestamp":"2026-09-14T00:00:02.000Z","transport":"app",
        "payload":{"actionId":action,"ok":true}
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
async fn staged_and_receipt(app: &AppApplication, action: &str) -> (i64, Option<String>) {
    let action = action.to_owned();
    app.storage
        .execute(move |db| {
            let staged = db
                .query_row(
                    "SELECT COUNT(*) FROM app_transport_projection_staged_outbounds \
                     WHERE action_id=?1",
                    [&action],
                    |row| row.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            let receipt = db
                .query_row(
                    "SELECT event_id FROM app_transport_projection_receipts \
                     WHERE action_id=?1",
                    [&action],
                    |row| row.get(0),
                )
                .optional()
                .map_err(AppStorageError::sqlite)?;
            Ok((staged, receipt))
        })
        .await
        .unwrap()
}

// A cancelled caller must not release its reader or shutdown gate before the
// admitted query finishes. Another reader must remain usable in the meantime.
async fn cancelled_reader_joins_on_close(app: AppApplication) {
    let app = Arc::new(app);
    let storage = app.storage.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let query = tokio::spawn(async move {
        storage
            .read(move |db| {
                started.send(()).unwrap();
                blocked.recv().unwrap();
                assert_eq!(
                    db.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    query.abort();
    assert!(query.await.unwrap_err().is_cancelled());
    assert_eq!(
        app.storage
            .read(|db| {
                db.query_row(
                    "SELECT COUNT(*) FROM app_terminal_turn_projections",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(AppStorageError::sqlite)
            })
            .await
            .unwrap(),
        1
    );
    let (started, ready) = tokio::sync::oneshot::channel();
    let closing = tokio::spawn(async move {
        started.send(()).unwrap();
        app.close().await
    });
    ready.await.unwrap();
    assert!(
        !closing.is_finished(),
        "close must wait for the cancelled query"
    );
    release.send(()).unwrap();
    closing.await.unwrap().unwrap();
}
