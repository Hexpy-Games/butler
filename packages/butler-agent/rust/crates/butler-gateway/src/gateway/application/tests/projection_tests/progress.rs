use super::*;

// test-category: format-pin
#[tokio::test]
async fn progress_receipts_and_terminal_message_projection_contracts() {
    projection::assert_terminal_projection_contracts().await;
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let root = projection_root("non-final-progress");
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
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
    let retained_turn = turn.clone();
    app.storage.execute(|db| {
        let receipt:i64=db.query_row("SELECT COUNT(*) FROM app_transport_projection_receipts WHERE action_id IN ('action-progress','Action-Runtime','Action-Continuation')",[],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let staged:i64=db.query_row("SELECT COUNT(*) FROM app_transport_projection_staged_outbounds WHERE action_id='action-progress'",[],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let runtime:String=db.query_row("SELECT payload_json FROM events WHERE type='agent.turn_event' AND json_extract(payload_json,'$.event.id')='Event-MixedCase'",[],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let runtime:serde_json::Value=serde_json::from_str(&runtime).unwrap();
        assert_eq!(runtime["event"]["payload"]["sequence"],2);
        assert_eq!(runtime["event"]["payload"]["argumentCharCount"],4);
        let hidden:i64=db.query_row("SELECT COUNT(*) FROM app_internal_continuation_progress_events WHERE turn_id=?1",[retained_turn],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        assert_eq!(hidden,1);
        assert_eq!((receipt,staged),(3,0)); Ok(())
    }).await.unwrap();
    let empty_turn = turn.clone();
    app.storage.execute(move |db| {
        db.execute("INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) VALUES('empty-question','general',?1,'assistant','','streaming','now','now')", [&empty_turn]).map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    let outbound = json!({"eventId":"outbound-empty","sessionId":"butler/app-general","kind":"outbound",
        "timestamp":"2026-09-14T00:00:07.000Z","transport":"app",
        "payload":{"actionId":"action-empty","message":{"text":""},"metadata":{
            "kind":"final_result","turnId":turn,"appQueueClaimId":claim,"noVisibleReply":true}}});
    let delivery = json!({"eventId":"delivery-empty","sessionId":"butler/app-general","kind":"delivery",
        "timestamp":"2026-09-14T00:00:08.000Z","transport":"app","payload":{"actionId":"action-empty","ok":true}});
    use std::io::Write;
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(root.join("transcripts/butler_app-general.jsonl"))
            .unwrap(),
        "{outbound}\n{delivery}"
    )
    .unwrap();
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    app.storage.execute(move |db| {
        let failed: i64 = db.query_row("SELECT COUNT(*) FROM events WHERE turn_id=?1 AND (type='turn.failed' OR (type='agent.turn_event' AND json_extract(payload_json,'$.event.kind')='turn.failed'))", [&turn], |r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let changed: i64 = db.query_row("SELECT COUNT(*) FROM events WHERE turn_id=?1 AND type='turn.state_changed' AND (json_extract(payload_json,'$.state')='failed' OR json_extract(payload_json,'$.turn.state')='failed')", [&turn], |r|r.get(0)).map_err(AppStorageError::sqlite)?;
        assert_eq!((failed, changed), (1, 1));
        Ok(())
    }).await.unwrap();
    let messages = app
        .list_messages("general".into(), 0.0, 200)
        .await
        .unwrap()
        .messages;
    assert!(
        !messages.iter().any(|m| m.id == "empty-question"),
        "{messages:?}"
    );
    assert!(
        messages.iter().any(
            |m| m.safe_error_code.as_deref() == Some("no_visible_result") && !m.text.is_empty()
        ),
        "{messages:?}"
    );
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
