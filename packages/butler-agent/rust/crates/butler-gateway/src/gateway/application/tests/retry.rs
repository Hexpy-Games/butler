use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;

#[tokio::test]
async fn retry_reuses_the_same_turn_attempt_controls_and_user_message() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let path = temp_path("retry-same-turn");
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path.clone(),
            butler_data: path.parent().unwrap().into(),
            project_workspace_root: path.parent().unwrap().into(),
            folder_selection_secret: None,
        },
        dependencies(native.clone(), 800),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let accepted = app
        .send_message(command("retry-original", "retry this"))
        .await
        .unwrap();
    let original = accepted.turn.unwrap();
    let turn_id = original.id.clone();
    app.storage
        .execute({
            let turn = turn_id.clone();
            move |db| {
                db.execute(
                    "UPDATE turns SET state='runtime_fault',safe_status_label='Runtime fault',\
                     safe_error_code='runtime_fault',retryable=1,cancellable=0 WHERE id=?1",
                    [&turn],
                )
                .map_err(AppStorageError::sqlite)?;
                db.execute(
                    "UPDATE session_queued_messages SET state='failed',safe_error_code='runtime_fault',\
                     claim_id=NULL,claim_owner=NULL,claimed_at=NULL,lease_expires_at=NULL WHERE turn_id=?1",
                    [&turn],
                )
                .map_err(AppStorageError::sqlite)?;
                db.execute(
                    "INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,\
                     safe_error_code,retryable) VALUES('assistant-failure','general',?1,'assistant',\
                     'Runtime interrupted','failed','now','now','runtime_fault',1)",
                    [&turn],
                )
                .map_err(AppStorageError::sqlite)?;
                let fault = json!({
                    "session_id":"general",
                    "turn_id":turn.clone(),
                    "event":{"id":"fault-event","kind":"runtime.fault",
                        "payload":{"faultId":"fault-1","kind":"provider_error",
                            "publicSummary":"Runtime interrupted","retryable":true}}
                });
                db.execute(
                    "INSERT INTO events(type,turn_id,payload_json,created_at) VALUES(\
                     'agent.turn_event',?1,?2,'now')",
                    rusqlite::params![turn, fault.to_string()],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            }
        })
        .await
        .unwrap();

    let result = app.retry_turn_owned(turn_id.clone()).await.unwrap();
    assert_eq!(result["turn"]["id"], turn_id);
    assert_eq!(result["turn"]["attempt"], 2);
    assert_eq!(result["turn"]["state"], "retrying");
    assert_eq!(
        result["turn"]["execution_controls"],
        serde_json::to_value(original.execution_controls).unwrap()
    );
    assert_eq!(result["next_cursor"], result["turn"]["cursor"]);

    {
        let sent = native.0.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1].turn_id, turn_id);
        assert_eq!(sent[1].turn_attempt, 2);
        assert_eq!(sent[1].text, "retry this");
    }

    let db_facts = app
        .storage
        .execute({
            let turn = turn_id.clone();
            move |db| {
                let assistants: i64 = db
                    .query_row(
                        "SELECT COUNT(*) FROM messages WHERE turn_id=?1 AND role='assistant'",
                        [&turn],
                        |row| row.get(0),
                    )
                    .map_err(AppStorageError::sqlite)?;
                let user_message_id: String = db
                    .query_row(
                        "SELECT user_message_id FROM turns WHERE id=?1",
                        [&turn],
                        |row| row.get(0),
                    )
                    .map_err(AppStorageError::sqlite)?;
                let state_event: String = db
                    .query_row(
                        "SELECT payload_json FROM events WHERE type='turn.state_changed' AND turn_id=?1\
                     ORDER BY id DESC LIMIT 1",
                        [&turn],
                        |row| row.get(0),
                    )
                    .map_err(AppStorageError::sqlite)?;
                Ok((assistants, user_message_id, state_event))
            }
        })
        .await
        .unwrap();
    assert_eq!(db_facts.0, 0);
    assert_eq!(db_facts.1, original.user_message_id.unwrap());
    let event: Value = serde_json::from_str(&db_facts.2).unwrap();
    assert_eq!(event["turn"]["retryable"], false);

    app.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}
