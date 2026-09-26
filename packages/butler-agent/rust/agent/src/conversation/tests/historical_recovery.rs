use std::fs;

use rusqlite::Connection;
use serde_json::json;

use super::{open_at, test_path};
use crate::conversation::historical_recovery::{
    HistoricalAppProjectionRow, HistoricalRecoveryInput, HistoricalTranscriptRow,
    historical_source_ref, plan_historical_recovery, read_historical_app_rows,
    read_historical_transcript_rows,
};
use crate::conversation::{
    AppendMessageInput, BeginTurnInput, ConversationOriginKind, ConversationProvenance,
    ConversationRole, ConversationSourceReader, ConversationStatus, ConversationVisibility,
    FinalizeTurnInput,
};

fn parse_timestamp(value: &str) -> Option<i64> {
    crate::js_date::parse_date_millis(value, &Some)
}

fn transcript(event_id: &str, session_id: &str, text: &str) -> HistoricalTranscriptRow {
    HistoricalTranscriptRow {
        event_id: event_id.into(),
        session_id: session_id.into(),
        kind: "inbound".into(),
        timestamp: "2026-07-02T00:00:00.000Z".into(),
        transport: None,
        payload: Some(
            json!({"message":{"text":text}})
                .as_object()
                .unwrap()
                .clone(),
        ),
    }
}

fn recovery_input(
    transcript_rows: Vec<HistoricalTranscriptRow>,
    app_rows: Vec<HistoricalAppProjectionRow>,
    dry_run: bool,
) -> HistoricalRecoveryInput {
    HistoricalRecoveryInput {
        transcript_rows,
        app_rows,
        dry_run,
    }
}

#[test]
fn transcript_reader_keeps_malformed_lines_redacted_in_dry_run() {
    let path = test_path("historical-transcript");
    let raw = format!(
        "{}\n{{\"secret\":\"MALFORMED_PRIVATE_TEXT\",}}\n",
        json!({"eventId":"evt-1","sessionId":"legacy/session","kind":"inbound","timestamp":"2026-07-02T00:00:00.000Z","payload":{"message":{"text":"PRIVATE_TRANSCRIPT_TEXT"}}})
    );
    fs::write(&path, &raw).unwrap();
    let rows = read_historical_transcript_rows(&path).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].event_id, "malformed-line-2");
    assert_eq!(rows[1].kind, "malformed_json");
    let report = plan_historical_recovery(
        None,
        &parse_timestamp,
        &recovery_input(rows, Vec::new(), true),
    )
    .unwrap();
    assert_eq!(report["counts"]["recovered"], 1);
    assert_eq!(report["counts"]["ambiguous"], 1);
    assert_eq!(report["mappings"][0]["status"], "planned");
    assert_eq!(report["privacy"]["rawTextIncluded"], false);
    let rendered = report.to_string();
    assert!(!rendered.contains("PRIVATE_TRANSCRIPT_TEXT"));
    assert!(!rendered.contains("MALFORMED_PRIVATE_TEXT"));
    assert!(!rendered.contains("evt-1"));
    assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    let _ = fs::remove_file(path);
}

#[test]
fn app_projection_reader_handles_optional_canonical_columns() {
    let path = test_path("historical-app");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "CREATE TABLE messages(id TEXT,chat_id TEXT,role TEXT,text TEXT,created_at TEXT);\
         INSERT INTO messages VALUES('legacy-1','general','user','hello','2026-07-02T00:00:00.000Z');",
    ).unwrap();
    drop(connection);
    let legacy = read_historical_app_rows(&path).unwrap();
    assert_eq!(legacy.len(), 1);
    assert_eq!(legacy[0].id, "legacy-1");
    assert_eq!(legacy[0].conversation_session_id, None);
    let _ = fs::remove_file(&path);

    let canonical_path = test_path("historical-app-canonical");
    let connection = Connection::open(&canonical_path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE messages(id TEXT,chat_id TEXT,role TEXT,text TEXT,created_at TEXT,\
         conversation_session_id TEXT,conversation_turn_id TEXT,conversation_message_id TEXT);\
         INSERT INTO messages VALUES('canonical-1','chat-1','assistant','answer',\
         '2026-07-02T00:00:00.000Z','cs-1','ct-1','cm-1');",
        )
        .unwrap();
    drop(connection);
    let canonical = read_historical_app_rows(&canonical_path).unwrap();
    assert_eq!(
        canonical[0].conversation_session_id.as_deref(),
        Some("cs-1")
    );
    assert_eq!(canonical[0].conversation_turn_id.as_deref(), Some("ct-1"));
    assert_eq!(
        canonical[0].conversation_message_id.as_deref(),
        Some("cm-1")
    );
    let _ = fs::remove_file(canonical_path);
}

