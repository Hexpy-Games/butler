//! Deterministic notification-saturation portion of the existing projection race scenario.
use super::super::*;
use super::support::{Native, command};
use serde_json::json;
use std::{path::Path, sync::Arc, time::Duration};

pub(super) async fn assert_burst_projects_other_chat(
    app: &AppApplication,
    native: &Arc<Native>,
    root: &Path,
) {
    let b = app
        .create_session(
            AppCreateSessionInput {
                kind: AppChatKind::Chat,
                title: Some("Burst B".into()),
                project_id: None,
                session_hint: Some("burst-b".into()),
            },
            false,
        )
        .await
        .unwrap();
    let mut request = command("burst-b-client", "question");
    request.chat_id = b.id.clone();
    request.request.chat_id = Some(json!(b.id));
    let turn = super::projection_tests::dispatched_turn(app, native, request)
        .await
        .id;
    let claim = native
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|turn| turn.chat_id == b.id)
        .unwrap()
        .app_queue_claim_id
        .clone();
    let file = format!("{}.jsonl", b.session_hint.replace('/', "_"));
    for overflow in [false, true] {
        let release = app.projection.pause_for_burst().await;
        let action = if overflow {
            "burst-overflow"
        } else {
            "burst-duplicate"
        };
        append_progress(
            root,
            &file,
            &b.session_hint,
            action,
            &turn,
            claim.as_deref(),
        );
        for n in 0..65 {
            let a = if overflow {
                format!("butler_app-unused-{n}.jsonl")
            } else {
                "butler_app-general.jsonl".to_owned()
            };
            app.projection.transcript_event(a);
        }
        app.projection.transcript_event(file.clone());
        release.send(()).unwrap();
        wait_receipt(app, action).await;
    }
    let page = app.list_messages(b.id, 0.0, 200).await.unwrap();
    let rows = &page.turn_progress.unwrap()[&turn].safe_progress_rows;
    assert!(
        rows.iter()
            .any(|row| row["safe_label"] == "Burst B projected")
    );
}

fn append_progress(
    root: &Path,
    file: &str,
    session: &str,
    action: &str,
    turn: &str,
    claim: Option<&str>,
) {
    use std::io::Write;
    let outbound = json!({"eventId":action,"sessionId":session,"kind":"outbound","transport":"app",
        "timestamp":"2026-09-14T00:00:01.000Z","payload":{"actionId":action,
        "message":{},"metadata":{"kind":"tool_progress","turnId":turn,
        "appQueueClaimId":claim,"activityKind":"used_tool","state":"running",
        "safeLabel":"Burst B projected","toolName":"read_file","toolCallId":action}}});
    let delivery = json!({"eventId":format!("{action}-delivery"),"sessionId":session,"kind":"delivery","transport":"app",
        "timestamp":"2026-09-14T00:00:02.000Z","payload":{"actionId":action,"ok":true}});
    let mut output = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("transcripts").join(file))
        .unwrap();
    writeln!(
        output,
        "{outbound}
{delivery}"
    )
    .unwrap();
}

async fn wait_receipt(app: &AppApplication, action: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let id = action.to_owned();
            let found = app.storage.execute(move |db| {
                db.query_row("SELECT EXISTS(SELECT 1 FROM app_transport_projection_receipts WHERE action_id=?1)",
                    [id], |row| row.get::<_, bool>(0)).map_err(AppStorageError::sqlite)
            }).await.unwrap();
            if found { break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("B must project without another FS event, explicit refresh, or restart");
}
