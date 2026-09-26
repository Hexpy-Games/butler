
use rusqlite::Connection;

use super::*;

#[test]
fn retry_attachment_reuse_requires_the_exact_user_message_in_the_same_chat() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
            "CREATE TABLE chats(id TEXT PRIMARY KEY,project_id TEXT,archived INTEGER);
             CREATE TABLE app_session_context_gate(session_id TEXT,owner_kind TEXT);
             CREATE TABLE session_queued_messages(
                 chat_id TEXT,client_message_id TEXT,input_identity_digest TEXT,
                 control_resolution_json TEXT,attachments_json TEXT
             );
             CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT,role TEXT);
             CREATE TABLE message_files(
                 id TEXT PRIMARY KEY,owner_session_id TEXT,message_id TEXT,kind TEXT,
                 mime_type TEXT,safe_name TEXT,size_bytes INTEGER,sha256 TEXT,
                 storage_name TEXT,created_at TEXT
             );
             CREATE TABLE message_attachments(message_id TEXT,file_id TEXT,position INTEGER);
             INSERT INTO chats VALUES('general',NULL,0),('other',NULL,0);
             INSERT INTO messages VALUES
                 ('source-user','general','user'),
                 ('other-user','general','user'),
                 ('foreign-user','other','user');
             INSERT INTO message_files VALUES
                 ('source-file','general','source-user','generic','text/plain','source.txt',4,'hash-a','source','now'),
                 ('foreign-file','general','foreign-user','generic','text/plain','foreign.txt',4,'hash-b','foreign','now');
             INSERT INTO message_attachments VALUES
                 ('source-user','source-file',0),
                 ('foreign-user','foreign-file',0);",
        )
        .unwrap();

    let default_error = inspect(&db, "general", "new-default", &request("source-file"))
        .err()
        .unwrap();
    assert_eq!(default_error.code(), "message_file_already_attached");

    let accepted = inspect_with_attachment_source(
        &db,
        "general",
        "new-retry",
        &request("source-file"),
        Some("source-user"),
    )
    .unwrap();
    assert_eq!(accepted.files[0].id, "source-file");

    let wrong_message = inspect_with_attachment_source(
        &db,
        "general",
        "new-unrelated",
        &request("source-file"),
        Some("other-user"),
    )
    .err()
    .unwrap();
    assert_eq!(wrong_message.code(), "message_file_already_attached");

    let wrong_chat = inspect_with_attachment_source(
        &db,
        "general",
        "new-foreign",
        &request("foreign-file"),
        Some("foreign-user"),
    )
    .err()
    .unwrap();
    assert_eq!(wrong_chat.code(), "message_file_already_attached");
}

fn request(file_id: &str) -> MessageSendRequest {
    MessageSendRequest {
        expected_project_id: None,
        content_parts: None,
        chat_id: Some(json!("general")),
        text: Some(json!("retry this")),
        client_message_id: None,
        attachments: Some(json!([{"file_id":file_id}])),
        model: None,
        reasoning_effort: None,
        access_mode: None,
        plan_mode: None,
        subsession_result: None,
    }
}