#[tokio::test]
async fn recovery_import_is_atomic_idempotent_and_deduplicates_across_sessions() {
    let path = test_path("historical-import");
    let (store, _, _) = open_at(path.clone()).await;
    store
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "existing-runtime".into(),
            session_id: Some("cs_existing".into()),
            workspace_id: None,
            project_id: None,
            actor: "user".into(),
            request_id: Some("old".into()),
            turn_id: Some("ct_existing".into()),
            now: Some("2026-07-01T00:00:00.000Z".into()),
        })
        .await
        .unwrap();
    let collision_ref = historical_source_ref("transcript", "legacy/session", "shared-event");
    store
        .append_user_message(AppendMessageInput {
            session_id: "cs_existing".into(),
            turn_id: Some("ct_existing".into()),
            text: "already canonical".into(),
            message_id: Some("cm_existing".into()),
            role: ConversationRole::User,
            status: Some(ConversationStatus::Complete),
            visibility: Some(ConversationVisibility::Model),
            provenance: Some(ConversationProvenance::Recovered),
            source_gateway: Some("transcript-recovery".into()),
            source_ref: Some(collision_ref.clone()),
            origin_kind: Some(ConversationOriginKind::Unknown),
            origin_ref: None,
            origin_reason: None,
            origin_version: None,
            origin_evidence: None,
            now: Some("2026-07-01T00:00:00.000Z".into()),
            parts: None,
        })
        .await
        .unwrap();
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "ct_existing".into(),
            status: Some("complete".into()),
            completed_at: Some("2026-07-01T00:00:00.000Z".into()),
            outcome_capsule: None,
        })
        .await
        .unwrap();

    let rows = vec![
        transcript("shared-event", "legacy/session", "must not duplicate"),
        transcript("fresh-event", "legacy/session", "RECOVERED_CANONICAL_TEXT"),
    ];
    let first = store
        .run_historical_recovery(
            recovery_input(rows.clone(), Vec::new(), false),
            &parse_timestamp,
        )
        .await
        .unwrap();
    assert_eq!(first["counts"]["imported"], 1);
    assert_eq!(first["counts"]["skipped_existing"], 1);
    assert_eq!(first["mappings"][0]["status"], "existing");
    let rendered = first.to_string();
    assert!(!rendered.contains("RECOVERED_CANONICAL_TEXT"));
    assert!(!rendered.contains("fresh-event"));

    let repeated = store
        .run_historical_recovery(recovery_input(rows, Vec::new(), false), &parse_timestamp)
        .await
        .unwrap();
    assert_eq!(repeated["counts"]["imported"], 0);
    assert_eq!(repeated["counts"]["skipped_existing"], 2);
    assert_eq!(repeated["mappings"][0]["status"], "existing");
    let reader = ConversationSourceReader::open(&path).unwrap();
    let planned = plan_historical_recovery(
        Some(&reader),
        &parse_timestamp,
        &recovery_input(
            vec![
                transcript("shared-event", "legacy/session", "must not duplicate"),
                transcript("fresh-event", "legacy/session", "RECOVERED_CANONICAL_TEXT"),
            ],
            Vec::new(),
            true,
        ),
    )
    .unwrap();
    assert_eq!(planned["counts"]["skipped_existing"], 2);
    reader.close().unwrap();

    let fresh_ref = historical_source_ref("transcript", "legacy/session", "fresh-event");
    let canonical_reader = ConversationSourceReader::open(&path).unwrap();
    let fresh = canonical_reader
        .read_message_by_source_ref_any_session(&fresh_ref)
        .unwrap()
        .unwrap();
    assert_eq!(fresh.message.role, ConversationRole::User);
    assert_eq!(fresh.message.provenance, ConversationProvenance::Recovered);
    assert_eq!(
        fresh.parts[0].content_json["text"],
        "RECOVERED_CANONICAL_TEXT"
    );
    assert_eq!(
        canonical_reader
            .read_message_by_source_ref_any_session(&collision_ref)
            .unwrap()
            .unwrap()
            .message
            .id,
        "cm_existing"
    );
    canonical_reader.close().unwrap();
    store.close().await.unwrap();
    let _ = fs::remove_file(path);
}
